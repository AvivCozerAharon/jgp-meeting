# Design: Pause/Resume Transcription in MainPage

**Date:** 2026-04-07
**Status:** Approved

## Problem

The pause/resume function already works fully in the backend (`toggle_pause_capture` command) and in the `ComplianceOverlay` floating window. However, the main app window (`MainPage`) has no pause button and no global hotkey for pause/resume. Users who close or don't see the overlay have no way to pause.

## Goal

Expose pause/resume in the `MainPage` UI and via a configurable global hotkey, reusing the existing backend without any Rust changes.

## Scope

**In scope:**
- Add `isPaused` state and `togglePause` action to `useAudioCapture` hook
- Add pause button in `MainPage` recording controls (between Mic and Stop)
- Add `pause_hotkey` field to `AppSettings` with default `"ctrl+shift+p"`
- Register the hotkey in `main.rs` → emit `"toggle-pause"` event
- Handle `"toggle-pause"` event in `MainPage`
- Add hotkey config field in `SettingsModal`

**Out of scope:**
- Any Rust backend changes (backend is complete)
- Changes to `ComplianceOverlay` (already works independently)

## What Already Exists

| Layer | Status |
|---|---|
| `toggle_pause_capture` Tauri command | ✅ Done |
| `get_capture_status` returns `is_paused` | ✅ Done |
| `capture-paused` event emitted on toggle | ✅ Done |
| `AudioCaptureState.set_paused()` | ✅ Done |
| ComplianceOverlay pause button + "PAUSADO" badge | ✅ Done |

## Architecture

```
main.rs
  + hotkey "ctrl+shift+p" → emit("toggle-pause")

useAudioCapture hook
  + isPaused: boolean         (listens to "capture-paused" event)
  + togglePause: () => void   (invokes "toggle_pause_capture")

MainPage
  + reads isPaused from captureState
  + renders pause button when isCapturing
  + listens to "toggle-pause" event → calls captureActions.togglePause()

AppSettings
  + pause_hotkey: String      (default: "ctrl+shift+p")

SettingsModal
  + input field for pause_hotkey
```

## Changes by File

### `src-tauri/src/storage/mod.rs`

Add to `AppSettings`:
```rust
/// Atalho global para pausar/retomar transcrição (ex: "ctrl+shift+p")
#[serde(default = "default_pause_hotkey")]
pub pause_hotkey: String,
```

Add default function:
```rust
fn default_pause_hotkey() -> String {
    "ctrl+shift+p".to_string()
}
```

Add to `AppSettings::with_defaults()`:
```rust
pause_hotkey: "ctrl+shift+p".to_string(),
```

### `src-tauri/src/main.rs`

In `setup_global_shortcut`, add after the mute hotkey block:
```rust
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
    }
}
```

### `src/hooks/useAudioCapture.ts`

Add `isPaused: boolean` to `AudioCaptureState` interface.

Add `togglePause: () => Promise<void>` to `AudioCaptureActions` interface.

In `setupListeners`, add:
```ts
const unlistenPaused = await listen<boolean>("capture-paused", (e) => {
  if (isMounted) setIsPaused(e.payload);
});
```

Add `useState<boolean>(false)` for `isPaused`.

Reset `isPaused` to `false` in the `recording-stopped` listener and in `start`.

Implement `togglePause`:
```ts
const togglePause = useCallback(async () => {
  try {
    const paused = await invoke<boolean>("toggle_pause_capture");
    setIsPaused(paused);
  } catch (err) {
    console.error("Erro ao pausar/retomar:", err);
  }
}, []);
```

### `src/pages/MainPage.tsx`

Add `isPaused` and `togglePause` destructured from `captureState` / `captureActions`.

Add `useEffect` to handle `"toggle-pause"` global event:
```ts
listen<void>('toggle-pause', () => {
  if (isCapturing) captureActions.togglePause();
})
```

Add pause button in the recording controls area, visible only when `isCapturing`:
- Icon: `Pause` when not paused, `Play` when paused (lucide-react, already installed)
- Title: "Pausar transcrição" / "Retomar transcrição"

### `src/components/SettingsModal.tsx`

Add an input field for `pause_hotkey` alongside the existing `global_hotkey` and `mute_mic_hotkey` fields.

## Error Handling

`togglePause` logs errors to console but does not show UI error — same pattern as `toggleMicMute`.

## Testing

- Manual: start recording, click pause → button changes to Play, timer still runs (pause is transcription-only, audio captured but discarded), transcript stops updating; click resume → resumes
- Manual: `Ctrl+Shift+P` triggers pause from outside app window
- Manual: ComplianceOverlay pause button still works independently
