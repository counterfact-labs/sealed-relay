import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm, lstat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

const { checkedFile, runCommand, verifySourceInventory, main } = await import(new URL("./reproduce.mjs", import.meta.url).href);
const helloSha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

test("the publication roots are exactly the build owners called by the reproduction driver", async () => {
  const driver = await readFile(new URL("./reproduce-driver.ts", import.meta.url), "utf8");
  const owners = JSON.parse(await readFile(new URL("./build-owners.json", import.meta.url), "utf8"));
  const imports = [...driver.matchAll(/\bfrom "([^"]+)"/g)].map(match => match[1]).filter(path => path.startsWith("."))
    .map(path => posix.normalize(posix.join("scripts/relay/public", path)));
  assert.deepEqual([...new Set(imports)].sort(), [...owners].sort());
});

async function fixture(run: (folder: string) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), "relay-public-reproduce-"));
  try { await run(folder); }
  finally { await rm(folder, { recursive: true, force: true }); }
}

test("accepts original bytes and refuses changed bytes or nonregular inputs", async () => {
  await fixture(async folder => {
    const path = join(folder, "input");
    await writeFile(path, "hello");
    assert.equal((await checkedFile(path, helloSha256)).toString(), "hello");
    await writeFile(path, "jello");
    await assert.rejects(checkedFile(path, helloSha256), /hash differs/);
    await assert.rejects(checkedFile(folder, helloSha256), /regular file/);
    await symlink(path, join(folder, "link"));
    await assert.rejects(checkedFile(join(folder, "link"), helloSha256), /regular file/);
  });
});

test("checks the complete inventory and refuses additional files, symlinks, or changed bytes", async () => {
  await fixture(async folder => {
    await writeFile(join(folder, "input"), "hello");
    await writeFile(join(folder, "SHA256SUMS"), `${helloSha256}  input\n`);
    await verifySourceInventory(folder);
    await writeFile(join(folder, "extra"), "extra");
    await assert.rejects(verifySourceInventory(folder), /inventory differs/);
    await rm(join(folder, "extra"));
    await mkdir(join(folder, "source/node_modules"), { recursive: true });
    await writeFile(join(folder, "source/node_modules/installed"), "dependency");
    await assert.rejects(verifySourceInventory(folder), /inventory differs/);
    await rm(join(folder, "source"), { recursive: true });
    await symlink(join(folder, "input"), join(folder, "extra"));
    await assert.rejects(verifySourceInventory(folder), /regular files/);
    await rm(join(folder, "extra"));
    await writeFile(join(folder, "input"), "jello");
    await assert.rejects(verifySourceInventory(folder), /hash differs/);
  });
});

test("refuses ambiguous inventory names and duplicate entries", async () => {
  await fixture(async folder => {
    for (const names of [["../input"], ["/input"], ["a//input"], ["./input"], ["SHA256SUMS"], ["input", "input"]]) {
      await writeFile(join(folder, "SHA256SUMS"), names.map(name => `${helloSha256}  ${name}\n`).join(""));
      await assert.rejects(verifySourceInventory(folder), /Invalid source inventory/);
    }
  });
});

test("missing release metadata stops before installing dependencies or creating output", async () => {
  await fixture(async folder => {
    const record = JSON.stringify({ schemaVersion: 1, relayVersion: "1.0.1", runtimeSha256: helloSha256, image: null });
    await writeFile(join(folder, "reproduction.json"), record);
    await writeFile(join(folder, "SHA256SUMS"), `${createHash("sha256").update(record).digest("hex")}  reproduction.json\n`);
    const output = join(tmpdir(), `${folder.split("/").at(-1)}-output`);
    await assert.rejects(main([folder, output], folder), /release image digest.*pending/);
    await assert.rejects(lstat(output), { code: "ENOENT" });
    await assert.rejects(main(["--runtime-only", join(folder, "output")], folder), /outside this snapshot/);
    await assert.rejects(main(["--runtime-only", `${output},bad`], folder), /without commas/);
  });
});

test("missing encrypted inputs stop before installing dependencies or creating output", async () => {
  await fixture(async folder => {
    const record = JSON.stringify({ schemaVersion: 1, relayVersion: "1.0.1", runtimeSha256: helloSha256,
      image: { payloadSha256: { "opt/counterfact/bundle/sealed.json": helloSha256,
        "opt/counterfact/relay/model-credential.enc": helloSha256 } } });
    await writeFile(join(folder, "reproduction.json"), record);
    await writeFile(join(folder, "SHA256SUMS"), `${createHash("sha256").update(record).digest("hex")}  reproduction.json\n`);
    const output = join(tmpdir(), `${folder.split("/").at(-1)}-output`);
    await assert.rejects(main([folder, output], folder), /Exact release sealed.json and model-credential.enc/);
    await assert.rejects(lstat(output), { code: "ENOENT" });
  });
});

test("a failed command identifies its directory and diagnostic rerun without echoing stderr", () => {
  assert.throws(() => runCommand(process.execPath,
    ["-e", "process.stderr.write(['local', 'detail'].join('-')); process.exit(1)"], tmpdir(), process.env), (error: Error) => {
    assert.match(error.message, /Command failed:/);
    assert.ok(error.message.includes(process.execPath));
    assert.ok(error.message.includes(`Working directory: ${tmpdir()}`));
    assert.match(error.message, /Rerun the command there for diagnostics/);
    assert.ok(!error.message.includes("local-detail"));
    return true;
  });
});
