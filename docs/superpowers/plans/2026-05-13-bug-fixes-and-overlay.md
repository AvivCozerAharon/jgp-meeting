# Bug Fixes: Tags, Pause, and Compliance Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-add three sets of missing Tauri commands (tags, pause, compliance window) that were deleted during a prior refactor, and redesign the compliance overlay with the JGP logo.

**Architecture:** Four independent tasks. Tasks 1–3 are pure Rust/backend fixes. Task 4 is a frontend-only redesign of `ComplianceOverlay.tsx`. Each task is self-contained: Task 1 adds pause state to `audio/mod.rs`, Task 2 adds all missing command handlers to `commands.rs`, Task 3 registers them in `main.rs`, Task 4 copies the logo asset and rewrites the overlay JSX.

**Tech Stack:** Rust, Tauri 2, `AtomicBool`, `parking_lot`, React 18, TypeScript, Tailwind CSS (not used in overlay — overlay uses inline styles)

---

## File Map

| File | Change |
|------|--------|
| `src-tauri/src/audio/mod.rs` | Add `is_paused: AtomicBool` field + `is_paused()`/`set_paused()` methods to `AudioCaptureState` |
| `src-tauri/src/commands.rs` | Add `is_paused` to `CaptureStatus`; update `get_capture_status`; add `toggle_pause_capture`, `get_tags`, `save_tags`, `update_meeting_tags`, `open_compliance_window`, `close_compliance_window`; add pause guard in Phase 1 loop |
| `src-tauri/src/main.rs` | Register 6 new commands in `generate_handler!`; add pause hotkey in `setup_global_shortcut` |
| `src/assets/marca-jgp-white.png` | Copy from repo root |
| `src/components/ComplianceOverlay.tsx` | Redesign JSX layout with logo; all logic unchanged |

---

## Task 1: Add `is_paused` to `AudioCaptureState`

**Files:**
- Modify: `src-tauri/src/audio/mod.rs` (lines 115–145)

**Context:** `AudioCaptureState` is the shared state struct used by both the audio worker and Tauri commands. It currently has `is_capturing` and `mic_muted` as `AtomicBool` fields. We add `is_paused` following the same pattern.

- [ ] **Step 1: Add the field and methods**

In `src-tauri/src/audio/mod.rs`, find the `AudioCaptureState` struct (line 115). Replace the entire struct + impl block (lines 115–151) with:

```rust
pub struct AudioCaptureState {
    pub is_capturing: AtomicBool,
    pub current_level: parking_lot::Mutex<f32>,
    /// Feature 5: nível de áudio do microfone (separado do loopback)
    pub mic_level: parking_lot::Mutex<f32>,
    /// Quando true, o áudio do microfone é silenciado (não misturado ao loopback)
    pub mic_muted: AtomicBool,
    /// Quando true, os chunks de áudio são descartados (transcrição pausada)
    pub is_paused: AtomicBool,
}

impl AudioCaptureState {
    pub fn new() -> Self {
        Self {
            is_capturing: AtomicBool::new(false),
            current_level: parking_lot::Mutex::new(0.0),
            mic_level: parking_lot::Mutex::new(0.0),
            mic_muted: AtomicBool::new(false),
            is_paused: AtomicBool::new(false),
        }
    }

    pub fn is_capturing(&self) -> bool {
        self.is_capturing.load(Ordering::SeqCst)
    }

    pub fn is_mic_muted(&self) -> bool {
        self.mic_muted.load(Ordering::SeqCst)
    }

    pub fn set_mic_muted(&self, muted: bool) {
        self.mic_muted.store(muted, Ordering::SeqCst);
    }

    pub fn is_paused(&self) -> bool {
        self.is_paused.load(Ordering::SeqCst)
    }

    pub fn set_paused(&self, paused: bool) {
        self.is_paused.store(paused, Ordering::SeqCst);
    }
}

impl Default for AudioCaptureState {
    fn default() -> Self {
        Self::new()
    }
}
```

- [ ] **Step 2: Build to verify**

```
cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^error"
```

Expected: no error lines.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/audio/mod.rs
git commit -m "feat(audio): add is_paused state to AudioCaptureState"
```

---

## Task 2: Add all missing commands to `commands.rs`

**Files:**
- Modify: `src-tauri/src/commands.rs`

**Context:** Six commands are missing. We also need to:
- Add `is_paused: bool` to `CaptureStatus` (line 98)
- Update `get_capture_status` to populate it
- Add a pause guard in Phase 1 of `start_capture`

All new command functions go between the last existing command (`update_meeting_segment`, ends at line ~1732) and the `#[cfg(test)]` block (line 1734).

### Sub-task A: Fix `CaptureStatus` and `get_capture_status`

- [ ] **Step 1: Add `is_paused` to `CaptureStatus`**

Find the `CaptureStatus` struct (line 98):

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CaptureStatus {
    pub is_capturing: bool,
    pub audio_level: f32,
    pub mic_level: f32,
    pub mic_muted: bool,
    pub transcript_length: usize,
    pub duration_secs: u64,
}
```

Replace with:

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CaptureStatus {
    pub is_capturing: bool,
    pub audio_level: f32,
    pub mic_level: f32,
    pub mic_muted: bool,
    pub is_paused: bool,
    pub transcript_length: usize,
    pub duration_secs: u64,
}
```

- [ ] **Step 2: Update `get_capture_status`**

Find `get_capture_status` (around line 598). Replace the `Ok(CaptureStatus { ... })` block with:

```rust
    Ok(CaptureStatus {
        is_capturing: state.capture_state.is_capturing(),
        audio_level: *state.capture_state.current_level.lock(),
        mic_level: *state.capture_state.mic_level.lock(),
        mic_muted: state.capture_state.is_mic_muted(),
        is_paused: state.capture_state.is_paused(),
        transcript_length: state.transcript.load().len(),
        duration_secs: state
            .capture_start
            .lock()
            .map(|s: Instant| s.elapsed().as_secs())
            .unwrap_or(0),
    })
```

### Sub-task B: Add `toggle_pause_capture`

- [ ] **Step 3: Add `toggle_pause_capture` after `toggle_mic_mute`**

Find `toggle_mic_mute` (line 711). Add immediately after its closing brace:

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

### Sub-task C: Add pause guard in Phase 1 worker loop

- [ ] **Step 4: Add pause guard in the `Ok(chunk)` arm**

In `start_capture`, inside the Phase 1 worker `loop { ... match chunk_rx.recv_timeout(...) { ... } }`, find the `Ok(chunk) =>` arm. It currently starts like:

```rust
                Ok(chunk) => {
                    let chunk_recv_ms = recording_start.elapsed().as_millis() as u64;
                    let permit = Arc::clone(&transcription_sem)
```

Add a pause check at the very start of the arm:

```rust
                Ok(chunk) => {
                    // Drop chunk silently while paused
                    if app_clone.state::<AppState>().capture_state.is_paused() {
                        continue;
                    }
                    let chunk_recv_ms = recording_start.elapsed().as_millis() as u64;
                    let permit = Arc::clone(&transcription_sem)
```

### Sub-task D: Add tag commands

- [ ] **Step 5: Add tag commands before the `#[cfg(test)]` block**

Find the `#[cfg(test)]` line (line 1734). Add immediately before it:

```rust
// ─── Comandos: Tags ──────────────────────────────────────────────────────────

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

### Sub-task E: Add compliance window commands

- [ ] **Step 6: Add window commands before `#[cfg(test)]`**

After the tag commands block (still before `#[cfg(test)]`), add:

```rust
// ─── Comandos: Janela de Conformidade ────────────────────────────────────────

/// Abre (ou foca) a janela de conformidade always-on-top.
#[tauri::command]
pub async fn open_compliance_window(app: AppHandle) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    if let Some(w) = app.get_webview_window("compliance") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    // main.tsx renders <ComplianceOverlay> when window.location.hash === "#compliance"
    WebviewWindowBuilder::new(&app, "compliance", WebviewUrl::App("index.html#compliance".into()))
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

- [ ] **Step 7: Build to verify**

```
cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^error"
```

Expected: no error lines.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(commands): re-add tags, pause, and compliance window commands"
```

---

## Task 3: Register commands and pause hotkey in `main.rs`

**Files:**
- Modify: `src-tauri/src/main.rs`

**Context:** `main.rs` has two places to update: the `tauri::generate_handler![]` macro and the `setup_global_shortcut` function.

- [ ] **Step 1: Register the 6 new commands in `generate_handler!`**

Find the closing `])` of `tauri::generate_handler![` (currently after `commands::jgrc_get_export_data,` at line ~72). Add before the closing `]`:

```rust
            // Tags
            commands::get_tags,
            commands::save_tags,
            commands::update_meeting_tags,
            // Pausa
            commands::toggle_pause_capture,
            // Janela de conformidade
            commands::open_compliance_window,
            commands::close_compliance_window,
```

- [ ] **Step 2: Add pause hotkey registration in `setup_global_shortcut`**

In the `setup_global_shortcut` function, find the mute hotkey block. After its closing `}`, add:

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

- [ ] **Step 3: Build to verify**

```
cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^error"
```

Expected: no error lines.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/main.rs
git commit -m "feat(main): register tags/pause/overlay commands and pause hotkey"
```

---

## Task 4: Copy logo asset and redesign ComplianceOverlay

**Files:**
- Create: `src/assets/marca-jgp-white.png` (copy from repo root)
- Modify: `src/components/ComplianceOverlay.tsx`

**Context:** `ComplianceOverlay.tsx` renders inside a frameless transparent Tauri window. It uses inline styles (not Tailwind). The entire state management, event listeners, and handlers stay **identical** — only the JSX layout changes.

The logo file `MARCA_JGP_White_Small.png` is already in the repo root. It must be in `src/assets/` so Vite can import it as a module URL.

- [ ] **Step 1: Copy the logo to assets**

```bash
cp MARCA_JGP_White_Small.png src/assets/marca-jgp-white.png
```

Verify: `ls src/assets/marca-jgp-white.png`

- [ ] **Step 2: Replace the entire `ComplianceOverlay.tsx`**

Replace the full contents of `src/components/ComplianceOverlay.tsx` with:

```tsx
// ComplianceOverlay.tsx
// Janela flutuante always-on-top exibida durante a gravação.

import { useEffect, useLayoutEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Mic, MicOff, Pause, Play, Square } from "lucide-react";
import jgpLogo from "../assets/marca-jgp-white.png";

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60).toString().padStart(2, "0");
  const s = (secs % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

// ── Sub-componente de botão ───────────────────────────────────────────────────

interface CtrlBtnProps {
  onClick: () => void;
  title: string;
  active?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}

const CtrlBtn: React.FC<CtrlBtnProps> = ({ onClick, title, active, danger, children }) => (
  <button
    onClick={onClick}
    title={title}
    style={{
      width: 28,
      height: 28,
      borderRadius: 8,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      border: `1px solid ${active ? "rgba(239,68,68,0.5)" : "rgba(255,255,255,0.08)"}`,
      background: active
        ? "rgba(239,68,68,0.22)"
        : danger
        ? "rgba(239,68,68,0.12)"
        : "rgba(255,255,255,0.06)",
      color: active
        ? "#fca5a5"
        : danger
        ? "rgba(239,68,68,0.85)"
        : "rgba(255,255,255,0.65)",
      cursor: "pointer",
      transition: "background 0.15s, color 0.15s, border-color 0.15s",
      flexShrink: 0,
      WebkitAppRegion: "no-drag",
    } as React.CSSProperties}
    onMouseEnter={(e) => {
      const el = e.currentTarget as HTMLButtonElement;
      el.style.background = danger
        ? "rgba(239,68,68,0.28)"
        : active
        ? "rgba(239,68,68,0.35)"
        : "rgba(255,255,255,0.12)";
      el.style.color = danger ? "#fca5a5" : "rgba(255,255,255,0.9)";
    }}
    onMouseLeave={(e) => {
      const el = e.currentTarget as HTMLButtonElement;
      el.style.background = active
        ? "rgba(239,68,68,0.22)"
        : danger
        ? "rgba(239,68,68,0.12)"
        : "rgba(255,255,255,0.06)";
      el.style.color = active
        ? "#fca5a5"
        : danger
        ? "rgba(239,68,68,0.85)"
        : "rgba(255,255,255,0.65)";
    }}
  >
    {children}
  </button>
);

// ── Separador vertical ────────────────────────────────────────────────────────

const Sep: React.FC = () => (
  <div
    style={{
      width: 1,
      height: 20,
      background: "rgba(255,255,255,0.10)",
      flexShrink: 0,
    }}
  />
);

// ── Componente principal ──────────────────────────────────────────────────────

export const ComplianceOverlay = () => {
  const [micMuted, setMicMuted] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [duration, setDuration] = useState(0);

  useLayoutEffect(() => {
    document.documentElement.style.setProperty("background", "transparent", "important");
    document.body.style.setProperty("background", "transparent", "important");
    document.documentElement.className = "";
    document.body.className = "";
  }, []);

  // Timer local — para quando pausado
  useEffect(() => {
    if (isPaused) return;
    const id = setInterval(() => setDuration((d) => d + 1), 1000);
    return () => clearInterval(id);
  }, [isPaused]);

  // Sincroniza estado inicial + poll completo de status
  useEffect(() => {
    const sync = async () => {
      try {
        const s = await invoke<{
          mic_muted: boolean;
          is_paused: boolean;
          duration_secs: number;
          is_capturing: boolean;
        }>("get_capture_status");
        setMicMuted(s.mic_muted);
        setIsPaused(s.is_paused);
        setDuration((d) => (Math.abs(s.duration_secs - d) > 2 ? s.duration_secs : d));
        if (!s.is_capturing) {
          invoke("close_compliance_window").catch(() => {});
        }
      } catch {}
    };

    sync();
    const poll = setInterval(sync, 2000);
    return () => clearInterval(poll);
  }, []);

  useEffect(() => {
    const unsubs = [
      listen<boolean>("capture-paused", (e) => setIsPaused(e.payload)),
      listen<string>("recording-stopped", () => {
        invoke("close_compliance_window").catch(() => {});
      }),
    ];
    return () => { unsubs.forEach((p) => p.then((fn) => fn())); };
  }, []);

  const handleMute = useCallback(async () => {
    try { setMicMuted(await invoke<boolean>("toggle_mic_mute")); } catch {}
  }, []);

  const handlePause = useCallback(async () => {
    try { setIsPaused(await invoke<boolean>("toggle_pause_capture")); } catch {}
  }, []);

  const handleStop = useCallback(async () => {
    try {
      await invoke("stop_capture");
    } catch (e) {
      console.error("stop_capture falhou:", e);
      invoke("close_compliance_window").catch(() => {});
    }
  }, []);

  const accentColor = isPaused ? "#f59e0b" : "#ef4444";
  const accentDim   = isPaused ? "rgba(245,158,11,0.18)" : "rgba(239,68,68,0.18)";

  return (
    <div
      style={{
        margin: 10,
        padding: "0 14px",
        height: 52,
        borderRadius: 16,
        display: "flex",
        alignItems: "center",
        gap: 12,
        background: "rgba(11, 13, 20, 0.90)",
        backdropFilter: "blur(24px) saturate(180%)",
        WebkitBackdropFilter: "blur(24px) saturate(180%)",
        border: "1px solid rgba(255,255,255,0.07)",
        boxShadow:
          "0 8px 32px rgba(0,0,0,0.45), 0 1px 0 rgba(255,255,255,0.04) inset",
        WebkitAppRegion: "drag",
        userSelect: "none",
        cursor: "default",
      } as React.CSSProperties}
    >
      {/* ── Logo JGP ── */}
      <img
        src={jgpLogo}
        alt="JGP"
        style={{
          height: 22,
          width: "auto",
          opacity: 0.85,
          flexShrink: 0,
          pointerEvents: "none",
        }}
      />

      <Sep />

      {/* ── Badge REC / PAUSADO ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 8px 3px 6px",
          borderRadius: 8,
          background: accentDim,
          border: `1px solid ${accentColor}30`,
          flexShrink: 0,
        }}
      >
        {isPaused ? (
          <Pause size={10} color={accentColor} strokeWidth={2.5} />
        ) : (
          <span style={{ position: "relative", width: 8, height: 8, flexShrink: 0 }}>
            <span
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: "50%",
                background: accentColor,
                opacity: 0.5,
                animation: "ping 1.2s cubic-bezier(0,0,0.2,1) infinite",
              }}
            />
            <span
              style={{
                position: "relative",
                display: "block",
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: accentColor,
              }}
            />
          </span>
        )}
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.10em",
            color: accentColor,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          {isPaused ? "PAUSADO" : "REC"}
        </span>
      </div>

      {/* ── Timer ── */}
      <span
        style={{
          fontSize: 15,
          fontWeight: 600,
          fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', monospace",
          color: "rgba(255,255,255,0.90)",
          letterSpacing: "0.03em",
          flexShrink: 0,
          minWidth: 44,
        }}
      >
        {formatDuration(duration)}
      </span>

      <Sep />

      {/* ── Controles ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <CtrlBtn
          onClick={handleMute}
          title={micMuted ? "Desmutar microfone" : "Mutar microfone"}
          active={micMuted}
        >
          {micMuted ? <MicOff size={13} strokeWidth={2} /> : <Mic size={13} strokeWidth={2} />}
        </CtrlBtn>

        <CtrlBtn
          onClick={handlePause}
          title={isPaused ? "Retomar gravação" : "Pausar gravação"}
        >
          {isPaused
            ? <Play size={13} strokeWidth={2} />
            : <Pause size={13} strokeWidth={2} />}
        </CtrlBtn>

        <CtrlBtn onClick={handleStop} title="Parar gravação" danger>
          <Square size={11} strokeWidth={0} fill="currentColor" />
        </CtrlBtn>
      </div>
    </div>
  );
};
```

- [ ] **Step 3: Verify TypeScript**

```
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors in `ComplianceOverlay.tsx`. (There may be a pre-existing error in `TranscriptionPanel.tsx` about unused `index` — that is unrelated.)

- [ ] **Step 4: Commit**

```bash
git add src/assets/marca-jgp-white.png src/components/ComplianceOverlay.tsx
git commit -m "feat(overlay): redesign compliance window with JGP logo"
```
