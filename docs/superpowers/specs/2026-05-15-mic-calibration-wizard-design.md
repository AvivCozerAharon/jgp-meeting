# Mic Calibration Wizard — Design Spec

## Goal

Replace the `MicTuner` component with a new adaptive `MicCalibrationWizard` that automatically configures microphone settings (gain, silence threshold, noise gate) through a guided test flow, then validates the result with a transcription accuracy check. Also rename technical labels in `SettingsModal` to plain language.

---

## Architecture

Five components/changes:

1. **`MicCalibrationWizard.tsx`** — new modal, replaces `MicTuner`. Runs adaptive calibration rounds (up to 3) + transcription validation. Calls existing Tauri commands extended with new calibration logic.
2. **`calibrate_microphone` Tauri command** — new Rust command that accepts a labeled recording type (`speech` or `silence`), measures audio metrics (RMS, peak, noise floor), and on `finalize` returns recommended `MicConfig` values.
3. **`test_mic_transcription_phrase` Tauri command** — new Rust command that records audio while the user reads a fixed phrase, transcribes it, and returns similarity score + diff.
4. **`SettingsModal.tsx`** — rename labels only. No logic change.
5. **`AppSettings` type** — no new fields; wizard writes to the same existing fields (`mic_auto_gain`, `mic_gain_max`, `mic_silence_threshold`, `noise_gate_*`).

---

## Wizard Flow

```
[Pre-check: 2s ambient measurement]
        ↓
  Noise too high? → Warning banner (user can proceed or abort)
        ↓
[Round N — up to 3 rounds]
  Step 1: Speech baseline (5s) — real-time level meter
  Step 2: Silence baseline (3s) — real-time level meter
  Evaluate: SNR adequate? → finalize  |  inadequate → adjust instructions, repeat
        ↓
[Finalize: compute recommended settings]
        ↓
[Transcription test]
  Show fixed phrase → user reads → transcribe → similarity check
  ≥ 85%: pass  |  < 85%: show diff, offer retry (max 2 retries) or skip
        ↓
[Summary: show what changed in plain language]
  Apply  |  Discard
```

### Adaptive round logic

After each speech+silence pair, the wizard evaluates:
- **SNR** (signal-to-noise ratio): `speech_rms / silence_rms`. Target ≥ 6.0.
- **Clipping**: `speech_peak > 0.95` → mic too close or gain too high.
- **Too quiet**: `speech_rms < 0.02` → mic too far or gain too low.

Instructions per failure mode:
- Low SNR (noisy environment): "O ambiente está muito barulhento. Tente se afastar de fontes de ruído ou aproximar o microfone."
- Clipping: "Você está muito perto do microfone. Recue um pouco e tente novamente."
- Too quiet: "Seu microfone está capturando pouco áudio. Aproxime-se ou fale um pouco mais alto."

Round 3 always finalizes regardless of SNR (best effort).

---

## Pre-check: Ambient Noise Warning

Before the wizard starts, the frontend triggers a silent 2s measurement via the existing `test_microphone` command. If `avg_rms > 0.015`, shows:

> "Detectamos ruído de fundo no seu ambiente agora. A calibração pode ser menos precisa. Recomendamos calibrar num ambiente mais silencioso."

Two buttons: **Continuar mesmo assim** / **Cancelar**.

---

## Real-time Level Meter

During speech and silence steps, the wizard subscribes to the existing `mic-test-level` Tauri event and renders a level bar:

- **Below green zone** (`rms < 0.04`): bar is yellow with label "muito baixo"
- **Green zone** (`0.04 ≤ rms ≤ 0.7`): bar is green with label "ideal"
- **Above green zone** (`rms > 0.7`): bar is red with label "muito alto"

The meter is the primary visual feedback during recording — the user knows immediately if they need to adjust position.

---

## Calibration Algorithm (Rust — `calibrate_microphone`)

**Input:** Two measurements — `speech` (avg_rms, peak, sample count) and `silence` (avg_rms).

**Output:** Recommended `MicConfig` values:

### Silence threshold
`recommended_threshold = silence_rms * 2.5`
Clamped to `[0.001, 0.025]`.

### Auto-gain and gain_max
- If `speech_rms ≥ 0.12`: `auto_gain = false`, `gain_max = 1.0` (already loud enough)
- If `speech_rms < 0.12`: `auto_gain = true`, `gain_max = clamp(0.18 / speech_rms, 1.5, 8.0)`

### Noise gate preset
Based on `silence_rms`:
- `< 0.003`: preset = "silent" (quiet room)
- `0.003–0.010`: preset = "meeting" (typical office)
- `> 0.010`: preset = "auditorium" (noisy environment)

---

## Transcription Test (Rust — `test_mic_transcription_phrase`)

**Fixed phrase (Portuguese):**
> "A reunião de alinhamento com o cliente começa às quatorze horas na sala de conferências."

Chosen because it contains: numbers, meeting vocabulary, proper nouns — representative of what the app transcribes daily.

**Process:**
1. Display phrase on screen; user clicks "Pronto para ler"
2. Record 6s with current (newly calibrated) mic settings
3. Transcribe via Whisper (same pipeline as normal transcription)
4. Compute similarity: normalized word-level edit distance (Levenshtein on word tokens, case-insensitive, diacritics-normalized)
5. Return: `{ similarity: f32, expected: String, got: String, passed: bool }`

**Failure diagnosis:**
Compare `got` vs `expected` to detect pattern:
- Most words present but wrong order/words → "Ruído de fundo interferindo — tente num ambiente mais silencioso"
- Very few words transcribed → "Áudio muito baixo — fale mais alto ou aproxime o microfone"
- Numbers wrong (e.g., "14" vs "quatorze") → not a failure (acceptable Whisper variation)
- `similarity < 0.85`: offer retry (max 2) or "Continuar mesmo assim"

---

## Summary Screen

After applying settings, show a plain-language diff. Only mention fields that actually changed:

| Changed field | Message shown |
|---|---|
| `mic_gain_max` increased | "Amplificamos seu microfone em Nx" |
| `auto_gain` enabled | "Amplificação automática ativada" |
| `mic_silence_threshold` changed | "Ajustamos o corte de silêncio para o seu ambiente" |
| noise gate preset changed | "Filtro de ruído ajustado para [ambiente silencioso / escritório / sala barulhenta]" |
| Nothing changed | "Suas configurações já estavam ótimas — nenhuma alteração necessária" |

Two CTAs: **Aplicar configurações** (saves and closes) / **Descartar** (reverts to snapshot, closes).

---

## Settings Snapshot

Before running any calibration, the wizard saves the current `MicConfig` values to a local ref. If the user discards, the original values are restored via `saveSettings`. This snapshot is session-only (not persisted to disk).

---

## Label Renames (SettingsModal.tsx)

| Current label | New label |
|---|---|
| Ganho automático (AGC) | Amplificação automática |
| Intensidade máxima do ganho | Nível máximo de amplificação |
| Sensibilidade do microfone | Cortar silêncios curtos |
| Noise gate | Filtrar ruído de fundo |
| Silencioso | Ambiente silencioso |
| Reunião | Escritório |
| Auditório | Sala barulhenta |
| Ajustar microfone (button) | Calibrar microfone |

---

## AppState additions (Rust)

Add a `CalibrationMetrics` struct held temporarily in `AppState` between wizard phases:

```rust
#[derive(Default)]
pub struct CalibrationMetrics {
    pub speech_rms: f32,
    pub speech_peak: f32,
    pub silence_rms: f32,
}
```

Added as `pub calibration: Mutex<CalibrationMetrics>` to `AppState`. Cleared when the wizard opens.

---

## New Tauri Commands

### `record_calibration_phase`

```rust
// Records one calibration phase, stores metrics in AppState.calibration.
// phase: "speech" (5s) | "silence" (3s)
// Emits mic-test-level events during recording for the level meter.
pub async fn record_calibration_phase(
    phase: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String>
```

### `compute_calibration`

```rust
// Reads stored CalibrationMetrics from AppState, computes recommended settings.
// Returns recommended values (does NOT save — frontend saves after user confirms).
pub async fn compute_calibration(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String>
```

Returns:
```json
{
  "mic_auto_gain": true,
  "mic_gain_max": 3.5,
  "mic_silence_threshold": 0.008,
  "noise_gate_preset": "meeting",
  "snr": 8.2,
  "round_passed": true,
  "failure_reason": null
}
```

### `test_mic_transcription_phrase`

```rust
// Records ~6s, transcribes, compares to fixed phrase, returns similarity + diff
pub async fn test_mic_transcription_phrase(app: AppHandle) -> Result<serde_json::Value, String>
```

Returns: `{ similarity: f32, expected: String, got: String, passed: bool, diagnosis: String }`

---

## Files Modified/Created

| File | Change |
|---|---|
| `src/components/MicCalibrationWizard.tsx` | New — replaces MicTuner |
| `src/components/SettingsModal.tsx` | Rename labels, swap MicTuner → MicCalibrationWizard |
| `src-tauri/src/commands.rs` | Add `calibrate_microphone` and `test_mic_transcription_phrase` |
| `src-tauri/src/main.rs` | Register new commands |

`MicTuner.tsx` is deleted (replaced by `MicCalibrationWizard`).

---

## Out of Scope

- Calibrating system audio (loopback) — only microphone
- Saving multiple calibration profiles
- Hot-plug device detection during the wizard
- macOS / Linux support (WASAPI-only)
