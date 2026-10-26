# Counterfact relay 1.0.1 source

This folder contains the files needed to rebuild the relay's JavaScript program
and container image. `source/` keeps the original paths and bytes of the running
program's imports and the build functions used by `tools/reproduce.mjs`.
`SHA256SUMS` lists every published file except itself.

`source/package.json` and `source/packages/core/package.json` are trimmed copies.
They keep the package identity and dependency data needed by the unchanged
lockfile, plus the root workspace map. Private module exports and development
scripts are omitted because they are not needed to reproduce the relay and
would reveal names from the private analysis code. The reproduce tool uses no
package scripts.

The tool versions in `reproduction.json` come from pinned release settings,
not from the machine that publishes this folder.

The analysis instructions and analysis method are absent. The relay receives
encrypted instructions separately when it runs. No customer files or provider
credentials are needed to rebuild the JavaScript.

From this folder, using the Node and npm versions in `reproduction.json`, run:

```bash
node --test tools/reproduce.test.ts
node tools/reproduce.mjs --runtime-only /tmp/relay-1.0.1-runtime-check
```

Choose a new output directory outside this folder. The command installs the
locked dependencies with install scripts disabled, builds twice in separate
folders, and checks both JavaScript hashes against `reproduction.json`.

**Release image digest: PENDING FOR 1.0.1.** `reproduction.json` has `image: null`
until the release's image digest, encrypted input hashes, build settings, and
public signing key are reviewed. No earlier release digest applies to 1.0.1.
The complete image command refuses to build while these values are pending.
See [VERIFY.md](VERIFY.md) for the image inputs and verification steps.

Rebuilding identifies the public program and encrypted inputs in an image.
Checking a running relay also requires the CLI's fresh attestation, which binds
the connection to the expected image. Rebuilding alone does not prove provider
retention or model output quality.

See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md) for licensing and attribution.
