# Pause/Resume Transcription in MainPage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the existing pause/resume backend in the MainPage UI and via a configurable global hotkey `Ctrl+Shift+P`.

**Architecture:** The Rust backend (`toggle_pause_capture`, `capture-paused` event) is fully implemented. This plan only touches the frontend hook, MainPage, TypeScript types, SettingsModal, and the Rust settings/hotkey registration. No audio logic changes.

**Tech Stack:** Rust (storage/mod.rs, commands.rs, main.rs), TypeScript/React (hooks, pages, components)

---

## File Map

| File | Change |
|---|---|
| `src-tauri/src/storage/mod.rs` | Add `pause_hotkey` field to `AppSettings` |
| `src-tauri/src/commands.rs` | Add `pause_shortcut` param to `register_global_shortcut` |
| `src-tauri/src/main.rs` | Register pause hotkey in `setup_global_shortcut` |
| `src/types/index.ts` | Add `pause_hotkey` to `AppSettings` interface |
| `src/hooks/useAudioCapture.ts` | Add `isPaused` state + `togglePause` action |
| `src/pages/MainPage.tsx` | Add pause button + `toggle-pause` event listener |
| `src/components/SettingsModal.tsx` | Add `pause_hotkey` input field |

---

## Task 1: Add `pause_hotkey` to Rust settings + hotkey registration

**Files:**
- Modify: `src-tauri/src/storage/mod.rs`
- Modify: `src-tauri/src/commands.rs:1551-1589`
- Modify: `src-tauri/src/main.rs:153-193`

- [ ] **Step 1: Add `pause_hotkey` field to `AppSettings` struct**

In `src-tauri/src/storage/mod.rs`, after the `mute_mic_hotkey` field (around line 146), add:

```rust
/// Atalho global para pausar/retomar transcrição (ex: "ctrl+shift+p")
#[serde(default = "default_pause_hotkey")]
pub pause_hotkey: String,
```

Add the default function after `fn default_mute_hotkey()`:

```rust
fn default_pause_hotkey() -> String {
    "ctrl+shift+p".to_string()
}
```

In `AppSettings::with_defaults()`, after `mute_mic_hotkey: "ctrl+shift+m".to_string(),`, add:

```rust
pause_hotkey: "ctrl+shift+p".to_string(),
```

- [ ] **Step 2: Register pause hotkey at startup in `main.rs`**

In `src-tauri/src/main.rs`, in the `setup_global_shortcut` function, after the mute hotkey block (after line 192), add:

```rust
// Atalho de pause/resume transcrição
let pause_hotkey = settings.pause_hotkey.clone();
if !pause_hotkey.is_empty() {
    let app_handle = app.handle().clone();
    if let Err(e) = app.global_shortcut().on_shortcut(
        pause_hotkey.as_str(),
        move |_app, _s, event| {
            if event.state() == ShortcutState::Pressed {
                let _ = app_handle.emit("toggle-pause", ());
            }
        },
    ) {
        log::warn!("Falha ao registrar atalho pause '{pause_hotkey}': {e}");
    } else {
        log::info!("Atalho pause '{pause_hotkey}' registrado");
    }
}
```

- [ ] **Step 3: Add `pause_shortcut` to `register_global_shortcut` command**

In `src-tauri/src/commands.rs`, update the `register_global_shortcut` function signature to accept an optional pause shortcut:

```rust
#[tauri::command]
pub async fn register_global_shortcut(
    app: AppHandle,
    shortcut: String,
    mute_shortcut: Option<String>,
    pause_shortcut: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    app.global_shortcut()
        .unregister_all()
        .map_err(|e| e.to_string())?;

    // Atalho de gravação
    if !shortcut.is_empty() {
        let app_clone = app.clone();
        app.global_shortcut()
            .on_shortcut(shortcut.as_str(), move |_app, _s, event| {
                if event.state() == ShortcutState::Pressed {
                    let _ = app_clone.emit("toggle-recording", ());
                }
            })
            .map_err(|e| format!("Erro ao registrar atalho '{}': {}", shortcut, e))?;
    }

    // Atalho de mute mic
    if let Some(ref mute) = mute_shortcut {
        if !mute.is_empty() {
            let app_clone = app.clone();
            app.global_shortcut()
                .on_shortcut(mute.as_str(), move |_app, _s, event| {
                    if event.state() == ShortcutState::Pressed {
                        let _ = app_clone.emit("toggle-mic-mute", ());
                    }
                })
                .map_err(|e| format!("Erro ao registrar atalho mute '{}': {}", mute, e))?;
        }
    }

    // Atalho de pause/resume transcrição
    if let Some(ref pause) = pause_shortcut {
        if !pause.is_empty() {
            let app_clone = app.clone();
            app.global_shortcut()
                .on_shortcut(pause.as_str(), move |_app, _s, event| {
                    if event.state() == ShortcutState::Pressed {
                        let _ = app_clone.emit("toggle-pause", ());
                    }
                })
                .map_err(|e| format!("Erro ao registrar atalho pause '{}': {}", pause, e))?;
        }
    }

    Ok(())
}
```

- [ ] **Step 4: Verify Rust compiles**

```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/storage/mod.rs src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "feat(settings): add pause_hotkey field and register pause global shortcut"
```

---

## Task 2: Add `isPaused` + `togglePause` to `useAudioCapture` hook

**Files:**
- Modify: `src/hooks/useAudioCapture.ts`

- [ ] **Step 1: Add `isPaused` to `AudioCaptureState` interface**

In `src/hooks/useAudioCapture.ts`, update the `AudioCaptureState` interface:

```ts
export interface AudioCaptureState {
  isCapturing: boolean;
  audioLevel: number;
  micLevel: number;
  micMuted: boolean;
  isProcessing: boolean;
  error: string | null;
  duration: number;
  lastMeetingId: string | null;
  isPaused: boolean;
}
```

- [ ] **Step 2: Add `togglePause` to `AudioCaptureActions` interface**

```ts
export interface AudioCaptureActions {
  start: (meetingType?: MeetingType) => Promise<void>;
  stop: () => Promise<string | null>;
  toggleMicMute: () => Promise<void>;
  clearError: () => void;
  togglePause: () => Promise<void>;
}
```

- [ ] **Step 3: Implement `isPaused` state + listener + reset logic**

Inside `useAudioCapture()`, after `const [lastMeetingId, setLastMeetingId] = useState<string | null>(null);`, add:

```ts
const [isPaused, setIsPaused] = useState(false);
```

In `setupListeners`, after the `unlistenStopped` listener setup, add a listener for `capture-paused`:

```ts
const unlistenPaused = await listen<boolean>("capture-paused", (e) => {
  if (isMounted) setIsPaused(e.payload);
});
```

Add `unlistenPaused` to `unlisteners.current`:

```ts
unlisteners.current = [unlistenLevel, unlistenMic, unlistenProcessing, unlistenError, unlistenStopped, unlistenPaused];
```

In the `recording-stopped` listener callback, add `setIsPaused(false)`:

```ts
const unlistenStopped = await listen<string>("recording-stopped", (e) => {
  if (isMounted) {
    setIsCapturing(false);
    setAudioLevel(0);
    setIsProcessing(false);
    setLastMeetingId(e.payload);
    setIsPaused(false);
  }
});
```

In the `start` callback, add `setIsPaused(false)` after `setMicMuted(false)`:

```ts
const start = useCallback(async (meetingType?: MeetingType) => {
  setError(null);
  setDuration(0);
  setLastMeetingId(null);
  setMicMuted(false);
  setIsPaused(false);
  try {
    await startCapture(meetingType);
    setIsCapturing(true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setError(msg);
  }
}, []);
```

- [ ] **Step 4: Implement `togglePause` action**

After `const toggleMicMute = useCallback(...)`, add:

```ts
const togglePause = useCallback(async () => {
  try {
    const paused = await invoke<boolean>("toggle_pause_capture");
    setIsPaused(paused);
  } catch (err) {
    console.error("Erro ao pausar/retomar transcrição:", err);
  }
}, []);
```

- [ ] **Step 5: Update return statement**

```ts
return [
  { isCapturing, audioLevel, micLevel, micMuted, isProcessing, error, duration, lastMeetingId, isPaused },
  { start, stop, toggleMicMute, clearError, togglePause },
];
```

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useAudioCapture.ts
git commit -m "feat(hook): add isPaused state and togglePause action to useAudioCapture"
```

---

## Task 3: Add pause button + event listener to `MainPage`

**Files:**
- Modify: `src/pages/MainPage.tsx`

- [ ] **Step 1: Update imports and destructuring**

In `src/pages/MainPage.tsx`, update the lucide-react import to include `Pause` and `Play`:

```ts
import { Mic, MicOff, AlertCircle, X, Volume2, VolumeX, Pause, Play } from "lucide-react";
```

Update the `captureState` destructuring to include `isPaused`:

```ts
const { isCapturing, audioLevel, micLevel, micMuted, isProcessing, error, duration, isPaused } = captureState;
```

- [ ] **Step 2: Add `toggle-pause` global event listener**

After the existing `toggle-mic-mute` `useEffect` block (after line 76), add:

```ts
// Escuta atalho global (toggle-pause)
useEffect(() => {
  let unlisten: (() => void) | null = null;
  listen<void>('toggle-pause', () => {
    if (isCapturing) captureActions.togglePause();
  }).then(fn => { unlisten = fn; }).catch(console.error);
  return () => { unlisten?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [isCapturing, captureActions]);
```

- [ ] **Step 3: Add pause button to recording controls**

In the recording controls section, after the Mic On/Off button block (after the closing `}` of `{isCapturing && ( <button onClick={captureActions.toggleMicMute} ... /> )}`, around line 254), add:

```tsx
{/* Botão Pausar/Retomar transcrição */}
{isCapturing && (
  <button
    onClick={captureActions.togglePause}
    title={isPaused ? "Retomar transcrição (Ctrl+Shift+P)" : "Pausar transcrição (Ctrl+Shift+P)"}
    className={clsx(
      "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium",
      "transition-all duration-150 border",
      isPaused
        ? "bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/20 text-amber-600 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-500/20"
        : "bg-surface-50 dark:bg-surface-700/50 border-surface-200 dark:border-surface-600 text-surface-600 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-700"
    )}
  >
    {isPaused ? (
      <>
        <Play className="w-3.5 h-3.5" />
        Retomar
      </>
    ) : (
      <>
        <Pause className="w-3.5 h-3.5" />
        Pausar
      </>
    )}
  </button>
)}
```

- [ ] **Step 4: Manual test**

```bash
cd .. && cargo tauri dev
```

Start recording → pause button appears → click → button turns amber "Retomar" → transcript stops updating → click again → resumes. `Ctrl+Shift+P` triggers the same toggle.

- [ ] **Step 5: Commit**

```bash
git add src/pages/MainPage.tsx
git commit -m "feat(ui): add pause button and toggle-pause hotkey listener to MainPage"
```

---

## Task 4: Add `pause_hotkey` to TypeScript types + SettingsModal

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/components/SettingsModal.tsx`

- [ ] **Step 1: Add `pause_hotkey` to `AppSettings` interface**

In `src/types/index.ts`, after `mute_mic_hotkey: string;` (line 94), add:

```ts
/** Atalho global para pausar/retomar transcrição (ex: "ctrl+shift+p") */
pause_hotkey: string;
```

- [ ] **Step 2: Add default value in SettingsModal**

In `src/components/SettingsModal.tsx`, find the defaults object (around line 112 where `global_hotkey: "ctrl+shift+r"` is defined) and add:

```ts
pause_hotkey: "ctrl+shift+p",
```

- [ ] **Step 3: Add the input field in SettingsModal**

Find the mute hotkey `<SettingRow>` block (which ends around line 851 with the `</SettingRow>` closing the mute hotkey section). After that closing tag, add:

```tsx
<SettingRow
  title="Pausar/Retomar Transcrição"
  description="Atalho global para pausar ou retomar a transcrição sem parar a gravação. Salve e reinicie o app para aplicar."
>
  <input
    type="text"
    value={settings.pause_hotkey ?? "ctrl+shift+p"}
    onChange={(e) => updateSetting("pause_hotkey", e.target.value)}
    placeholder="ctrl+shift+p"
    className={clsx(
      "w-full px-3 py-2.5 text-sm rounded-xl border font-mono",
      "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
      "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
    )}
  />
</SettingRow>
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors related to `pause_hotkey`.

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/components/SettingsModal.tsx
git commit -m "feat(settings): add pause_hotkey config field to types and SettingsModal"
```
