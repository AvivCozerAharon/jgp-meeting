# Mic Calibration Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `MicTuner` modal with an adaptive `MicCalibrationWizard` that automatically configures microphone gain, threshold, and noise gate through a guided speech+silence test flow, then validates with a transcription accuracy check against a fixed Portuguese phrase.

**Architecture:** Three new Rust commands (`measure_ambient_noise`, `record_calibration_phase`, `compute_calibration`, `test_mic_transcription_phrase`) store calibration metrics in `AppState` between phases. A new `MicCalibrationWizard` React component drives the multi-step wizard. `SettingsModal` label renames are pure text changes. `MicTuner.tsx` is deleted.

**Tech Stack:** Rust/Tauri 2, `parking_lot::Mutex`, React 18, TypeScript, Tailwind CSS, `lucide-react`

---

## File Map

| File | Change |
|------|--------|
| `src-tauri/src/commands.rs` | Add `CalibrationMetrics` to `AppState`; add 4 new commands |
| `src-tauri/src/main.rs` | Register new commands |
| `src/components/MicCalibrationWizard.tsx` | New — full wizard component |
| `src/components/MicTuner.tsx` | **Deleted** |
| `src/components/SettingsModal.tsx` | Replace MicTuner import/usage → MicCalibrationWizard; rename labels |

---

### Task 1: Add CalibrationMetrics to AppState + `measure_ambient_noise` + `record_calibration_phase`

**Files:**
- Modify: `src-tauri/src/commands.rs`

#### Background

`AppState` currently lives at line ~116 in `commands.rs`. It holds `capture_state`, `transcript`, `segments`, etc. We need to add a `CalibrationMetrics` field to store speech/silence measurements between wizard phases.

The existing `test_mic_with_transcription` command at line ~844 shows the full pattern for recording with level events: spin up a fresh `AudioCaptureState`, start capture, spawn a tokio task emitting `mic-test-level` every 50ms, sleep for duration, stop, drain chunks. We follow the same pattern.

- [ ] **Step 1: Add `CalibrationMetrics` struct and field to `AppState`**

In `src-tauri/src/commands.rs`, after the existing helper functions (around line 113, before the `pub struct AppState` block), add:

```rust
#[derive(Default, Clone)]
pub struct CalibrationMetrics {
    pub speech_rms: f32,
    pub speech_peak: f32,
    pub silence_rms: f32,
}
```

Then in `pub struct AppState { ... }` add one new field after `draining_meeting_id`:

```rust
pub calibration: Mutex<CalibrationMetrics>,
```

And in `impl AppState { pub fn new() -> Self { Self { ... } } }` add:

```rust
calibration: Mutex::new(CalibrationMetrics::default()),
```

- [ ] **Step 2: Add `measure_ambient_noise` command**

After the `test_microphone` command (around line 838), add:

```rust
/// Mede o ruído ambiente por 2 segundos sem filtros.
/// Usado pelo wizard de calibração para verificar o ambiente antes de começar.
#[tauri::command]
pub async fn measure_ambient_noise(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    use std::sync::atomic::Ordering;

    let settings = storage::load_settings().map_err(|e| e.to_string())?;
    let capture_state = Arc::new(AudioCaptureState::new());
    let (chunk_tx, chunk_rx) = mpsc::channel::<AudioChunk>();

    let mic_config = audio::MicConfig {
        enabled: true,
        device_id: settings.selected_microphone.clone(),
        silence_threshold: 0.0,
        auto_gain: false,
        gain_max: 1.0,
    };
    audio::start_capture(
        Arc::clone(&capture_state),
        chunk_tx,
        audio::SystemConfig {
            chunk_duration_secs: 1.0,
            silence_threshold: 0.0,
            auto_gain: false,
            gain_max: 1.0,
        },
        mic_config,
    )
    .map_err(|e| format!("Erro ao iniciar captura: {e}"))?;

    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    capture_state.is_capturing.store(false, Ordering::SeqCst);

    let mut rms_values: Vec<f32> = Vec::new();
    while let Ok(chunk) = chunk_rx.try_recv() {
        if chunk.source == AudioSource::Microphone && !chunk.samples.is_empty() {
            let rms = (chunk.samples.iter().map(|s| s * s).sum::<f32>()
                / chunk.samples.len() as f32)
                .sqrt();
            rms_values.push(rms);
        }
    }

    let avg_rms = if rms_values.is_empty() {
        0.0f32
    } else {
        rms_values.iter().sum::<f32>() / rms_values.len() as f32
    };

    // Reset calibration metrics at start of new wizard session
    *state.calibration.lock() = CalibrationMetrics::default();

    Ok(serde_json::json!({ "avg_rms": avg_rms }))
}
```

- [ ] **Step 3: Add `record_calibration_phase` command**

Immediately after `measure_ambient_noise`, add:

```rust
/// Grava uma fase de calibração (fala ou silêncio) e armazena as métricas em AppState.
/// Emite eventos `mic-test-level` a cada 50ms durante a gravação.
/// phase: "speech" (5s) | "silence" (3s)
#[tauri::command]
pub async fn record_calibration_phase(
    phase: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    use std::sync::atomic::Ordering;

    let settings = storage::load_settings().map_err(|e| e.to_string())?;
    let duration_secs: u64 = if phase == "speech" { 5 } else { 3 };

    let capture_state = Arc::new(AudioCaptureState::new());
    capture_state.is_capturing.store(true, Ordering::SeqCst);
    let (chunk_tx, chunk_rx) = mpsc::channel::<AudioChunk>();

    let mic_config = audio::MicConfig {
        enabled: true,
        device_id: settings.selected_microphone.clone(),
        silence_threshold: 0.0,
        auto_gain: false,
        gain_max: 1.0,
    };
    audio::start_capture(
        Arc::clone(&capture_state),
        chunk_tx,
        audio::SystemConfig {
            chunk_duration_secs: 1.0,
            silence_threshold: 0.0,
            auto_gain: false,
            gain_max: 1.0,
        },
        mic_config,
    )
    .map_err(|e| format!("Erro ao iniciar captura: {e}"))?;

    let cap_emit = Arc::clone(&capture_state);
    let app_emit = app.clone();
    let level_handle = tokio::spawn(async move {
        while cap_emit.is_capturing() {
            let level = *cap_emit.mic_level.lock();
            let _ = app_emit.emit("mic-test-level", level);
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    });

    tokio::time::sleep(std::time::Duration::from_secs(duration_secs)).await;
    capture_state.is_capturing.store(false, Ordering::SeqCst);
    let _ = level_handle.await;

    let mut rms_values: Vec<f32> = Vec::new();
    let mut peak: f32 = 0.0;
    while let Ok(chunk) = chunk_rx.try_recv() {
        if chunk.source == AudioSource::Microphone && !chunk.samples.is_empty() {
            let rms = (chunk.samples.iter().map(|s| s * s).sum::<f32>()
                / chunk.samples.len() as f32)
                .sqrt();
            let chunk_peak = chunk.samples.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
            rms_values.push(rms);
            peak = peak.max(chunk_peak);
        }
    }

    let avg_rms = if rms_values.is_empty() {
        0.0f32
    } else {
        rms_values.iter().sum::<f32>() / rms_values.len() as f32
    };

    {
        let mut cal = state.calibration.lock();
        if phase == "speech" {
            cal.speech_rms = avg_rms;
            cal.speech_peak = peak;
        } else {
            cal.silence_rms = avg_rms;
        }
    }

    Ok(serde_json::json!({
        "avg_rms": avg_rms,
        "peak": peak,
        "phase": phase,
    }))
}
```

- [ ] **Step 4: Build to verify**

```bash
cd src-tauri && cargo build 2>&1 | grep "^error" | head -10
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(calibration): add CalibrationMetrics to AppState + measure_ambient_noise + record_calibration_phase"
```

---

### Task 2: Add `compute_calibration` + `test_mic_transcription_phrase` commands

**Files:**
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: Add `compute_calibration` command**

After `record_calibration_phase`, add:

```rust
/// Lê as métricas de calibração armazenadas no AppState e calcula as configurações recomendadas.
/// Retorna os valores recomendados — NÃO salva (o frontend salva após confirmação do usuário).
#[tauri::command]
pub async fn compute_calibration(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let cal = state.calibration.lock().clone();

    let speech_rms = cal.speech_rms;
    let speech_peak = cal.speech_peak;
    let silence_rms = cal.silence_rms;

    // SNR: quanto a fala se destaca do ruído
    let snr = if silence_rms > 0.0001 {
        speech_rms / silence_rms
    } else {
        99.0 // ambiente perfeitamente silencioso
    };

    // Determina falha e instrução adaptativa
    let (round_passed, failure_reason) = if speech_peak > 0.95 {
        (false, Some("Clipping detectado — você está muito perto do microfone. Recue um pouco e tente novamente."))
    } else if speech_rms < 0.02 {
        (false, Some("Microfone muito baixo — fale mais alto ou aproxime-se do microfone."))
    } else if snr < 6.0 {
        (false, Some("Muito ruído de fundo — tente se afastar de fontes de ruído ou aproximar o microfone."))
    } else {
        (true, None)
    };

    // Silence threshold: 2.5x o ruído de fundo, clamped
    let recommended_threshold = (silence_rms * 2.5).clamp(0.001, 0.025);

    // Auto-gain
    let (auto_gain, gain_max) = if speech_rms >= 0.12 {
        (false, 1.0f32)
    } else {
        let gmax = (0.18 / speech_rms.max(0.001)).clamp(1.5, 8.0);
        (true, gmax)
    };

    // Noise gate preset
    let noise_gate_preset = if silence_rms < 0.003 {
        "silent"
    } else if silence_rms <= 0.010 {
        "meeting"
    } else {
        "auditorium"
    };

    let (noise_gate_ratio, noise_gate_hold) = match noise_gate_preset {
        "silent"     => (0.0f32, 0.3f32),
        "meeting"    => (3.0f32, 0.4f32),
        _            => (6.0f32, 0.6f32),
    };

    Ok(serde_json::json!({
        "mic_auto_gain": auto_gain,
        "mic_gain_max": (gain_max * 10.0).round() / 10.0,
        "mic_silence_threshold": (recommended_threshold * 10000.0).round() / 10000.0,
        "noise_gate_preset": noise_gate_preset,
        "mic_noise_gate_ratio": noise_gate_ratio,
        "mic_noise_gate_hold_secs": noise_gate_hold,
        "snr": (snr * 10.0).round() / 10.0,
        "round_passed": round_passed,
        "failure_reason": failure_reason,
        "speech_rms": (speech_rms * 10000.0).round() / 10000.0,
        "silence_rms": (silence_rms * 10000.0).round() / 10000.0,
    }))
}
```

- [ ] **Step 2: Add word similarity helper function**

Before `compute_calibration`, add this private helper (not a Tauri command):

```rust
fn word_similarity(a: &str, b: &str) -> f32 {
    use std::collections::HashSet;
    let normalize = |s: &str| -> HashSet<String> {
        s.chars()
            .filter(|c| c.is_alphanumeric() || c.is_whitespace())
            .collect::<String>()
            .split_whitespace()
            .map(|w| w.to_lowercase())
            .collect()
    };
    let a_words = normalize(a);
    let b_words = normalize(b);
    if a_words.is_empty() && b_words.is_empty() {
        return 1.0;
    }
    if a_words.is_empty() || b_words.is_empty() {
        return 0.0;
    }
    let intersection = a_words.intersection(&b_words).count() as f32;
    let union = a_words.union(&b_words).count() as f32;
    intersection / union
}
```

- [ ] **Step 3: Add `test_mic_transcription_phrase` command**

After `compute_calibration`, add:

```rust
/// Grava 6 segundos com as configurações recomendadas, transcreve e compara com a frase fixa.
/// O frontend passa os valores recomendados (ainda não salvos) para usar no teste.
#[tauri::command]
pub async fn test_mic_transcription_phrase(
    app: AppHandle,
    auto_gain: bool,
    gain_max: f32,
    silence_threshold: f32,
) -> Result<serde_json::Value, String> {
    use std::sync::atomic::Ordering;

    const EXPECTED: &str = "A reunião de alinhamento com o cliente começa às quatorze horas na sala de conferências";

    let settings = storage::load_settings().map_err(|e| e.to_string())?;

    if settings.transcription_provider == "openai" && settings.openai_api_key.is_empty() {
        return Err("Chave da API OpenAI não configurada.".into());
    }
    if settings.transcription_provider == "groq" && settings.groq_api_key.is_empty() {
        return Err("Chave da API Groq não configurada.".into());
    }

    let capture_state = Arc::new(AudioCaptureState::new());
    capture_state.is_capturing.store(true, Ordering::SeqCst);
    let (chunk_tx, chunk_rx) = mpsc::channel::<AudioChunk>();

    let mic_config = audio::MicConfig {
        enabled: true,
        device_id: settings.selected_microphone.clone(),
        silence_threshold,
        auto_gain,
        gain_max,
    };
    audio::start_capture(
        Arc::clone(&capture_state),
        chunk_tx,
        audio::SystemConfig {
            chunk_duration_secs: 1.0,
            silence_threshold: 0.0,
            auto_gain: false,
            gain_max: 1.0,
        },
        mic_config,
    )
    .map_err(|e| format!("Erro ao iniciar captura: {e}"))?;

    let cap_emit = Arc::clone(&capture_state);
    let app_emit = app.clone();
    let level_handle = tokio::spawn(async move {
        while cap_emit.is_capturing() {
            let level = *cap_emit.mic_level.lock();
            let _ = app_emit.emit("mic-test-level", level);
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    });

    tokio::time::sleep(std::time::Duration::from_secs(6)).await;
    capture_state.is_capturing.store(false, Ordering::SeqCst);
    let _ = level_handle.await;

    let mut all_samples: Vec<f32> = Vec::new();
    let mut sample_rate = 48000u32;
    let mut channels = 1u16;

    while let Ok(chunk) = chunk_rx.try_recv() {
        if chunk.source == AudioSource::Microphone && !chunk.samples.is_empty() {
            sample_rate = chunk.sample_rate;
            channels = chunk.channels;
            all_samples.extend_from_slice(&chunk.samples);
        }
    }

    if all_samples.is_empty() {
        return Ok(serde_json::json!({
            "similarity": 0.0,
            "expected": EXPECTED,
            "got": "",
            "passed": false,
            "diagnosis": "Nenhum áudio capturado. Verifique se o microfone está funcionando.",
        }));
    }

    let wav_bytes = build_wav_from_samples(&all_samples, sample_rate, channels)
        .map_err(|e| format!("Erro ao gerar WAV: {e}"))?;

    let glossary_part: Option<String> = {
        let terms: Vec<&str> = settings.whisper_glossary
            .split([',', '\n'])
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if terms.is_empty() { None } else { Some(terms.join(", ")) }
    };
    let effective_prompt = match (glossary_part, settings.whisper_prompt.is_empty()) {
        (None, true) => None,
        (None, false) => Some(settings.whisper_prompt.clone()),
        (Some(g), true) => Some(g),
        (Some(g), false) => Some(format!("{} {}", g, settings.whisper_prompt)),
    };
    let prompt_opt = effective_prompt.as_deref();
    let lang = if settings.transcription_language.is_empty() {
        None
    } else {
        Some(settings.transcription_language.as_str())
    };

    let transcript = match settings.transcription_provider.as_str() {
        "groq" => transcription::transcribe_groq(wav_bytes, &settings.groq_api_key, lang, prompt_opt).await,
        _ => transcription::transcribe_audio(wav_bytes, &settings.openai_api_key, lang, prompt_opt).await,
    }
    .map(|t| t.trim().to_string())
    .unwrap_or_default();

    let similarity = word_similarity(EXPECTED, &transcript);
    let passed = similarity >= 0.85;

    let word_count = transcript.split_whitespace().count();
    let expected_count = EXPECTED.split_whitespace().count();
    let diagnosis = if word_count < 3 {
        "Áudio muito baixo — fale mais alto ou aproxime o microfone"
    } else if word_count < expected_count / 2 {
        "Ruído de fundo interferindo — tente num ambiente mais silencioso"
    } else {
        "Fala diferente do esperado — tente falar mais devagar e claramente"
    };

    Ok(serde_json::json!({
        "similarity": (similarity * 100.0).round() / 100.0,
        "expected": EXPECTED,
        "got": transcript,
        "passed": passed,
        "diagnosis": if passed { "" } else { diagnosis },
    }))
}
```

- [ ] **Step 4: Build to verify**

```bash
cd src-tauri && cargo build 2>&1 | grep "^error" | head -10
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(calibration): add compute_calibration and test_mic_transcription_phrase"
```

---

### Task 3: Register new commands in main.rs

**Files:**
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Register all four new commands**

In `src-tauri/src/main.rs`, find the `invoke_handler` block. After the `commands::test_mic_with_transcription,` line, add:

```rust
            // Wizard de calibração de microfone
            commands::measure_ambient_noise,
            commands::record_calibration_phase,
            commands::compute_calibration,
            commands::test_mic_transcription_phrase,
```

- [ ] **Step 2: Build to verify**

```bash
cd src-tauri && cargo build 2>&1 | grep "^error" | head -10
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/main.rs
git commit -m "feat(calibration): register calibration commands in main.rs"
```

---

### Task 4: Create MicCalibrationWizard component

**Files:**
- Create: `src/components/MicCalibrationWizard.tsx`

#### Background

`MicLevelMeter` component already exists at `src/components/MicLevelMeter.tsx` — import and use it. `AppSettings` type is at `src/types/index.ts`. Pattern for listening to Tauri events: `listen<number>("mic-test-level", cb)` returning `UnlistenFn` — same as in `MicTuner.tsx`.

The wizard has these steps in order:
1. `pre-check` — auto-runs 2s ambient measurement on mount
2. `ambient-warning` — shown only if ambient rms > 0.015
3. `speech` — user clicks "Pronto", 3s countdown, then 5s recording
4. `silence` — auto-starts 3s recording after speech completes
5. `computing` — calls `compute_calibration`
6. `round-failed` — shown if round_passed=false, up to 3 rounds total
7. `transcription-ready` — show phrase, user clicks "Pronto para ler"
8. `transcription-recording` — 6s recording with level meter
9. `transcription-result` — pass/fail with diff, retry option
10. `summary` — plain-language changes, Apply/Discard buttons

- [ ] **Step 1: Create `src/components/MicCalibrationWizard.tsx`**

```tsx
import { useState, useEffect, useCallback, useRef } from "react";
import clsx from "clsx";
import {
  X, Mic, CheckCircle2, AlertCircle, AlertTriangle,
  ChevronRight, RotateCcw, Loader2, Volume2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppSettings } from "@/types";
import { MicLevelMeter } from "./MicLevelMeter";

interface MicCalibrationWizardProps {
  settings: AppSettings;
  onApply: (patch: Partial<AppSettings>) => void;
  onClose: () => void;
}

interface CalibrationResult {
  mic_auto_gain: boolean;
  mic_gain_max: number;
  mic_silence_threshold: number;
  noise_gate_preset: "silent" | "meeting" | "auditorium";
  mic_noise_gate_ratio: number;
  mic_noise_gate_hold_secs: number;
  snr: number;
  round_passed: boolean;
  failure_reason: string | null;
}

interface TranscriptionResult {
  similarity: number;
  expected: string;
  got: string;
  passed: boolean;
  diagnosis: string;
}

const PRESET_LABELS: Record<string, string> = {
  silent: "Ambiente silencioso",
  meeting: "Escritório",
  auditorium: "Sala barulhenta",
};

const COUNTDOWN_SECS = 3;

type Step =
  | "pre-check"
  | "ambient-warning"
  | "speech-ready"
  | "speech-countdown"
  | "speech-recording"
  | "silence-recording"
  | "computing"
  | "round-failed"
  | "transcription-ready"
  | "transcription-recording"
  | "transcription-result"
  | "summary"
  | "error";

export function MicCalibrationWizard({ settings, onApply, onClose }: MicCalibrationWizardProps) {
  const [step, setStep] = useState<Step>("pre-check");
  const [micLevel, setMicLevel] = useState(0);
  const [countdown, setCountdown] = useState(COUNTDOWN_SECS);
  const [round, setRound] = useState(1);
  const [speechInstructions, setSpeechInstructions] = useState(
    "Fale normalmente por 5 segundos — conte o que você está fazendo hoje, por exemplo."
  );
  const [ambientRms, setAmbientRms] = useState(0);
  const [calibration, setCalibration] = useState<CalibrationResult | null>(null);
  const [transcription, setTranscription] = useState<TranscriptionResult | null>(null);
  const [transcriptionRetries, setTranscriptionRetries] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const subscribeToLevel = useCallback(async () => {
    if (unlistenRef.current) unlistenRef.current();
    unlistenRef.current = await listen<number>("mic-test-level", (e) =>
      setMicLevel(e.payload)
    );
  }, []);

  const clearCountdown = useCallback(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (unlistenRef.current) unlistenRef.current();
      clearCountdown();
    };
  }, [clearCountdown]);

  // Step: pre-check — auto-run on mount
  useEffect(() => {
    if (step !== "pre-check") return;
    invoke<{ avg_rms: number }>("measure_ambient_noise")
      .then(({ avg_rms }) => {
        setAmbientRms(avg_rms);
        if (avg_rms > 0.015) {
          setStep("ambient-warning");
        } else {
          setStep("speech-ready");
        }
      })
      .catch((e) => {
        setErrorMsg(String(e));
        setStep("error");
      });
  }, [step]);

  // Step: speech-countdown
  useEffect(() => {
    if (step !== "speech-countdown") return;
    setCountdown(COUNTDOWN_SECS);
    let current = COUNTDOWN_SECS;
    countdownRef.current = setInterval(() => {
      current -= 1;
      setCountdown(current);
      if (current <= 0) {
        clearCountdown();
        setStep("speech-recording");
      }
    }, 1000);
    return clearCountdown;
  }, [step, clearCountdown]);

  // Step: speech-recording
  useEffect(() => {
    if (step !== "speech-recording") return;
    setMicLevel(0);
    subscribeToLevel().then(() => {
      invoke("record_calibration_phase", { phase: "speech" })
        .then(() => setStep("silence-recording"))
        .catch((e) => { setErrorMsg(String(e)); setStep("error"); });
    });
  }, [step, subscribeToLevel]);

  // Step: silence-recording
  useEffect(() => {
    if (step !== "silence-recording") return;
    setMicLevel(0);
    invoke("record_calibration_phase", { phase: "silence" })
      .then(() => setStep("computing"))
      .catch((e) => { setErrorMsg(String(e)); setStep("error"); });
  }, [step]);

  // Step: computing
  useEffect(() => {
    if (step !== "computing") return;
    invoke<CalibrationResult>("compute_calibration")
      .then((result) => {
        setCalibration(result);
        if (result.round_passed || round >= 3) {
          setStep("transcription-ready");
        } else {
          setStep("round-failed");
          if (result.failure_reason) {
            setSpeechInstructions(result.failure_reason);
          }
        }
      })
      .catch((e) => { setErrorMsg(String(e)); setStep("error"); });
  }, [step, round]);

  // Step: transcription-recording
  useEffect(() => {
    if (step !== "transcription-recording" || !calibration) return;
    setMicLevel(0);
    subscribeToLevel().then(() => {
      invoke<TranscriptionResult>("test_mic_transcription_phrase", {
        autoGain: calibration.mic_auto_gain,
        gainMax: calibration.mic_gain_max,
        silenceThreshold: calibration.mic_silence_threshold,
      })
        .then((result) => {
          setTranscription(result);
          setStep("transcription-result");
        })
        .catch((e) => { setErrorMsg(String(e)); setStep("error"); });
    });
  }, [step, calibration, subscribeToLevel]);

  const handleStartSpeech = useCallback(() => {
    setStep("speech-countdown");
  }, []);

  const handleRetryRound = useCallback(() => {
    setRound((r) => r + 1);
    setStep("speech-ready");
  }, []);

  const handleRetryTranscription = useCallback(() => {
    setTranscriptionRetries((r) => r + 1);
    setTranscription(null);
    setStep("transcription-ready");
  }, []);

  const handleApply = useCallback(() => {
    if (!calibration) return;
    onApply({
      mic_auto_gain: calibration.mic_auto_gain,
      mic_gain_max: calibration.mic_gain_max,
      mic_silence_threshold: calibration.mic_silence_threshold,
      mic_noise_gate_ratio: calibration.mic_noise_gate_ratio,
      mic_noise_gate_hold_secs: calibration.mic_noise_gate_hold_secs,
    });
    onClose();
  }, [calibration, onApply, onClose]);

  const isRecording =
    step === "speech-recording" ||
    step === "silence-recording" ||
    step === "transcription-recording";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white dark:bg-surface-900 rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-surface-100 dark:border-surface-800">
          <div className="flex items-center gap-2">
            <Mic className="w-5 h-5 text-primary-500" />
            <h2 className="text-base font-bold text-surface-900 dark:text-surface-100">
              Calibrar Microfone
            </h2>
          </div>
          {!isRecording && (
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
            >
              <X className="w-4 h-4 text-surface-500" />
            </button>
          )}
        </div>

        <div className="p-5 space-y-5">
          {/* Progress dots */}
          {step !== "pre-check" && step !== "error" && (
            <div className="flex items-center justify-center gap-2">
              {(["speech-ready", "speech-countdown", "speech-recording", "silence-recording", "computing", "round-failed"] as Step[]).some(s => s === step || step === "speech-ready") && (
                <>
                  <StepDot active={["speech-ready","speech-countdown","speech-recording","silence-recording","computing","round-failed"].includes(step)} done={["transcription-ready","transcription-recording","transcription-result","summary"].includes(step)} label="Calibração" />
                  <div className="w-8 h-px bg-surface-200 dark:bg-surface-700" />
                  <StepDot active={["transcription-ready","transcription-recording","transcription-result"].includes(step)} done={step === "summary"} label="Teste de voz" />
                  <div className="w-8 h-px bg-surface-200 dark:bg-surface-700" />
                  <StepDot active={step === "summary"} done={false} label="Resultado" />
                </>
              )}
            </div>
          )}

          {/* ── pre-check ── */}
          {step === "pre-check" && (
            <div className="text-center py-4">
              <Loader2 className="w-8 h-8 text-primary-500 animate-spin mx-auto mb-3" />
              <p className="text-sm font-medium text-surface-700 dark:text-surface-300">
                Verificando o ambiente...
              </p>
            </div>
          )}

          {/* ── ambient-warning ── */}
          {step === "ambient-warning" && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 bg-yellow-50 dark:bg-yellow-500/10 border border-yellow-200 dark:border-yellow-500/20 rounded-xl">
                <AlertTriangle className="w-5 h-5 text-yellow-500 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-yellow-800 dark:text-yellow-300">
                    Ambiente barulhento detectado
                  </p>
                  <p className="text-xs text-yellow-700 dark:text-yellow-400 mt-1">
                    Detectamos ruído de fundo no seu ambiente agora. A calibração pode ser menos precisa. Recomendamos calibrar num ambiente mais silencioso.
                  </p>
                </div>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setStep("speech-ready")}
                  className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold bg-primary-500 text-white hover:bg-primary-600 transition-all"
                >
                  Continuar mesmo assim
                </button>
                <button
                  onClick={onClose}
                  className="px-4 py-2.5 rounded-xl text-sm font-medium border border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-300 hover:bg-surface-50 dark:hover:bg-surface-800 transition-all"
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}

          {/* ── speech-ready ── */}
          {step === "speech-ready" && (
            <div className="space-y-4">
              {round > 1 && (
                <div className="flex items-start gap-2 p-3 bg-yellow-50 dark:bg-yellow-500/10 border border-yellow-200 dark:border-yellow-500/20 rounded-xl">
                  <AlertTriangle className="w-4 h-4 text-yellow-500 mt-0.5 flex-shrink-0" />
                  <p className="text-xs text-yellow-700 dark:text-yellow-400">{speechInstructions}</p>
                </div>
              )}
              <div className="p-4 bg-surface-50 dark:bg-surface-800/40 rounded-xl border border-surface-100 dark:border-surface-700/50">
                <p className="text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wider mb-1">
                  Rodada {round} de 3 — Fala
                </p>
                <p className="text-sm text-surface-700 dark:text-surface-300 leading-relaxed">
                  {round === 1
                    ? "Fale normalmente por 5 segundos — conte o que você está fazendo hoje, por exemplo."
                    : speechInstructions}
                </p>
              </div>
              <button
                onClick={handleStartSpeech}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold bg-primary-500 text-white hover:bg-primary-600 transition-all shadow-sm active:scale-[0.98]"
              >
                <Mic className="w-4 h-4" />
                Pronto para falar
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* ── speech-countdown ── */}
          {step === "speech-countdown" && (
            <div className="text-center py-4 space-y-3">
              <div className="text-5xl font-bold text-primary-500">{countdown}</div>
              <p className="text-sm text-surface-500 dark:text-surface-400">Prepare-se para falar...</p>
            </div>
          )}

          {/* ── speech-recording ── */}
          {step === "speech-recording" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Mic className="w-4 h-4 text-primary-500 animate-pulse" />
                <p className="text-sm font-semibold text-surface-700 dark:text-surface-300">
                  Gravando sua fala... (5s)
                </p>
              </div>
              <MicLevelMeter level={micLevel} className="p-3 rounded-xl bg-surface-50 dark:bg-surface-800/40 border border-surface-100 dark:border-surface-700/50" />
              <LevelZoneHint level={micLevel} />
            </div>
          )}

          {/* ── silence-recording ── */}
          {step === "silence-recording" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Volume2 className="w-4 h-4 text-surface-400 animate-pulse" />
                <p className="text-sm font-semibold text-surface-700 dark:text-surface-300">
                  Agora fique em silêncio... (3s)
                </p>
              </div>
              <MicLevelMeter level={micLevel} className="p-3 rounded-xl bg-surface-50 dark:bg-surface-800/40 border border-surface-100 dark:border-surface-700/50" />
            </div>
          )}

          {/* ── computing ── */}
          {step === "computing" && (
            <div className="text-center py-4">
              <Loader2 className="w-8 h-8 text-primary-500 animate-spin mx-auto mb-3" />
              <p className="text-sm font-medium text-surface-700 dark:text-surface-300">
                Calculando as melhores configurações...
              </p>
            </div>
          )}

          {/* ── round-failed ── */}
          {step === "round-failed" && calibration && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 bg-orange-50 dark:bg-orange-500/10 border border-orange-200 dark:border-orange-500/20 rounded-xl">
                <AlertTriangle className="w-5 h-5 text-orange-500 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-orange-800 dark:text-orange-300">
                    Precisamos tentar de novo
                  </p>
                  <p className="text-xs text-orange-700 dark:text-orange-400 mt-1">
                    {calibration.failure_reason}
                  </p>
                </div>
              </div>
              <p className="text-xs text-surface-500 dark:text-surface-400 text-center">
                Tentativa {round} de 3
              </p>
              <button
                onClick={handleRetryRound}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold bg-primary-500 text-white hover:bg-primary-600 transition-all"
              >
                <RotateCcw className="w-4 h-4" />
                Tentar de novo
              </button>
            </div>
          )}

          {/* ── transcription-ready ── */}
          {step === "transcription-ready" && (
            <div className="space-y-4">
              <div className="p-4 bg-surface-50 dark:bg-surface-800/40 rounded-xl border border-surface-100 dark:border-surface-700/50">
                <p className="text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wider mb-2">
                  Leia esta frase em voz alta
                </p>
                <p className="text-base font-medium text-surface-800 dark:text-surface-100 leading-relaxed">
                  "A reunião de alinhamento com o cliente começa às quatorze horas na sala de conferências."
                </p>
              </div>
              <p className="text-xs text-surface-500 dark:text-surface-400 text-center">
                Clique quando estiver pronto. Você terá 6 segundos para ler.
              </p>
              <button
                onClick={() => setStep("transcription-recording")}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold bg-primary-500 text-white hover:bg-primary-600 transition-all shadow-sm active:scale-[0.98]"
              >
                <Mic className="w-4 h-4" />
                Pronto para ler
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* ── transcription-recording ── */}
          {step === "transcription-recording" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Mic className="w-4 h-4 text-primary-500 animate-pulse" />
                <p className="text-sm font-semibold text-surface-700 dark:text-surface-300">
                  Gravando... leia a frase agora (6s)
                </p>
              </div>
              <div className="p-3 bg-primary-50 dark:bg-primary-500/10 rounded-xl border border-primary-100 dark:border-primary-500/20">
                <p className="text-sm font-medium text-primary-800 dark:text-primary-200 leading-relaxed">
                  "A reunião de alinhamento com o cliente começa às quatorze horas na sala de conferências."
                </p>
              </div>
              <MicLevelMeter level={micLevel} className="p-3 rounded-xl bg-surface-50 dark:bg-surface-800/40 border border-surface-100 dark:border-surface-700/50" />
            </div>
          )}

          {/* ── transcription-result ── */}
          {step === "transcription-result" && transcription && (
            <div className="space-y-4">
              {transcription.passed ? (
                <div className="flex items-start gap-3 p-4 bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 rounded-xl">
                  <CheckCircle2 className="w-5 h-5 text-emerald-500 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">
                      Microfone configurado com sucesso ✓
                    </p>
                    <p className="text-xs text-emerald-700 dark:text-emerald-400 mt-1">
                      {Math.round(transcription.similarity * 100)}% de precisão na transcrição.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3 p-4 bg-yellow-50 dark:bg-yellow-500/10 border border-yellow-200 dark:border-yellow-500/20 rounded-xl">
                  <AlertTriangle className="w-5 h-5 text-yellow-500 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-yellow-800 dark:text-yellow-300">
                      Transcrição parcial ({Math.round(transcription.similarity * 100)}%)
                    </p>
                    <p className="text-xs text-yellow-700 dark:text-yellow-400 mt-1">
                      {transcription.diagnosis}
                    </p>
                  </div>
                </div>
              )}

              {transcription.got && (
                <div className="p-3 rounded-xl bg-surface-50 dark:bg-surface-800/40 border border-surface-100 dark:border-surface-700/50">
                  <p className="text-[10px] uppercase tracking-wider font-semibold text-surface-400 mb-1">
                    O que foi transcrito
                  </p>
                  <p className="text-sm text-surface-700 dark:text-surface-200 italic leading-relaxed">
                    "{transcription.got}"
                  </p>
                </div>
              )}

              <div className="flex gap-3">
                {!transcription.passed && transcriptionRetries < 2 && (
                  <button
                    onClick={handleRetryTranscription}
                    className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-medium border border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-300 hover:bg-surface-50 dark:hover:bg-surface-800 transition-all"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Tentar de novo
                  </button>
                )}
                <button
                  onClick={() => setStep("summary")}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-primary-500 text-white hover:bg-primary-600 transition-all"
                >
                  {transcription.passed ? "Ver resumo" : "Continuar mesmo assim"}
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* ── summary ── */}
          {step === "summary" && calibration && (
            <div className="space-y-4">
              <p className="text-sm font-semibold text-surface-800 dark:text-surface-100">
                Resumo das alterações
              </p>
              <SummaryDiff current={settings} recommended={calibration} />
              <div className="flex gap-3 pt-2">
                <button
                  onClick={onClose}
                  className="px-4 py-2.5 rounded-xl text-sm font-medium border border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-300 hover:bg-surface-50 dark:hover:bg-surface-800 transition-all"
                >
                  Descartar
                </button>
                <button
                  onClick={handleApply}
                  className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold bg-primary-500 text-white hover:bg-primary-600 transition-all shadow-sm"
                >
                  Aplicar configurações
                </button>
              </div>
            </div>
          )}

          {/* ── error ── */}
          {step === "error" && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl">
                <AlertCircle className="w-5 h-5 text-red-500 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-red-800 dark:text-red-300">Erro</p>
                  <p className="text-xs text-red-700 dark:text-red-400 mt-1">{errorMsg}</p>
                </div>
              </div>
              <button
                onClick={() => { setStep("pre-check"); setRound(1); }}
                className="w-full px-4 py-2.5 rounded-xl text-sm font-semibold bg-primary-500 text-white hover:bg-primary-600 transition-all"
              >
                Tentar novamente
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function StepDot({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className={clsx(
        "w-2.5 h-2.5 rounded-full transition-colors",
        done ? "bg-emerald-500" : active ? "bg-primary-500" : "bg-surface-200 dark:bg-surface-700"
      )} />
      <span className={clsx(
        "text-[9px] font-medium",
        active ? "text-primary-500" : done ? "text-emerald-500" : "text-surface-400"
      )}>
        {label}
      </span>
    </div>
  );
}

function LevelZoneHint({ level }: { level: number }) {
  const zone = level < 0.04 ? "low" : level > 0.7 ? "high" : "ideal";
  if (zone === "ideal") return null;
  return (
    <p className={clsx(
      "text-xs text-center font-medium",
      zone === "low" ? "text-yellow-600 dark:text-yellow-400" : "text-red-600 dark:text-red-400"
    )}>
      {zone === "low" ? "Muito baixo — fale mais alto ou aproxime-se" : "Muito alto — afaste-se do microfone"}
    </p>
  );
}

function SummaryDiff({
  current,
  recommended,
}: {
  current: AppSettings;
  recommended: CalibrationResult;
}) {
  const lines: string[] = [];

  if (recommended.mic_auto_gain && !current.mic_auto_gain) {
    lines.push("Amplificação automática ativada");
  } else if (!recommended.mic_auto_gain && current.mic_auto_gain) {
    lines.push("Amplificação automática desativada (microfone já está alto o suficiente)");
  }

  if (recommended.mic_auto_gain && recommended.mic_gain_max !== current.mic_gain_max) {
    const ratio = (recommended.mic_gain_max / (current.mic_gain_max || 1)).toFixed(1);
    if (recommended.mic_gain_max > (current.mic_gain_max ?? 4)) {
      lines.push(`Amplificamos seu microfone (nível máximo: ${recommended.mic_gain_max.toFixed(1)}×)`);
    } else {
      lines.push(`Reduzimos a amplificação (nível máximo: ${recommended.mic_gain_max.toFixed(1)}×)`);
    }
  }

  if (Math.abs(recommended.mic_silence_threshold - (current.mic_silence_threshold ?? 0.003)) > 0.0005) {
    lines.push("Corte de silêncio ajustado para o seu ambiente");
  }

  const currentPreset = current.mic_noise_gate_ratio === 0 ? "silent"
    : current.mic_noise_gate_ratio <= 3 ? "meeting" : "auditorium";
  if (recommended.noise_gate_preset !== currentPreset) {
    lines.push(`Filtro de ruído ajustado: ${PRESET_LABELS[recommended.noise_gate_preset]}`);
  }

  if (lines.length === 0) {
    lines.push("Suas configurações já estavam ótimas — nenhuma alteração necessária");
  }

  return (
    <ul className="space-y-2">
      {lines.map((line, i) => (
        <li key={i} className="flex items-start gap-2 text-sm text-surface-700 dark:text-surface-300">
          <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
          {line}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors in `MicCalibrationWizard.tsx`. Common fix: if `AppSettings` fields like `mic_noise_gate_ratio` are `number | undefined`, add `?? 0` comparisons.

- [ ] **Step 3: Commit**

```bash
git add src/components/MicCalibrationWizard.tsx
git commit -m "feat(calibration): add MicCalibrationWizard component"
```

---

### Task 5: Update SettingsModal — rename labels, swap wizard, delete MicTuner

**Files:**
- Modify: `src/components/SettingsModal.tsx`
- Delete: `src/components/MicTuner.tsx`

#### Background

`SettingsModal.tsx` currently:
- Imports `MicTuner` at line ~39
- Has state `showMicTuner` and renders `{showMicTuner && <MicTuner ... />}` somewhere in the JSX
- Has a button "Ajustar microfone" that sets `showMicTuner(true)`
- Has label text: "Ganho Automático (AGC)", "Ganho máximo:", "Sensibilidade do mic:", "Noise gate adaptativo", presets "Silenciosa"/"Reunião"/"Auditório"

The `onApply` callback in the wizard receives a `Partial<AppSettings>` and must call `updateSetting` for each field.

- [ ] **Step 1: Replace MicTuner import with MicCalibrationWizard**

In `src/components/SettingsModal.tsx`, find:

```tsx
import { MicTuner } from "./MicTuner";
```

Replace with:

```tsx
import { MicCalibrationWizard } from "./MicCalibrationWizard";
```

- [ ] **Step 2: Replace MicTuner usage with MicCalibrationWizard**

Find wherever `<MicTuner` is rendered (search for `showMicTuner &&`). Replace the entire `<MicTuner ... />` JSX with:

```tsx
{showMicTuner && (
  <MicCalibrationWizard
    settings={settings}
    onApply={(patch) => {
      Object.entries(patch).forEach(([key, value]) => {
        updateSetting(key as keyof AppSettings, value as AppSettings[keyof AppSettings]);
      });
    }}
    onClose={() => setShowMicTuner(false)}
  />
)}
```

- [ ] **Step 3: Update the button label**

Find:
```tsx
Ajustar microfone
```
Replace with:
```tsx
Calibrar microfone
```

- [ ] **Step 4: Rename mic labels**

Make these exact text replacements (use replace-all where the string is unique):

| Find | Replace |
|------|---------|
| `Ganho Automático (AGC)` | `Amplificação automática` |
| `Amplifica o volume do mic automaticamente` | `Normaliza o volume do microfone automaticamente` |
| `Ganho máximo:` | `Nível máximo de amplificação:` |
| `Sensibilidade do mic:` | `Cortar silêncios curtos:` |
| `Mais sensível` | `Mais sensível` *(no change needed — keep)* |
| `Noise gate adaptativo` | `Filtrar ruído de fundo` |
| `label: "Silenciosa"` | `label: "Ambiente silencioso"` |
| `label: "Reunião"` | `label: "Escritório"` |
| `label: "Auditório"` | `label: "Sala barulhenta"` |

Note: the preset labels are inside an inline array like `[{ label: "Silenciosa", ratio: 0, hold: 0.3 }, ...]`. Edit all three.

- [ ] **Step 5: Verify TypeScript**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 6: Delete MicTuner.tsx**

```bash
rm src/components/MicTuner.tsx
```

Verify no TypeScript errors after deletion:

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 7: Commit**

```bash
git add src/components/SettingsModal.tsx
git rm src/components/MicTuner.tsx
git commit -m "feat(calibration): wire MicCalibrationWizard in SettingsModal, rename labels, remove MicTuner"
```

---

### Task 6: Full build verification

**Files:** none — verification only

- [ ] **Step 1: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 2: Rust build**

```bash
cd src-tauri && cargo build 2>&1 | grep "^error" | head -10
```

Expected: no errors.

- [ ] **Step 3: Commit any fixes needed**

If any issues were found and fixed:

```bash
git add -p
git commit -m "fix: address build issues in mic calibration wizard"
```
