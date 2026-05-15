# GitHub Releases Auto-Updater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automatic update detection via GitHub Releases — a dismissible banner appears when a new version is available, with release notes and one-click install.

**Architecture:** `tauri-plugin-updater` checks a `latest.json` manifest hosted on GitHub Releases on app start; if a newer version exists, the frontend shows `UpdateBanner` above the main content. GitHub Actions builds, signs, and publishes releases automatically on `git tag v*` push.

**Tech Stack:** Rust/Tauri 2, `tauri-plugin-updater`, `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process`, GitHub Actions (`tauri-apps/tauri-action`)

---

## File Map

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Add `tauri-plugin-updater = "2"` |
| `src-tauri/src/main.rs` | Register updater plugin |
| `src-tauri/tauri.conf.json` | Add `plugins.updater` with pubkey + endpoint |
| `package.json` | Add `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-process` |
| `src/components/UpdateBanner.tsx` | New component — banner with notes expand + install progress |
| `src/App.tsx` | Check for updates on mount, render UpdateBanner |
| `.github/workflows/release.yml` | New CI workflow |

---

### Task 1: Add updater plugin — Rust side

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add dependency to Cargo.toml**

In `src-tauri/Cargo.toml`, after the line `tauri-plugin-global-shortcut = "2"`, add:

```toml
tauri-plugin-updater = "2"
```

- [ ] **Step 2: Register plugin in main.rs**

In `src-tauri/src/main.rs`, find:
```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
```

Replace with:
```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
```

- [ ] **Step 3: Build to verify it compiles**

```bash
cd src-tauri && cargo build 2>&1 | grep "^error" | head -10
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/main.rs
git commit -m "feat(updater): add tauri-plugin-updater"
```

---

### Task 2: Configure updater endpoint in tauri.conf.json

**Files:**
- Modify: `src-tauri/tauri.conf.json`

The updater needs a public key and an endpoint URL. The public key is a placeholder for now — it will be replaced with the real key after the user generates their signing keypair (see setup instructions at the end of this plan).

- [ ] **Step 1: Add updater config to tauri.conf.json**

The current `tauri.conf.json` has no `plugins` section. Add one. The full updated file should be:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "JGP Meeting",
  "version": "0.1.0",
  "identifier": "com.jgp.meeting",
  "build": {
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build",
    "devUrl": "http://localhost:1420",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "JGP Meeting",
        "width": 1280,
        "height": 820,
        "minWidth": 960,
        "minHeight": 640,
        "resizable": true,
        "fullscreen": false,
        "center": true,
        "decorations": true,
        "transparent": false
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.ico"
    ],
    "windows": {
      "nsis": {
        "installMode": "currentUser"
      }
    }
  },
  "plugins": {
    "updater": {
      "pubkey": "PLACEHOLDER_REPLACE_WITH_REAL_PUBKEY",
      "endpoints": [
        "https://github.com/AvivJGP/jgp-meeting/releases/latest/download/latest.json"
      ]
    }
  }
}
```

- [ ] **Step 2: Build to verify JSON is valid**

```bash
cd src-tauri && cargo build 2>&1 | grep "^error" | head -10
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/tauri.conf.json
git commit -m "feat(updater): configure update endpoint and pubkey placeholder"
```

---

### Task 3: Add frontend npm packages

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install updater and process plugins**

```bash
npm install @tauri-apps/plugin-updater @tauri-apps/plugin-process
```

- [ ] **Step 2: Verify packages are in package.json**

```bash
grep -E "plugin-updater|plugin-process" package.json
```

Expected output:
```
    "@tauri-apps/plugin-updater": "^2...",
    "@tauri-apps/plugin-process": "^2...",
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(updater): add @tauri-apps/plugin-updater and plugin-process"
```

---

### Task 4: Create UpdateBanner component

**Files:**
- Create: `src/components/UpdateBanner.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/UpdateBanner.tsx` with this content:

```tsx
// UpdateBanner.tsx
// Banner discreto exibido quando uma nova versão está disponível.

import { useState } from "react";
import clsx from "clsx";
import { Bell, X, ChevronDown, ChevronUp, Download } from "lucide-react";

interface UpdateBannerProps {
  version: string;
  notes: string;
  onInstall: () => void;
  onDismiss: () => void;
  installing: boolean;
  progress: number | null;
}

export const UpdateBanner: React.FC<UpdateBannerProps> = ({
  version,
  notes,
  onInstall,
  onDismiss,
  installing,
  progress,
}) => {
  const [notesOpen, setNotesOpen] = useState(false);

  const noteLines = notes
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  return (
    <div className={clsx(
      "w-full border-b px-4 py-3",
      "bg-primary-50 border-primary-200 dark:bg-primary-500/10 dark:border-primary-500/30"
    )}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <Bell className="w-4 h-4 text-primary-500 dark:text-primary-400 mt-0.5 flex-shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-primary-800 dark:text-primary-200">
              Nova versão disponível: v{version}
            </p>
            <p className="text-xs text-primary-600 dark:text-primary-400 mt-0.5">
              É sempre importante manter o app atualizado para receber melhorias e correções.
            </p>

            {/* Release notes expandível */}
            {noteLines.length > 0 && (
              <button
                onClick={() => setNotesOpen((v) => !v)}
                className="flex items-center gap-1 mt-1.5 text-xs font-medium text-primary-600 dark:text-primary-400 hover:text-primary-800 dark:hover:text-primary-200 transition-colors"
              >
                {notesOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                {notesOpen ? "Ocultar o que mudou" : "Ver o que mudou"}
              </button>
            )}

            {notesOpen && (
              <ul className="mt-2 space-y-0.5 pl-1">
                {noteLines.map((line, i) => (
                  <li key={i} className="text-xs text-primary-700 dark:text-primary-300 flex items-start gap-1.5">
                    <span className="text-primary-400 mt-0.5 flex-shrink-0">•</span>
                    <span>{line.replace(/^[-•]\s*/, "")}</span>
                  </li>
                ))}
              </ul>
            )}

            {/* Barra de progresso durante download */}
            {installing && progress !== null && (
              <div className="mt-2 w-48">
                <div className="h-1 bg-primary-200 dark:bg-primary-500/30 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary-500 dark:bg-primary-400 rounded-full transition-all duration-200"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <p className="text-[10px] text-primary-500 dark:text-primary-400 mt-0.5">{progress}% baixado</p>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={onInstall}
            disabled={installing}
            className={clsx(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all",
              "bg-primary-500 text-white hover:bg-primary-600 shadow-sm",
              "disabled:opacity-60 disabled:cursor-not-allowed"
            )}
          >
            <Download className="w-3.5 h-3.5" />
            {installing ? "Instalando..." : "Instalar e Reiniciar"}
          </button>

          {!installing && (
            <button
              onClick={onDismiss}
              className="p-1 rounded-md text-primary-400 hover:text-primary-600 dark:hover:text-primary-200 hover:bg-primary-100 dark:hover:bg-primary-500/20 transition-colors"
              title="Fechar"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Verify TypeScript**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors in `UpdateBanner.tsx`.

- [ ] **Step 3: Commit**

```bash
git add src/components/UpdateBanner.tsx
git commit -m "feat(updater): add UpdateBanner component"
```

---

### Task 5: Integrate update check in App.tsx

**Files:**
- Modify: `src/App.tsx`

On mount, check for updates. If available, store in state and render `UpdateBanner` above the main content area.

- [ ] **Step 1: Add update check logic to App.tsx**

Replace the full content of `src/App.tsx` with:

```tsx
// App.tsx
// Componente raiz do JGP Meeting.
// Gerencia a navegação entre páginas, o estado global e o tema.
//
// IMPORTANTE: O MainPage é mantido SEMPRE montado (com display:none quando
// inativo) para preservar os hooks de captura, transcrição e seus listeners
// durante a navegação. Sem isso, navegar para Histórico/Config mataria o
// useAudioCapture e a gravação ficaria dessincronizada.

import { useState, useCallback, useEffect } from "react";
import { Navigation } from "@/components/Navigation";
import { MainPage } from "@/pages/MainPage";
import { HistoryPage } from "@/pages/HistoryPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { SetupWizard } from "@/components/SetupWizard";
import { UpdateBanner } from "@/components/UpdateBanner";
import type { AppPage } from "@/types";
import { useDraining } from "@/hooks/useDraining";
import { ThemeContext, useThemeProvider } from "@/hooks/useTheme";
import { getSettings } from "@/services/storageService";

interface UpdateInfo {
  version: string;
  notes: string;
}

function App() {
  const [currentPage, setCurrentPage] = useState<AppPage>("main");
  const drainingState = useDraining();
  const themeValue = useThemeProvider();
  const [isRecording, setIsRecording] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState<number | null>(null);
  // Ref to hold the update object between check and install
  const [updateHandle, setUpdateHandle] = useState<{ downloadAndInstall: (cb: (e: { event: string; data: { chunkLength?: number; contentLength?: number } }) => void) => Promise<void> } | null>(null);

  useEffect(() => {
    getSettings()
      .then((s) => { if (!s.setup_done) setShowWizard(true); })
      .catch(() => {});
  }, []);

  // Check for updates on mount — silently ignore any errors (no internet, etc.)
  useEffect(() => {
    let cancelled = false;
    const checkUpdate = async () => {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        if (!cancelled && update?.available) {
          setUpdateInfo({
            version: update.version,
            notes: update.body ?? "",
          });
          setUpdateHandle(update as typeof updateHandle);
        }
      } catch {
        // Silent fail — no internet or update server unavailable
      }
    };
    checkUpdate();
    return () => { cancelled = true; };
  }, []);

  const handleInstall = useCallback(async () => {
    if (!updateHandle) return;
    setInstalling(true);
    setInstallProgress(0);
    try {
      let downloaded = 0;
      let total = 0;
      await updateHandle.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength ?? 0;
          if (total > 0) setInstallProgress(Math.round((downloaded / total) * 100));
        }
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch {
      setInstalling(false);
      setInstallProgress(null);
    }
  }, [updateHandle]);

  const handleDismissUpdate = useCallback(() => {
    setUpdateInfo(null);
  }, []);

  const handleNavigate = useCallback((page: AppPage) => {
    setCurrentPage(page);
  }, []);

  const handleMeetingSaved = useCallback((meetingId: string) => {
    console.log("Reunião salva:", meetingId);
  }, []);

  return (
    <ThemeContext.Provider value={themeValue}>
      {showWizard && <SetupWizard onComplete={() => setShowWizard(false)} />}
      <div className="flex h-screen w-screen overflow-hidden bg-surface-50 dark:bg-[#0c0f17]">
        <Navigation
          currentPage={currentPage}
          onNavigate={handleNavigate}
          isRecording={isRecording}
          isDraining={drainingState.isDraining}
          drainingProgress={drainingState.progress}
          drainingPending={drainingState.pending}
          drainingTotal={drainingState.total}
        />

        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Update banner — shown above all content */}
          {updateInfo && (
            <UpdateBanner
              version={updateInfo.version}
              notes={updateInfo.notes}
              onInstall={handleInstall}
              onDismiss={handleDismissUpdate}
              installing={installing}
              progress={installProgress}
            />
          )}

          <div
            className="flex-1 flex flex-col overflow-hidden"
            style={{ display: currentPage === "main" ? "flex" : "none" }}
          >
            <MainPage
              onMeetingSaved={handleMeetingSaved}
              onRecordingChange={setIsRecording}
            />
          </div>

          {currentPage === "history" && <HistoryPage />}
          {currentPage === "settings" && <SettingsPage />}
        </main>
      </div>
    </ThemeContext.Provider>
  );
}

export default App;
```

- [ ] **Step 2: Verify TypeScript**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(updater): check for updates on app start, show UpdateBanner"
```

---

### Task 6: GitHub Actions release workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create the workflows directory and file**

```bash
mkdir -p .github/workflows
```

Create `.github/workflows/release.yml` with this content:

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
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Rust cache
        uses: swatinem/rust-cache@v2
        with:
          workspaces: src-tauri

      - name: Install frontend dependencies
        run: npm install

      - name: Build and publish release
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: "JGP Meeting ${{ github.ref_name }}"
          releaseBody: |
            ## O que mudou

            _Edite esta release no GitHub para adicionar o changelog._
          releaseDraft: false
          prerelease: false
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add GitHub Actions release workflow for Windows"
```

---

### Task 7: Full build verification

**Files:** none — verification only

- [ ] **Step 1: Verify Rust build**

```bash
cd src-tauri && cargo build 2>&1 | grep "^error" | head -10
```

Expected: no errors.

- [ ] **Step 2: Verify TypeScript**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit if any fixes were needed**

If any issues were found and fixed:
```bash
git add -p
git commit -m "fix: address build issues in updater integration"
```

---

## ⚠️ Manual Setup Required by the User (after implementation)

The following steps cannot be automated — the user must do them once:

### 1. Generate signing keypair

Run this command **once** on your machine:

```bash
npx tauri signer generate -w %USERPROFILE%\.tauri\jgp-meeting.key
```

It will ask for a password — save it somewhere safe. This generates two files:
- `%USERPROFILE%\.tauri\jgp-meeting.key` — private key (keep secret, never commit)
- `%USERPROFILE%\.tauri\jgp-meeting.key.pub` — public key (safe to share)

### 2. Update tauri.conf.json with the real pubkey

Open `%USERPROFILE%\.tauri\jgp-meeting.key.pub` and copy its contents.

In `src-tauri/tauri.conf.json`, replace:
```json
"pubkey": "PLACEHOLDER_REPLACE_WITH_REAL_PUBKEY"
```
with:
```json
"pubkey": "<paste the contents of jgp-meeting.key.pub here>"
```

Then commit:
```bash
git add src-tauri/tauri.conf.json
git commit -m "feat(updater): set real signing pubkey"
```

### 3. Add GitHub Secrets

Go to your GitHub repo → **Settings → Secrets and variables → Actions** → New repository secret.

Add these two secrets:

| Name | Value |
|------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `%USERPROFILE%\.tauri\jgp-meeting.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password you chose in step 1 |

### 4. Push your first release

```bash
# Bump version in both files (e.g., to 0.2.0):
# - package.json: "version": "0.2.0"
# - src-tauri/tauri.conf.json: "version": "0.2.0"

git add package.json src-tauri/tauri.conf.json
git commit -m "chore: bump version to 0.2.0"
git tag v0.2.0
git push origin master --tags
```

GitHub Actions will build (~8 min on Windows), create the release, and upload `latest.json` + the installer. After that, any user running an older version will see the update banner on next app open.

### 5. Edit the release notes on GitHub

After the release is created, go to **GitHub → Releases → v0.2.0 → Edit** and replace the placeholder body with your actual changelog. The `notes` field in `latest.json` is populated from this text.
