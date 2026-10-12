# Selfsync Cloud

Obsidian plugin for Selfsync Cloud, a hosted version of [selfsync](https://github.com/Darkildo/selfsync). It syncs your vault with no lost edits: automatic merges, conflict copies, deleted file recovery and file history. End-to-end encryption is always on.

> **Status:** in development. The service is not open yet, and the plugin is not in the Obsidian community directory.

If you would rather run the server yourself, use the open [selfsync](https://github.com/Darkildo/selfsync) plugin instead; it needs no account.

## Disclosures

- **Account required.** You sign up with an email and a password inside the plugin.
- **Paid plans.** There is a free plan; larger plans will be paid. Plans that are not available yet are shown greyed out.
- **Network use.** The plugin talks only to the Selfsync Cloud servers in the region you pick at sign-up. Notes, file names and folder names are encrypted on your device before they leave it; the service cannot read them.
- **No telemetry.** The plugin collects no analytics. The server keeps what sync needs (account email, device names, encrypted data sizes and times).
- **Lost password and recovery phrase mean lost data.** The service holds no key to your notes, so support cannot restore access.

## Source and audit

The sync engine is not copied into this repository. It is the open selfsync project, pinned as the `core/` submodule to a released tag; CI refuses to build from anything else. This repository adds only the cloud screens: sign-up and sign-in, plans and device invites.

To check a release, compare the `core/` commit with the selfsync tag of the same name, then build:

```sh
git clone --recurse-submodules https://github.com/Darkildo/selfsync-cloud
cd selfsync-cloud
core/scripts/build-wasm.sh   # needs Rust (version from core/rust-toolchain.toml), wasm-bindgen-cli, binaryen
npm ci && npm run build      # main.js
npm test
```

The end-to-end test runs against the Selfsync Cloud server when `SELFSYNC_CLOUD_BIN` points to its binary; without it, the test is skipped. It checks that no request body ever carries a note or a file name in clear text.

## License

[PolyForm Shield 1.0.0](LICENSE): you may read, run, change and share this code for any purpose except building a product that competes with Selfsync Cloud. The `core/` submodule is selfsync under the MIT license.
