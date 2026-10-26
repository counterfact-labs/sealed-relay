# Verify the relay 1.0.1 source

Run these commands from the root of the published folder. Authenticate its public
commit and release mapping separately. The file inventory detects changes from
that reviewed folder; the inventory alone does not authenticate its publisher.

## Rebuild the JavaScript

Use the exact Node, npm, and esbuild versions recorded in `reproduction.json`.
These versions come from pinned release settings, not the publishing machine.
esbuild and the other build dependencies come from the retained lockfile.
The command needs access only to the lockfile's integrity-checked npm tarballs,
or a populated npm cache. It runs no install scripts.

`source/package.json` and `source/packages/core/package.json` are trimmed copies,
so their bytes differ from the original manifests. They retain package identity
and the dependency data needed for the unchanged lockfile; the root also keeps
its workspace map. Private module exports and development scripts are removed
to keep private analysis names out of this folder. The reproduce tool uses no
package scripts. The published hashes cover these trimmed copies.

```bash
sha256sum --strict -c SHA256SUMS
node --test tools/reproduce.test.ts
node tools/reproduce.mjs --runtime-only /tmp/relay-1.0.1-runtime-check
```

Use a new output directory outside this folder, without commas or line breaks.
Keep the published folder unchanged. Do not install dependencies into `source/`:
the verifier refuses any extra files and makes its own two independent source
copies before running `npm ci --ignore-scripts --no-audit --no-fund` in each.
It invokes the retained `bundleRuntime` owner and checks both `runtime.mjs` files
against `reproduction.json.runtimeSha256`. `verification.json` records the two
measured hashes and input counts. This check needs neither Docker nor encrypted
release inputs.

## Rebuild the complete image

**Release image digest: PENDING FOR 1.0.1.** No digest or encrypted input from an
earlier release is claimed for this release. The published metadata uses
`image: null` until the release values are available. The complete image command
refuses to install dependencies or create output while this field is null.

Release preparation must fill `reproduction.json.image` with these reviewed facts:

| Field | Meaning |
| --- | --- |
| `config` | The original release build settings, including the source timestamp, pinned container tools, base image, Dockerfile frontend, and native compiler directory and hashes |
| `baseDiffIds` | The ordered hashes of the unpacked base-image layers |
| `payloadSha256` | The hashes of the runtime, native launcher, public key, and encrypted files at their image paths |
| `modelCredentialSha256` | The hash of the decoded encrypted credential bytes |
| `contextSha256` | The original staged build-directory hash |
| `digest` | The released OCI image manifest digest |
| `publicKey` | The release's public signing key in PEM form |

The target digest identifies the OCI image manifest, which describes the image's
configuration and layers. It is distinct from the tar archive's hash and any
mutable container tag. Review the release mapping before trusting these values.

Install the exact Docker, Buildx, BuildKit, and native compiler versions from
`image.config`. The native compiler's full directory must match its reviewed
hash at its configured absolute path. Cache the pinned base image and Dockerfile
frontend before disconnecting the builder. Build steps use `--network=none`,
`--pull=false`, `--no-cache`, `--provenance=false`, and `--sbom=false`. A complete
build does not call cloud services, push an image, or run it.

Put the exact release ciphertext in a separate directory as `sealed.json` and
`model-credential.enc`. The credential file contains base64 ciphertext and a
trailing newline. Its file hash differs from the decoded ciphertext hash.
Both file hashes are checked against `image.payloadSha256` before installing
dependencies. A public location for these exact 1.0.1 inputs is **PENDING**.
Hashes alone cannot replace the input bytes.

Once the metadata, tools, and encrypted inputs are available, run:

```bash
node tools/reproduce.mjs /tmp/relay-1.0.1-inputs /tmp/relay-1.0.1-image-check
```

The command uses the retained compiler checks, native-launcher compiler, image
staging, container builder, and image inspection functions. It builds twice,
checks the native launcher and staged files against the release hashes, and
checks the manifest digest and timestamp. `verification.json` records both
results. Archive transport bytes may differ while the image manifest matches.

Building needs no decryption key, model API key, cloud account, release-signing
private key, or customer files. Running the production relay requires its
separately managed workload permissions. Publishing encrypted bytes does not
grant permission to decrypt them. Reproduction does not prove those permissions
or establish the identity of a currently running relay.
