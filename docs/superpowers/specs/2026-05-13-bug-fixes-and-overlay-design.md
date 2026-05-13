# Bug Fixes: Tags, Pause, and Compliance Overlay Redesign

**Date:** 2026-05-13
**Status:** Approved

## Overview

Three features were broken when a subagent rewrote `commands.rs` (365 deletions) during the transcript quality work. This spec covers re-adding the missing Tauri commands and redesigning the compliance overlay with the JGP logo.

---

## Feature 1 — Tags (re-add missing commands)

### Root Cause

`get_tags`, `save_tags`, and `update_meeting_tags` were removed from `commands.rs` and `main.rs` by the dedup commit. The storage layer (`storage::load_tags`, `storage::save_tags`) and `Meeting.tags: Vec<String>` field are intact.

### Changes

**`src-tauri/src/commands.rs`** — add three command functions near the end of the file (before the `#[cfg(test)]` block):

```rust
#[tauri::command]
pub async fn get_tags() -> Result<Vec<storage::Tag>, String> {
    storage::load_tags().map_err(|e| format!("Erro ao carregar tags: {e}"))
}

#[tauri::command]
pub async fn save_tags(tags: Vec<storage::Tag>) -> Result<(), String> {
    storage::save_tags(&tags).map_err(|e| format!("Erro ao salvar tags: {e}"))
}

#[tauri::command]
pub async fn update_meeting_tags(
    meeting_id: String,
    tag_ids: Vec<String>,
) -> Result<(), String> {
    let mut meeting = storage::load_meeting(&meeting_id)
        .map_err(|e| format!("Reunião não encontrada: {e}"))?;
    meeting.tags = tag_ids;
    storage::save_meeting(&meeting).map_err(|e| format!("Erro ao salvar reunião: {e}"))
}
```

**`src-tauri/src/main.rs`** — add to `tauri::generate_handler![]`:

```rust
// Tags
commands::get_tags,
commands::save_tags,
commands::update_meeting_tags,
```

---

## Feature 2 — Pause (add missing command + state)

### Root Cause

`toggle_pause_capture` never made it into the current `commands.rs`. Additionally:
- `AudioCaptureState` has no `is_paused` field
- `CaptureStatus` DTO is missing `is_paused: bool`
- The worker loop never checks pause state before calling `process_chunk`
- The pause hotkey (`pause_hotkey`) is loaded from settings but never registered in `setup_global_shortcut`

### Changes

**`src-tauri/src/audio/mod.rs`** — add `is_paused: AtomicBool` to `AudioCaptureState`:

```rust
pub struct AudioCaptureState {
    pub is_capturing: AtomicBool,
    pub current_level: parking_lot::Mutex<f32>,
    pub mic_level: parking_lot::Mutex<f32>,
    pub mic_muted: AtomicBool,
    pub is_paused: AtomicBool,         // NEW
}

impl AudioCaptureState {
    pub fn new() -> Self {
        Self {
            is_capturing: AtomicBool::new(false),
            current_level: parking_lot::Mutex::new(0.0),
            mic_level: parking_lot::Mutex::new(0.0),
            mic_muted: AtomicBool::new(false),
            is_paused: AtomicBool::new(false),    // NEW
        }
    }

    pub fn is_paused(&self) -> bool {
        self.is_paused.load(Ordering::SeqCst)
    }

    pub fn set_paused(&self, paused: bool) {
        self.is_paused.store(paused, Ordering::SeqCst);
    }

    // ... existing methods unchanged
}
```

**`src-tauri/src/commands.rs`** — update `CaptureStatus` DTO:

```rust
pub struct CaptureStatus {
    pub is_capturing: bool,
    pub audio_level: f32,
    pub mic_level: f32,
    pub mic_muted: bool,
    pub is_paused: bool,          // NEW
    pub transcript_length: usize,
    pub duration_secs: u64,
}
```

Update `get_capture_status` to populate the new field:

```rust
#[tauri::command]
pub async fn get_capture_status(state: State<'_, AppState>) -> Result<CaptureStatus, String> {
    Ok(CaptureStatus {
        is_capturing: state.capture_state.is_capturing(),
        audio_level: *state.capture_state.current_level.lock(),
        mic_level: *state.capture_state.mic_level.lock(),
        mic_muted: state.capture_state.is_mic_muted(),
        is_paused: state.capture_state.is_paused(),     // NEW
        transcript_length: state.transcript.load().len(),
        duration_secs: state
            .capture_start
            .lock()
            .map(|s: Instant| s.elapsed().as_secs())
            .unwrap_or(0),
    })
}
```

Add `toggle_pause_capture` command (near `toggle_mic_mute`):

```rust
/// Pausa ou retoma a transcrição. Retorna o novo estado (true = pausado).
#[tauri::command]
pub async fn toggle_pause_capture(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<bool, String> {
    let current = state.capture_state.is_paused();
    let new_val = !current;
    state.capture_state.set_paused(new_val);
    log::info!("Captura {}", if new_val { "pausada" } else { "retomada" });
    let _ = app.emit("capture-paused", new_val);
    Ok(new_val)
}
```

In Phase 1 of `start_capture`, add the pause guard inside the `Ok(chunk)` arm, before the semaphore acquire:

```rust
Ok(chunk) => {
    // Skip transcription while paused
    if capture_state_clone.is_paused() {
        continue;
    }
    let chunk_recv_ms = recording_start.elapsed().as_millis() as u64;
    // ... rest of spawn logic unchanged
}
```

**`src-tauri/src/main.rs`** — register `toggle_pause_capture` in handler:

```rust
commands::toggle_pause_capture,
```

Also register the pause hotkey in `setup_global_shortcut`:

```rust
// Atalho de pausa
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

---

## Feature 3 — Compliance Overlay (fix + redesign)

### Root Cause

`open_compliance_window` and `close_compliance_window` were never implemented. Also, `get_capture_status` was missing `is_paused` (fixed in Feature 2 above).

### Window Commands

**`src-tauri/src/commands.rs`** — add both window commands:

```rust
/// Abre (ou foca) a janela de conformidade always-on-top.
#[tauri::command]
pub async fn open_compliance_window(app: AppHandle) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    // Se já existe, apenas foca
    if let Some(w) = app.get_webview_window("compliance") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "compliance", WebviewUrl::App("compliance.html".into()))
        .title("")
        .inner_size(340.0, 72.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .transparent(true)
        .skip_taskbar(true)
        .build()
        .map_err(|e| format!("Falha ao abrir overlay: {e}"))?;
    Ok(())
}

/// Fecha a janela de conformidade se existir.
#[tauri::command]
pub async fn close_compliance_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("compliance") {
        let _ = w.close();
    }
    Ok(())
}
```

**`src-tauri/src/main.rs`** — register both:

```rust
commands::open_compliance_window,
commands::close_compliance_window,
```

**`src-tauri/tauri.conf.json`** — the compliance window is created programmatically; no static config entry needed.

### Logo Asset

Move (or copy) `MARCA_JGP_White_Small.png` from repo root to `src/assets/marca-jgp-white.png` so Vite can import it as a module.

### Overlay Redesign

New layout — single horizontal pill, ~68px tall:

```
┌──────────────────────────────────────────────────────┐
│  [JGP Logo]  │  ● REC  02:14  │  [🎙]  [⏸]  [■]  │
└──────────────────────────────────────────────────────┘
```

- **Logo**: `src/assets/marca-jgp-white.png`, height 22px, auto width, opacity 0.85
- **Separator**: 1px vertical line, `rgba(255,255,255,0.10)`
- **Status badge**: animated dot (ping) or Pause icon + "REC"/"PAUSADO" label
- **Timer**: monospace, `rgba(255,255,255,0.90)`
- **Controls**: three `CtrlBtn` buttons (mute, pause, stop) — same logic as current

Background: `rgba(11, 13, 20, 0.90)`, backdrop-blur 24px, border `rgba(255,255,255,0.07)`, border-radius 16px.
Red accent when recording (`#ef4444`), amber when paused (`#f59e0b`).

The `ComplianceOverlay.tsx` logic (state management, event listeners, handlers) stays **identical**. Only the JSX layout changes.

**`src/App.tsx`** or router — the overlay window's URL must resolve to a route that renders `<ComplianceOverlay />`. Verify that `compliance.html` or a `/compliance` route exists and renders the component.

---

## Files Changed

| File | Change |
|------|--------|
| `src-tauri/src/audio/mod.rs` | Add `is_paused: AtomicBool` to `AudioCaptureState` + `is_paused()`/`set_paused()` methods |
| `src-tauri/src/commands.rs` | Add `get_tags`, `save_tags`, `update_meeting_tags`, `toggle_pause_capture`, `open_compliance_window`, `close_compliance_window`; update `CaptureStatus` + `get_capture_status` |
| `src-tauri/src/main.rs` | Register 6 new commands; add pause hotkey in `setup_global_shortcut` |
| `src/assets/marca-jgp-white.png` | Copy logo from repo root |
| `src/components/ComplianceOverlay.tsx` | Redesign JSX layout with logo; logic unchanged |

---

## Out of Scope

- Pausing the audio capture hardware (audio continues to be captured but chunks are silently dropped while paused — consistent with current design intent)
- Per-meeting pause duration tracking
- Overlay position persistence across sessions
