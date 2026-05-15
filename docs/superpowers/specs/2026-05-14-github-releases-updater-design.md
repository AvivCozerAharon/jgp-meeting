# GitHub Releases Auto-Updater — Design Spec

## Goal

Allow users to receive in-app notifications when a new version is available, with release notes and a one-click install. Releases are built and published automatically via GitHub Actions when a version tag is pushed.

---

## Architecture

Four components:

1. **GitHub Actions workflow** — triggered by `push` of tag `v*`. Builds Windows NSIS installer, signs it, creates a GitHub Release with the installer and update manifest.
2. **`latest.json`** — update manifest hosted on GitHub Releases. Tauri reads this to detect new versions.
3. **`tauri-plugin-updater`** — Rust plugin that checks the endpoint on app start and emits update info to the frontend.
4. **`UpdateBanner` React component** — dismissible banner shown at the top of the main window when an update is available.

---

## Release Flow

```
git tag v1.2.0
git push --tags
       ↓
GitHub Actions: build → sign → create Release
       ↓
GitHub Release contains:
  - jgp-meeting_1.2.0_x64-setup.exe   (installer)
  - jgp-meeting_1.2.0_x64-setup.nsis.zip  (required by updater)
  - latest.json                         (update manifest)
       ↓
User opens app → Tauri checks latest.json → UpdateBanner appears
       ↓
User clicks "Instalar e Reiniciar" → download → restart
```

---

## Signing Setup (one-time)

```bash
npx tauri signer generate -w ~/.tauri/jgp-meeting.key
```

Produces:
- `jgp-meeting.key` — private key → stored as GitHub Secret `TAURI_SIGNING_PRIVATE_KEY`
- `jgp-meeting.key.pub` — public key → goes in `tauri.conf.json`

GitHub Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` also required (set during key generation).

---

## `latest.json` format

Tauri generates this automatically during build when the updater plugin is configured. Format:

```json
{
  "version": "1.2.0",
  "notes": "• Melhoria na deduplicação cross-stream\n• Auto-save nas configurações",
  "pub_date": "2026-05-14T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<ed25519 signature>",
      "url": "https://github.com/AvivJGP/jgp-meeting/releases/download/v1.2.0/jgp-meeting_1.2.0_x64-setup.nsis.zip"
    }
  }
}
```

The `notes` field is populated from the GitHub Release body (written by the developer when pushing the tag).

---

## Backend Changes

### `src-tauri/Cargo.toml`

Add:
```toml
tauri-plugin-updater = "2"
```

### `src-tauri/src/main.rs`

Register the plugin:
```rust
.plugin(tauri_plugin_updater::Builder::new().build())
```

### `src-tauri/tauri.conf.json`

Add updater configuration:
```json
"plugins": {
  "updater": {
    "pubkey": "<contents of jgp-meeting.key.pub>",
    "endpoints": [
      "https://github.com/AvivJGP/jgp-meeting/releases/latest/download/latest.json"
    ]
  }
}
```

Also ensure `"version"` in `tauri.conf.json` is kept in sync with `package.json` on each release.

---

## GitHub Actions Workflow

**File:** `.github/workflows/release.yml`

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  release-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Install dependencies
        run: npm install

      - name: Build and release
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: "JGP Meeting ${{ github.ref_name }}"
          releaseBody: "See the assets below to install this version."
          releaseDraft: false
          prerelease: false
```

`tauri-action` automatically:
- Runs `tauri build`
- Signs the NSIS installer and `.nsis.zip`
- Generates `latest.json`
- Creates the GitHub Release and uploads all artifacts

---

## Frontend

### New file: `src/components/UpdateBanner.tsx`

Props:
```ts
interface UpdateBannerProps {
  version: string;       // e.g. "1.2.0"
  notes: string;         // release notes from latest.json
  onInstall: () => void; // triggers download + restart
  onDismiss: () => void;
}
```

States:
- `notesOpen: boolean` — toggles release notes section
- `installing: boolean` — true while download is in progress
- `progress: number | null` — download progress 0–100

**Layout:**
```
┌──────────────────────────────────────────────────────────┐
│ 🔔 Nova versão disponível: v1.2.0                     [X] │
│ É sempre importante manter o app atualizado para         │
│ receber melhorias e correções de segurança.              │
│                                                          │
│ [Ver o que mudou ↓]       [Instalar e Reiniciar →]       │
│ ─────────────────────── (expanded) ──────────────────── │
│ • Melhoria na deduplicação cross-stream                  │
│ • Auto-save nas configurações                            │
└──────────────────────────────────────────────────────────┘
```

During install:
- Button becomes `[Baixando... 42%]` with a thin progress bar
- Dismiss button hidden while installing

**Notes rendering:** Plain text, split on `\n` or markdown-style `•` bullets. No HTML rendering — notes are displayed as preformatted text lines.

### Integration in `src/App.tsx`

On mount, check for updates using `tauri-plugin-updater`'s JS API:

```ts
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const update = await check();
if (update?.available) {
  setUpdateInfo({ version: update.version, notes: update.body ?? "" });
}
```

`UpdateBanner` is rendered above the main router content when `updateInfo !== null`. Dismissed by setting `updateInfo` to `null` (state only — no persistence between sessions).

Install handler:
```ts
const handleInstall = async () => {
  setInstalling(true);
  await update.downloadAndInstall((event) => {
    if (event.event === "Progress") setProgress(event.data.chunkLength);
  });
  await relaunch();
};
```

If `check()` throws (no internet, GitHub down), the error is silently swallowed — no error shown to the user.

---

## Files Modified/Created

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Add `tauri-plugin-updater = "2"` |
| `src-tauri/src/main.rs` | Register updater plugin |
| `src-tauri/tauri.conf.json` | Add `plugins.updater` with pubkey + endpoint |
| `.github/workflows/release.yml` | New CI workflow |
| `src/components/UpdateBanner.tsx` | New component |
| `src/App.tsx` | Check for updates on mount, render UpdateBanner |
| `package.json` | Add `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-process` |

---

## Release Process (ongoing)

```bash
# 1. Bump version in both files
#    - package.json: "version": "1.2.0"
#    - src-tauri/tauri.conf.json: "version": "1.2.0"

# 2. Commit
git add package.json src-tauri/tauri.conf.json
git commit -m "chore: bump version to 1.2.0"

# 3. Tag and push
git tag v1.2.0
git push origin master --tags

# 4. GitHub Actions builds automatically (~5 min)
# 5. Go to GitHub Releases, edit the release body with changelog
```

---

## Out of Scope

- macOS / Linux builds (app currently Windows-only)
- Rollout control or staged updates
- Forcing updates (user can always dismiss)
- Auto-bumping version numbers (manual bump before tagging)
