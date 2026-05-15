# Mic Calibration Enhancements — Design Spec

## Goal

Three enhancements to the mic calibration wizard: (1) named calibration history with restore, (2) quick recalibration for threshold-only adjustment, (3) mic health badge during active recording.

---

## Architecture

Three independent features, each touching a small surface area:

1. **Calibration History** — persist up to 3 named snapshots in `AppSettings`; restore from `SettingsModal`
2. **Quick Recalibration** — single button in `SettingsModal` that measures ambient noise and adjusts `mic_silence_threshold` instantly
3. **Mic Health Badge** — color-coded mic icon in `MainPage`/`AudioIndicator` driven by existing `micLevel`

---

## Feature 1: Calibration History

### Data Model

Add to `AppSettings` (Rust and TypeScript):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalibrationSnapshot {
    pub name: String,
    pub created_at: String,          // ISO 8601
    pub mic_auto_gain: bool,
    pub mic_gain_max: f32,
    pub mic_silence_threshold: f32,
    pub noise_gate_enabled: bool,
    pub noise_gate_threshold: f32,
}
```

```rust
// In AppSettings:
#[serde(default)]
pub calibration_snapshots: Vec<CalibrationSnapshot>,
```

Max 3 snapshots. When saving a 4th, remove the oldest.

### Wizard Change

At the Summary screen, before "Aplicar configurações", show an optional text input: **"Salvar como perfil (opcional)"** with placeholder "ex: Escritório, Casa, Reunião fora". If filled, a snapshot is saved when the user clicks Apply.

### SettingsModal Change

In the mic section, below the calibration button, show saved snapshots as compact cards:

```
┌─────────────────────────────────┐
│ Escritório          12/05/2026  │
│                     [Restaurar] │
└─────────────────────────────────┘
```

"Restaurar" applies the snapshot's 5 fields immediately via `saveSettings` — no wizard, no confirmation.

---

## Feature 2: Quick Recalibration

### Button

In `SettingsModal`, next to "Calibrar microfone": button **"Ajuste rápido"**.

### Flow

1. Call existing `measure_ambient_noise` (2s measurement)
2. Compute new threshold: `silence_rms * 2.5`, clamped to `[0.001, 0.025]`
3. Apply immediately: `saveSettings({ ...settings, mic_silence_threshold: newThreshold })`
4. Show brief toast: `"Limiar de silêncio ajustado para o ambiente atual"`

Button shows a spinner during the 2s measurement. No modal opened. No snapshot saved.

### No new Tauri commands

Uses existing `measure_ambient_noise` which already returns `{ avg_rms }`.

---

## Feature 3: Mic Health Badge

### Location

Inside `AudioIndicator.tsx`, rendered only when `isRecording` is true.

### Data Source

`micLevel` prop (0.0–1.0) already available via `useAudioCapture`.

### States

| Condition | Color | Tooltip |
|---|---|---|
| `micLevel < 0.04` | Yellow | "Microfone muito baixo" |
| `0.04 ≤ micLevel ≤ 0.7` | Green | (none) |
| `micLevel > 0.7` | Red | "Microfone muito alto" |

Small mic icon (`🎤` or SVG) with color applied via Tailwind class. Tooltip on hover. Hidden when not recording.

---

## Files Modified

| File | Change |
|---|---|
| `src-tauri/src/storage.rs` | Add `CalibrationSnapshot` struct + `calibration_snapshots` field to `AppSettings` |
| `src/types.ts` (or inline) | Add `CalibrationSnapshot` TypeScript type |
| `src/components/MicCalibrationWizard.tsx` | Add optional name input at summary step; save snapshot on apply |
| `src/components/SettingsModal.tsx` | Show snapshot cards with Restore; add "Ajuste rápido" button |
| `src/components/AudioIndicator.tsx` | Add mic health badge driven by `micLevel` |
| `src/pages/MainPage.tsx` | Pass `micLevel` to `AudioIndicator` if not already |

---

## Out of Scope

- More than 3 snapshots
- Editing snapshot names after saving
- Snapshot export/import
- Health badge outside of recording state
