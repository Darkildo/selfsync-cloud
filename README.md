# Selfsync Cloud

Obsidian plugin for Selfsync Cloud, a hosted version of [selfsync](https://github.com/Darkildo/selfsync). It syncs your vault with no lost edits: automatic merges, conflict copies, deleted file recovery and file history. End-to-end encryption is always on.

> **Status:** early release. The plugin is published on GitHub Releases and is not in the Obsidian community directory yet. All accounts are on the free plan.

If you would rather run the server yourself, use the open [selfsync](https://github.com/Darkildo/selfsync) plugin instead; it needs no account.

## Installation

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/Darkildo/selfsync-cloud/releases/latest).
2. Put them into `<your vault>/.obsidian/plugins/selfsync-cloud/`.
3. In Obsidian, open *Settings → Community plugins*, turn off restricted mode if needed and enable **Selfsync Cloud**.

Works on desktop and mobile, Obsidian 1.8.7 or newer. Do not enable it together with the open selfsync plugin in the same vault.

## Usage

**First device.** Open *Settings → Selfsync Cloud* and press **Sign up**. Pick a region (CIS or Europe), enter an email and a password. You get a 24-word recovery phrase: write it down, it is the only way back in if you forget the password. Then press **Choose a vault** and create one; the plugin encrypts the vault and uploads it.

**More devices.** On a connected device press **Invite a device**. Either scan the QR code with the new device (it opens Obsidian and connects at once), or type the short code on the new device under **I have an invite code** and then enter the account password. Codes work once and expire after 10 minutes. You can also simply sign in on the new device and pick the vault.

**Day to day.** Sync runs by itself. Conflicting edits are merged or kept as conflict copies; deleted files and older versions are in the file history and the trash, as in selfsync. The settings show your storage use, your devices (any of them can be revoked) and the plans. You can change the password, sign out or delete the account with all its data there too.

## Disclosures

- **Account required.** You sign up with an email and a password inside the plugin.
- **Paid plans.** There is a free plan; larger plans will be paid. Plans that are not available yet are shown greyed out.
- **Network use.** The plugin talks only to the Selfsync Cloud servers in the region you pick at sign-up: CIS or Europe. Notes, file names and folder names are encrypted on your device before they leave it; the service cannot read them.
- **No telemetry.** The plugin collects no analytics. The server keeps what sync needs (account email, device names, encrypted data sizes and times).
- **Files outside the vault API.** On desktop the sync engine uses Node's `fs` module, only inside your vault folder and the plugin's own folder: to replace files atomically (so a crash never leaves a half-written note) and to read large files in parts. On mobile it uses the Obsidian vault API only.
- **Clipboard.** The plugin writes to the clipboard only when you press a copy button (recovery phrase, invite code, connect link, sync log). It never reads the clipboard.
- **Lost password and recovery phrase mean lost data.** The service holds no key to your notes, so support cannot restore access.

## Source and audit

This repository adds only the cloud screens: sign-up and sign-in, plans and device invites. The sync engine is the open selfsync project at a released tag, kept in `core/`: its plugin sources and styles, its MIT license and the engine compiled to WebAssembly. `core/SOURCE` names the tag and commit. CI rebuilds `core/` from that tag with `scripts/core.sh check` and fails unless the result is byte-identical, so `core/` cannot drift from the published selfsync.

Building the plugin needs only Node:

```sh
git clone https://github.com/Darkildo/selfsync-cloud
cd selfsync-cloud
npm ci && npm run build      # main.js, styles.css
npm test
```

To check `core/` yourself (needs Rust, `wasm-bindgen-cli` and `wasm-opt` of the versions the script names):

```sh
scripts/core.sh check
```

Release files are built in GitHub Actions and carry a provenance attestation: `gh attestation verify main.js -R Darkildo/selfsync-cloud`.

The end-to-end test runs against the Selfsync Cloud server when `SELFSYNC_CLOUD_BIN` points to its binary; without it, the test is skipped. It checks that no request body ever carries a note or a file name in clear text.

## License

[PolyForm Shield 1.0.0](LICENSE): you may read, run, change and share this code for any purpose except building a product that competes with Selfsync Cloud. `core/` is selfsync under the [MIT license](core/LICENSE).
