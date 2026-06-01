# Onboarding com seleção de mic + melhorias na calibragem — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar passo de seleção de microfone no `SetupWizard` e corrigir três dores do `MicCalibrationWizard`: falsa falha "muito baixo", feedback em tempo real fraco, e resumo final sem contexto.

**Architecture:** Mudanças cirúrgicas — mantém a estrutura do wizard atual. Backend: troca a regra de pass/fail do `compute_calibration` (decide por **peak**, não RMS) e enriquece o payload do evento `mic-test-level` pra carregar `{rms, peak}`. Frontend: novo `CalibrationLevelMeter` substitui `MicLevelMeter` dentro do wizard, e o resumo final vira 3 blocos (precisão + diff + porquê). `SetupWizard` ganha 1 passo entre API Key e JGRC.

**Tech Stack:** Tauri 2 + Rust (WASAPI direto via crate `windows`) + React 18 + TypeScript + TailwindCSS + lucide-react.

**Spec:** [docs/superpowers/specs/2026-06-01-onboarding-mic-calibracao-design.md](../specs/2026-06-01-onboarding-mic-calibracao-design.md)

**Note sobre verificação:** Esse projeto não tem testes automatizados (sem vitest, sem testes Rust). Cada task termina com:
1. Compilação (`cargo check` no Rust, `npm run build` no frontend) — garante que não quebrou nada estaticamente.
2. **Smoke test manual** no `npm run tauri dev` quando faz sentido — instruções explícitas em cada task.

---

## File Structure

| Arquivo | Tipo | Responsabilidade |
|---|---|---|
| `src-tauri/src/commands.rs` | Modificar | Nova lógica de pass/fail em `compute_calibration`; novo payload `{rms, peak}` em 3 comandos que emitem `mic-test-level` |
| `src-tauri/src/audio/mod.rs` | Modificar | Track `peak_in_window` no mic thread; expor via `AudioCaptureState` |
| `src/services/audioCaptureService.ts` | Modificar | Ajustar helper `onMicTestLevel` pra novo payload |
| `src/components/CalibrationLevelMeter.tsx` | **Criar** | Componente novo: faixa colorida + 2 ponteiros + header + countdown |
| `src/components/MicCalibrationWizard.tsx` | Modificar | Aceitar `onComplete?` prop; novo round-failed UI com códigos; novo summary; usar `CalibrationLevelMeter` |
| `src/components/SetupWizard.tsx` | Modificar | Novo passo "Seu microfone" entre API Key e JGRC |

---

## Task 1: Backend — nova lógica de pass/fail em compute_calibration

**Files:**
- Modify: `src-tauri/src/commands.rs:1165-1182` (função `compute_calibration`)

- [ ] **Step 1: Substituir a regra de pass/fail**

Em `src-tauri/src/commands.rs`, localize o bloco da linha 1165 (`compute_calibration`) que contém:

```rust
let (round_passed, failure_reason): (bool, Option<&str>) = if speech_peak > 0.95 {
    (false, Some("Clipping detectado — você está muito perto do microfone. Recue um pouco e tente novamente."))
} else if speech_rms < 0.02 {
    (false, Some("Microfone muito baixo — fale mais alto ou aproxime-se do microfone."))
} else if snr < 6.0 {
    (false, Some("Muito ruído de fundo — tente se afastar de fontes de ruído ou aproximar o microfone."))
} else {
    (true, None)
};
```

Substitua por (note: `failure_reason` agora é um **código**, não uma mensagem PT-BR — o frontend mapeia):

```rust
let (round_passed, failure_reason): (bool, Option<&str>) = if speech_peak < 0.005 {
    (false, Some("Mic_Mute"))
} else if speech_peak > 0.95 {
    (false, Some("Clipping"))
} else if snr < 6.0 && silence_rms > 0.005 {
    (false, Some("Noise"))
} else {
    (true, None)
};
```

- [ ] **Step 2: Subir o teto do gain_max para 12.0**

No mesmo arquivo, localize o bloco do `gain_max` (alguns linhas acima do bloco anterior):

```rust
let gmax = (0.18 / speech_rms.max(0.001)).clamp(1.5, 8.0);
```

Substitua por:

```rust
let gmax = (0.18 / speech_rms.max(0.001)).clamp(1.5, 12.0);
```

- [ ] **Step 3: Verificar que compila**

```bash
cd src-tauri && cargo check
```

Expected: `Finished` sem erros. Warnings sobre código inalterado são OK.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "fix(calibracao): trocar pass/fail por critério baseado em peak

Em vez de bloquear por speech_rms<0.02 (que falha quando o usuário grita com
mic de baixo ganho hardware), agora aceita e compensa com gain_max ate 12x.
Falha apenas em mic mudo (peak<0.005), clipping (peak>0.95) ou ruido
audivel com SNR ruim."
```

---

## Task 2: Backend — peak_in_window no AudioCaptureState + novo payload mic-test-level

**Files:**
- Modify: `src-tauri/src/audio/mod.rs:126-149` (struct `AudioCaptureState`)
- Modify: `src-tauri/src/audio/mod.rs:557-561` (atualização do `mic_level` dentro do mic thread)
- Modify: `src-tauri/src/commands.rs` (3 sites que emitem `mic-test-level`)

- [ ] **Step 1: Adicionar campo peak_in_window em AudioCaptureState**

Em `src-tauri/src/audio/mod.rs`, modifique a struct `AudioCaptureState` (linha 126):

Localize:
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
    /// Set by the mic thread when 2-second calibration completes.
    pub calibration_result: parking_lot::Mutex<Option<CalibrationResult>>,
}
```

Adicione `mic_peak` logo depois de `mic_level`:

```rust
pub struct AudioCaptureState {
    pub is_capturing: AtomicBool,
    pub current_level: parking_lot::Mutex<f32>,
    /// Feature 5: nível de áudio do microfone (separado do loopback)
    pub mic_level: parking_lot::Mutex<f32>,
    /// Pico absoluto da janela mais recente do microfone — usado pelo wizard
    /// de calibração para mostrar o ponteiro de pico instantâneo.
    pub mic_peak: parking_lot::Mutex<f32>,
    /// Quando true, o áudio do microfone é silenciado (não misturado ao loopback)
    pub mic_muted: AtomicBool,
    /// Quando true, os chunks de áudio são descartados (transcrição pausada)
    pub is_paused: AtomicBool,
    /// Set by the mic thread when 2-second calibration completes.
    pub calibration_result: parking_lot::Mutex<Option<CalibrationResult>>,
}
```

E o `impl AudioCaptureState::new()` (linha 140):

```rust
impl AudioCaptureState {
    pub fn new() -> Self {
        Self {
            is_capturing: AtomicBool::new(false),
            current_level: parking_lot::Mutex::new(0.0),
            mic_level: parking_lot::Mutex::new(0.0),
            mic_muted: AtomicBool::new(false),
            is_paused: AtomicBool::new(false),
            calibration_result: parking_lot::Mutex::new(None),
        }
    }
```

Vira:

```rust
impl AudioCaptureState {
    pub fn new() -> Self {
        Self {
            is_capturing: AtomicBool::new(false),
            current_level: parking_lot::Mutex::new(0.0),
            mic_level: parking_lot::Mutex::new(0.0),
            mic_peak: parking_lot::Mutex::new(0.0),
            mic_muted: AtomicBool::new(false),
            is_paused: AtomicBool::new(false),
            calibration_result: parking_lot::Mutex::new(None),
        }
    }
```

- [ ] **Step 2: Atualizar o mic thread pra calcular e armazenar o peak**

No mesmo arquivo, localize o bloco da linha ~557 dentro do mic thread:

```rust
                        let raw =
                            std::slice::from_raw_parts(p_data, num_frames as usize * mic_align);
                        let samples = bytes_to_f32(raw, mic_bps);
                        let rms = compute_rms(&samples);
                        {
                            let mut lvl = state_mic.mic_level.lock();
                            *lvl = (*lvl * 0.7 + rms * 0.3).min(1.0);
                        }
```

Adicione cálculo de pico logo após `let rms = ...`:

```rust
                        let raw =
                            std::slice::from_raw_parts(p_data, num_frames as usize * mic_align);
                        let samples = bytes_to_f32(raw, mic_bps);
                        let rms = compute_rms(&samples);
                        let peak = samples.iter().map(|s| s.abs()).fold(0.0f32, f32::max).min(1.0);
                        {
                            let mut lvl = state_mic.mic_level.lock();
                            *lvl = (*lvl * 0.7 + rms * 0.3).min(1.0);
                        }
                        {
                            let mut pk = state_mic.mic_peak.lock();
                            *pk = peak;
                        }
```

- [ ] **Step 3: Mudar o payload de mic-test-level em record_calibration_phase**

Em `src-tauri/src/commands.rs`, localize a função `record_calibration_phase` (~linha 1031). Encontre o bloco:

```rust
    let cap_emit = Arc::clone(&capture_state);
    let app_emit = app.clone();
    let level_handle = tokio::spawn(async move {
        while cap_emit.is_capturing() {
            let level = *cap_emit.mic_level.lock();
            let _ = app_emit.emit("mic-test-level", level);
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    });
```

Substitua por:

```rust
    let cap_emit = Arc::clone(&capture_state);
    let app_emit = app.clone();
    let level_handle = tokio::spawn(async move {
        while cap_emit.is_capturing() {
            let rms = *cap_emit.mic_level.lock();
            let peak = *cap_emit.mic_peak.lock();
            let _ = app_emit.emit("mic-test-level", serde_json::json!({
                "rms": rms,
                "peak": peak,
            }));
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    });
```

- [ ] **Step 4: Repetir o mesmo ajuste em test_mic_transcription_phrase**

Mesma função `commands.rs`, agora em `test_mic_transcription_phrase` (~linha 1261). Localize o bloco quase idêntico:

```rust
    let cap_emit = Arc::clone(&capture_state);
    let app_emit = app.clone();
    let level_handle = tokio::spawn(async move {
        while cap_emit.is_capturing() {
            let level = *cap_emit.mic_level.lock();
            let _ = app_emit.emit("mic-test-level", level);
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    });
```

Substitua pelo mesmo bloco do Step 3 (com `rms` + `peak` + JSON).

- [ ] **Step 5: Repetir em test_mic_with_transcription**

Mesma função `commands.rs`, agora em `test_mic_with_transcription` (~linha 1409). Localize o bloco idêntico de novo e substitua pelo mesmo padrão.

- [ ] **Step 6: Verificar que compila**

```bash
cd src-tauri && cargo check
```

Expected: `Finished` sem erros.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/audio/mod.rs src-tauri/src/commands.rs
git commit -m "feat(calibracao): payload do mic-test-level vira {rms, peak}

Adiciona mic_peak ao AudioCaptureState e atualiza os 3 sites que emitem
mic-test-level (record_calibration_phase, test_mic_transcription_phrase,
test_mic_with_transcription) pra emitir objeto com rms e peak.

Necessario para o CalibrationLevelMeter mostrar dois ponteiros (medio + pico)."
```

---

## Task 3: Frontend — atualizar audioCaptureService.onMicTestLevel para novo payload

**Files:**
- Modify: `src/services/audioCaptureService.ts:133-139`

- [ ] **Step 1: Mudar a assinatura do callback e tipar o payload**

Em `src/services/audioCaptureService.ts`, localize a função `onMicTestLevel` (linha 133):

```ts
export async function onMicTestLevel(
  callback: (level: number) => void
): Promise<UnlistenFn> {
  return listen<number>("mic-test-level", (event) => {
    callback(event.payload);
  });
}
```

Substitua por:

```ts
export interface MicTestLevel {
  rms: number;
  peak: number;
}

export async function onMicTestLevel(
  callback: (level: MicTestLevel) => void
): Promise<UnlistenFn> {
  return listen<MicTestLevel>("mic-test-level", (event) => {
    callback(event.payload);
  });
}
```

- [ ] **Step 2: Verificar TypeScript**

```bash
npm run build
```

Expected: pode dar erro em `MicCalibrationWizard.tsx:88` que ainda lê `e.payload` como número. **Esse erro será corrigido na Task 5** — anote o erro e siga em frente. Outros usos do helper `onMicTestLevel` não existem no projeto (verificado com grep antes), então só esse arquivo deve estar quebrado.

- [ ] **Step 3: Commit (parcial, tipo do helper)**

```bash
git add src/services/audioCaptureService.ts
git commit -m "feat(calibracao): tipar payload MicTestLevel no service"
```

---

## Task 4: Criar CalibrationLevelMeter

**Files:**
- Create: `src/components/CalibrationLevelMeter.tsx`

- [ ] **Step 1: Criar o arquivo do componente**

Crie `src/components/CalibrationLevelMeter.tsx` com o seguinte conteúdo completo:

```tsx
// components/CalibrationLevelMeter.tsx
// Medidor de nível em tempo real usado pelo MicCalibrationWizard.
// Mostra zonas coloridas fixas + ponteiro de pico + ponteiro de RMS médio
// + header com indicador de fala/silêncio + contador regressivo.

import { useEffect, useRef, useState, useCallback } from "react";
import clsx from "clsx";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Mic, Volume2 } from "lucide-react";
import type { MicTestLevel } from "@/services/audioCaptureService";

interface CalibrationLevelMeterProps {
  /** "speech" — header detecta fala. "silence" — header detecta silêncio. */
  mode: "speech" | "silence";
  /** Duração do contador regressivo (5, 3 ou 6) */
  durationSecs: number;
  className?: string;
}

// Zonas fixas (idênticas à intuição de calibragem):
// 0.00–0.04 → vermelho (muito baixo)
// 0.04–0.70 → verde (ideal)
// 0.70–1.00 → vermelho (muito alto)
const ZONE_LOW_END = 0.04;
const ZONE_HIGH_START = 0.70;

// Threshold para "captando fala" — fica verde se RMS instantâneo passou
// desse valor nos últimos 500ms.
const SPEECH_DETECTION_THRESHOLD = 0.02;
const SPEECH_DETECTION_WINDOW_MS = 500;

// Suavização do RMS médio (decaimento exponencial)
const RMS_AVG_DECAY = 0.85;

export function CalibrationLevelMeter({
  mode,
  durationSecs,
  className,
}: CalibrationLevelMeterProps) {
  const [peak, setPeak] = useState(0);
  const [avgRms, setAvgRms] = useState(0);
  const [speechDetected, setSpeechDetected] = useState(false);
  const [remainingSecs, setRemainingSecs] = useState(durationSecs);

  const avgRmsRef = useRef(0);
  const speechWindowRef = useRef<number[]>([]);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  // Subscribe to mic-test-level
  useEffect(() => {
    let cancelled = false;
    listen<MicTestLevel>("mic-test-level", (event) => {
      if (cancelled) return;
      const { rms, peak: peakValue } = event.payload;
      setPeak(peakValue);

      // RMS médio com decaimento exponencial
      avgRmsRef.current = avgRmsRef.current * RMS_AVG_DECAY + rms * (1 - RMS_AVG_DECAY);
      setAvgRms(avgRmsRef.current);

      // Speech detection window (sliding 500ms)
      const now = Date.now();
      const window = speechWindowRef.current;
      window.push(now);
      // Marca passada apenas se RMS passou do threshold neste evento
      if (rms < SPEECH_DETECTION_THRESHOLD) {
        // remove esse timestamp — ele só é mantido quando há fala
        window.pop();
      }
      // Limpa timestamps antigos
      while (window.length > 0 && now - window[0] > SPEECH_DETECTION_WINDOW_MS) {
        window.shift();
      }
      setSpeechDetected(window.length > 0);
    }).then((un) => {
      if (cancelled) {
        un();
      } else {
        unlistenRef.current = un;
      }
    });

    return () => {
      cancelled = true;
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, []);

  // Countdown
  useEffect(() => {
    setRemainingSecs(durationSecs);
    const start = Date.now();
    const id = setInterval(() => {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const left = Math.max(0, durationSecs - elapsed);
      setRemainingSecs(left);
      if (left === 0) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [durationSecs]);

  // Header label/color
  const headerLabel = useCallback(() => {
    if (mode === "speech") {
      return speechDetected
        ? { text: "Captando fala ✓", color: "emerald", dotPulse: true }
        : { text: "Aguardando fala...", color: "surface", dotPulse: false };
    } else {
      // mode === "silence"
      return speechDetected
        ? { text: "Detectando som...", color: "amber", dotPulse: false }
        : { text: "Silêncio ✓", color: "emerald", dotPulse: true };
    }
  }, [mode, speechDetected])();

  const HeaderIcon = mode === "speech" ? Mic : Volume2;

  return (
    <div
      className={clsx(
        "rounded-xl border border-surface-100 dark:border-surface-700/50 bg-surface-50 dark:bg-surface-800/40 overflow-hidden",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-surface-100 dark:border-surface-700/50">
        <div className="flex items-center gap-2">
          <HeaderIcon
            className={clsx(
              "w-3.5 h-3.5",
              headerLabel.color === "emerald" && "text-emerald-500",
              headerLabel.color === "amber" && "text-amber-500",
              headerLabel.color === "surface" && "text-surface-400"
            )}
          />
          <span
            className={clsx(
              "w-2 h-2 rounded-full",
              headerLabel.color === "emerald" && "bg-emerald-500",
              headerLabel.color === "amber" && "bg-amber-500",
              headerLabel.color === "surface" && "bg-surface-400",
              headerLabel.dotPulse && "animate-pulse"
            )}
          />
          <span
            className={clsx(
              "text-xs font-semibold",
              headerLabel.color === "emerald" && "text-emerald-700 dark:text-emerald-400",
              headerLabel.color === "amber" && "text-amber-700 dark:text-amber-400",
              headerLabel.color === "surface" && "text-surface-500 dark:text-surface-400"
            )}
          >
            {headerLabel.text}
          </span>
        </div>
        <span className="text-xs font-mono text-surface-500 dark:text-surface-400">
          Gravando {remainingSecs}s
        </span>
      </div>

      {/* Meter */}
      <div className="px-3 py-4">
        <div className="relative h-3 rounded-full overflow-hidden bg-surface-200 dark:bg-surface-900">
          {/* Faixa colorida estática: vermelho / verde / vermelho */}
          <div
            className="absolute inset-y-0 left-0 bg-red-300/60 dark:bg-red-900/40"
            style={{ width: `${ZONE_LOW_END * 100}%` }}
          />
          <div
            className="absolute inset-y-0 bg-emerald-300/60 dark:bg-emerald-900/40"
            style={{
              left: `${ZONE_LOW_END * 100}%`,
              width: `${(ZONE_HIGH_START - ZONE_LOW_END) * 100}%`,
            }}
          />
          <div
            className="absolute inset-y-0 right-0 bg-red-300/60 dark:bg-red-900/40"
            style={{ width: `${(1 - ZONE_HIGH_START) * 100}%` }}
          />

          {/* Ponteiro de RMS médio (ciano, mais grosso) */}
          <div
            className="absolute inset-y-0 w-1 bg-cyan-500 transition-[left] duration-100"
            style={{ left: `calc(${Math.min(avgRms, 1) * 100}% - 2px)` }}
          />

          {/* Ponteiro de pico (vermelho-vivo, fino) */}
          <div
            className="absolute inset-y-0 w-0.5 bg-red-600 dark:bg-red-400"
            style={{ left: `calc(${Math.min(peak, 1) * 100}% - 1px)` }}
          />
        </div>

        {/* Legenda das zonas */}
        <div className="flex justify-between mt-1.5 text-[10px] text-surface-400 dark:text-surface-500">
          <span>baixo</span>
          <span>ideal</span>
          <span>muito alto</span>
        </div>

        {/* Legenda dos ponteiros */}
        <div className="flex items-center gap-3 mt-2 text-[10px] text-surface-500 dark:text-surface-400">
          <span className="flex items-center gap-1">
            <span className="w-2 h-1.5 bg-cyan-500 rounded-sm" />
            RMS médio
          </span>
          <span className="flex items-center gap-1">
            <span className="w-1 h-1.5 bg-red-600 dark:bg-red-400 rounded-sm" />
            pico
          </span>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verificar TypeScript**

```bash
npm run build
```

Expected: o erro de `MicCalibrationWizard.tsx:88` deve continuar (vai ser corrigido na próxima task). O novo componente em si não pode introduzir erros.

- [ ] **Step 3: Commit**

```bash
git add src/components/CalibrationLevelMeter.tsx
git commit -m "feat(calibracao): novo CalibrationLevelMeter com feedback em tempo real

Faixa colorida estatica (vermelho/verde/vermelho), ponteiro de RMS medio
e ponteiro de pico independentes, header com bolinha pulsante indicando
fala detectada (ou silencio no modo invertido), contador regressivo."
```

---

## Task 5: Wire CalibrationLevelMeter no MicCalibrationWizard + ajustar leitura do payload

**Files:**
- Modify: `src/components/MicCalibrationWizard.tsx:1-10` (imports)
- Modify: `src/components/MicCalibrationWizard.tsx:80-94` (subscribeToLevel)
- Modify: `src/components/MicCalibrationWizard.tsx:367-471` (3 telas de gravação)

- [ ] **Step 1: Adicionar import do CalibrationLevelMeter e remover MicLevelMeter**

Em `src/components/MicCalibrationWizard.tsx`, localize os imports (linhas 1-10):

```tsx
import { useState, useEffect, useCallback, useRef } from "react";
import clsx from "clsx";
import {
  X, Mic, CheckCircle2, AlertCircle, AlertTriangle,
  ChevronRight, RotateCcw, Loader2, Volume2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppSettings, CalibrationSnapshot } from "@/types";
import { MicLevelMeter } from "./MicLevelMeter";
```

Substitua a última linha por:

```tsx
import { CalibrationLevelMeter } from "./CalibrationLevelMeter";
```

(`MicLevelMeter` deixa de ser usado dentro desse arquivo. O componente continua existindo no projeto pra outros usos.)

- [ ] **Step 2: Remover micLevel state e subscribeToLevel — não são mais necessários**

O `CalibrationLevelMeter` se inscreve sozinho. Localize e **remova**:

```tsx
const [micLevel, setMicLevel] = useState(0);
```

```tsx
const unlistenRef = useRef<UnlistenFn | null>(null);
// ...
const subscribingRef = useRef(false);

const subscribeToLevel = useCallback(async () => {
  if (subscribingRef.current) return;
  subscribingRef.current = true;
  if (unlistenRef.current) {
    unlistenRef.current();
    unlistenRef.current = null;
  }
  try {
    unlistenRef.current = await listen<number>("mic-test-level", (e) =>
      setMicLevel(e.payload)
    );
  } finally {
    subscribingRef.current = false;
  }
}, []);
```

E o cleanup do useEffect na linha ~103:

```tsx
useEffect(() => {
  return () => {
    if (unlistenRef.current) unlistenRef.current();
    clearCountdown();
  };
}, [clearCountdown]);
```

Vira:

```tsx
useEffect(() => {
  return () => {
    clearCountdown();
  };
}, [clearCountdown]);
```

Também remova `import { listen, type UnlistenFn } from "@tauri-apps/api/event";` (não usado mais).

- [ ] **Step 3: Atualizar os useEffects que chamavam subscribeToLevel**

Localize os 3 useEffects que disparavam `subscribeToLevel().then(...)`:

```tsx
// speech-recording
useEffect(() => {
  if (step !== "speech-recording") return;
  setMicLevel(0);
  subscribeToLevel().then(() => {
    invoke("record_calibration_phase", { phase: "speech" })
      .then(() => setStep("silence-recording"))
      .catch((e: unknown) => { setErrorMsg(String(e)); setStep("error"); });
  }).catch((e: unknown) => { setErrorMsg(String(e)); setStep("error"); });
}, [step, subscribeToLevel]);
```

Substitua por (sem `setMicLevel`, sem `subscribeToLevel`):

```tsx
// speech-recording
useEffect(() => {
  if (step !== "speech-recording") return;
  invoke("record_calibration_phase", { phase: "speech" })
    .then(() => setStep("silence-recording"))
    .catch((e: unknown) => { setErrorMsg(String(e)); setStep("error"); });
}, [step]);
```

Aplique o mesmo padrão (remover `setMicLevel(0)` + `subscribeToLevel().then(...)`) aos useEffects de `silence-recording` e `transcription-recording`.

`transcription-recording`:

```tsx
useEffect(() => {
  if (step !== "transcription-recording" || !calibration) return;
  invoke<TranscriptionResult>("test_mic_transcription_phrase", {
    autoGain: calibration.mic_auto_gain,
    gainMax: calibration.mic_gain_max,
    silenceThreshold: calibration.mic_silence_threshold,
  })
    .then((result) => {
      setTranscription(result);
      setStep("transcription-result");
    })
    .catch((e: unknown) => { setErrorMsg(String(e)); setStep("error"); });
}, [step, calibration]);
```

`silence-recording`:

```tsx
useEffect(() => {
  if (step !== "silence-recording") return;
  invoke("record_calibration_phase", { phase: "silence" })
    .then(() => setStep("computing"))
    .catch((e: unknown) => { setErrorMsg(String(e)); setStep("error"); });
}, [step]);
```

- [ ] **Step 4: Substituir MicLevelMeter nas 3 telas**

`speech-recording` (~linha 369):

```tsx
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
```

Substitua por (header e LevelZoneHint somem — o CalibrationLevelMeter já comunica tudo):

```tsx
{step === "speech-recording" && (
  <CalibrationLevelMeter mode="speech" durationSecs={5} />
)}
```

`silence-recording` (~linha 382):

```tsx
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
```

Substitua por:

```tsx
{step === "silence-recording" && (
  <CalibrationLevelMeter mode="silence" durationSecs={3} />
)}
```

`transcription-recording` (~linha 457):

```tsx
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
```

Substitua por (mantém o card da frase — o usuário precisa ver o texto a ler):

```tsx
{step === "transcription-recording" && (
  <div className="space-y-3">
    <div className="p-3 bg-primary-50 dark:bg-primary-500/10 rounded-xl border border-primary-100 dark:border-primary-500/20">
      <p className="text-sm font-medium text-primary-800 dark:text-primary-200 leading-relaxed">
        "A reunião de alinhamento com o cliente começa às quatorze horas na sala de conferências."
      </p>
    </div>
    <CalibrationLevelMeter mode="speech" durationSecs={6} />
  </div>
)}
```

- [ ] **Step 5: Remover o componente LevelZoneHint não mais usado**

No final do arquivo `MicCalibrationWizard.tsx` (~linha 624), remova:

```tsx
function LevelZoneHint({ level }: { level: number }) {
  if (level >= 0.04 && level <= 0.7) return null;
  return (
    <p className={clsx(
      "text-xs text-center font-medium",
      level < 0.04 ? "text-yellow-600 dark:text-yellow-400" : "text-red-600 dark:text-red-400"
    )}>
      {level < 0.04
        ? "Muito baixo — fale mais alto ou aproxime-se"
        : "Muito alto — afaste-se do microfone"}
    </p>
  );
}
```

- [ ] **Step 6: Verificar build**

```bash
npm run build
```

Expected: `tsc && vite build` deve passar sem erros.

- [ ] **Step 7: Smoke test manual**

```bash
npm run tauri dev
```

1. Abra **Settings → Calibrar microfone**.
2. Confirme que a calibragem inicia normalmente (skipa o ambiente warning se não houver ruído).
3. Na tela de fala, fale normal e verifique que: ponteiro vermelho de pico se move rápido, ponteiro ciano de RMS se move suave, header pisca "Captando fala ✓" verde, contador conta de 5→0.
4. Na tela de silêncio, fique quieto: header pisca "Silêncio ✓" verde.
5. Faça ruído proposital: header vira "Detectando som..." amarelo.
6. Veja a tela de leitura da frase: ponteiros mostram movimento durante os 6s.

Se algum dos 6 pontos não funcionar, **NÃO COMMITAR** — corrigir antes.

- [ ] **Step 8: Commit**

```bash
git add src/components/MicCalibrationWizard.tsx
git commit -m "feat(calibracao): substituir MicLevelMeter por CalibrationLevelMeter

Usa o novo medidor nas 3 telas de gravacao (speech/silence/transcription).
Remove LevelZoneHint, micLevel state e subscribeToLevel — o
CalibrationLevelMeter se inscreve sozinho com o novo payload {rms, peak}."
```

---

## Task 6: Mapear failure_reason codes no round-failed + UI especial pra Mic_Mute

**Files:**
- Modify: `src/components/MicCalibrationWizard.tsx` — tipo `CalibrationResult`, função `compute_calibration` consumer, branch `round-failed`
- Modify: `src/services/audioCaptureService.ts` — adicionar `listMicrophones` se ainda não existe (verificar primeiro)

- [ ] **Step 1: Verificar se listMicrophones já existe no service**

```bash
grep -n "listMicrophones\|list_microphones" src/services/*.ts
```

Se já existir, pular Step 2. Senão, adicionar:

- [ ] **Step 2: Adicionar helper listMicrophones (apenas se não existir)**

Em `src/services/audioCaptureService.ts`, adicione antes do `onMicTestLevel`:

```ts
import type { AudioDevice } from "@/types";

export async function listMicrophones(): Promise<AudioDevice[]> {
  return await invoke<AudioDevice[]>("list_microphones");
}
```

(Verifique antes se `invoke` e `AudioDevice` já estão importados; provavelmente sim.)

- [ ] **Step 3: Atualizar o tipo CalibrationResult dentro do MicCalibrationWizard**

Em `src/components/MicCalibrationWizard.tsx`, localize:

```tsx
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
```

Substitua `failure_reason: string | null` por:

```tsx
  failure_reason: "Mic_Mute" | "Clipping" | "Noise" | null;
```

(Resto do tipo igual.)

- [ ] **Step 4: Adicionar mapeamento de códigos pra mensagens**

Logo abaixo dos imports/tipos no MicCalibrationWizard.tsx (próximo ao `PRESET_LABELS`), adicione:

```tsx
const FAILURE_MESSAGES: Record<"Clipping" | "Noise", string> = {
  Clipping: "Você está muito perto do microfone. Recue um pouco e tente novamente.",
  Noise: "Muito ruído de fundo — tente se afastar de fontes de ruído ou aproximar o microfone.",
};
```

`Mic_Mute` não está aqui porque tem UI completamente diferente (Step 6).

- [ ] **Step 5: Adicionar imports e state para o caso Mic_Mute**

No topo do componente (junto com os outros `useState`):

```tsx
const [microphones, setMicrophones] = useState<{ id: string; name: string }[]>([]);
const [selectedMic, setSelectedMic] = useState<string>(settings.selected_microphone ?? "");
```

E nos imports, adicione `VolumeX` ao lucide-react:

```tsx
import {
  X, Mic, CheckCircle2, AlertCircle, AlertTriangle,
  ChevronRight, RotateCcw, Loader2, Volume2, VolumeX,
} from "lucide-react";
```

Também importe `listMicrophones`:

```tsx
import { listMicrophones } from "@/services/audioCaptureService";
import { saveSettings } from "@/services/storageService";
```

- [ ] **Step 6: Carregar lista de microfones quando entra em round-failed com Mic_Mute**

Adicione esse useEffect logo após o useEffect de `computing`:

```tsx
// Carrega lista de mics quando o caso Mic_Mute aparece
useEffect(() => {
  if (step === "round-failed" && calibration?.failure_reason === "Mic_Mute") {
    listMicrophones()
      .then(setMicrophones)
      .catch((e) => console.error("Erro ao listar microfones:", e));
  }
}, [step, calibration]);
```

- [ ] **Step 7: Reescrever a branch round-failed**

Localize a branch existente:

```tsx
{/* round-failed */}
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
```

Substitua por:

```tsx
{/* round-failed — UI diferente por código */}
{step === "round-failed" && calibration && calibration.failure_reason === "Mic_Mute" && (
  <div className="space-y-4">
    <div className="flex items-start gap-3 p-4 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl">
      <VolumeX className="w-5 h-5 text-red-500 mt-0.5 flex-shrink-0" />
      <div>
        <p className="text-sm font-semibold text-red-800 dark:text-red-300">
          Seu microfone não está captando som
        </p>
        <p className="text-xs text-red-700 dark:text-red-400 mt-1">
          Não detectamos nenhum áudio. Verifique se o microfone certo está selecionado e se o volume não está zerado no Windows.
        </p>
      </div>
    </div>

    {/* Dropdown embutido pra trocar mic */}
    <div className="space-y-2">
      <label className="text-xs font-medium text-surface-600 dark:text-surface-400">
        Microfone selecionado
      </label>
      <select
        value={selectedMic}
        onChange={async (e) => {
          const newId = e.target.value;
          setSelectedMic(newId);
          await saveSettings({ ...settings, selected_microphone: newId } as AppSettings);
        }}
        className="w-full px-3 py-2 text-sm rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800/60 text-surface-800 dark:text-surface-200 focus:outline-none focus:ring-2 focus:ring-primary-500"
      >
        {microphones.map((m) => (
          <option key={m.id} value={m.id}>{m.name}</option>
        ))}
      </select>
    </div>

    {/* Link painel de som */}
    <button
      type="button"
      onClick={() => invoke("open_compliance_window").catch(() => {})}
      className="w-full text-xs text-primary-600 dark:text-primary-400 hover:underline text-left px-1"
    >
      Abrir painel de som do Windows →
    </button>

    <p className="text-xs text-surface-500 dark:text-surface-400 text-center">
      Tentativa {round} de 3
    </p>

    <div className="flex gap-3">
      <button
        onClick={onClose}
        className="px-4 py-2.5 rounded-xl text-sm font-medium border border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-300 hover:bg-surface-50 dark:hover:bg-surface-800 transition-all"
      >
        Cancelar
      </button>
      <button
        onClick={handleRetryRound}
        disabled={round >= 3}
        className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold bg-primary-500 text-white hover:bg-primary-600 transition-all disabled:opacity-50"
      >
        <RotateCcw className="w-4 h-4" />
        Tentar de novo
      </button>
    </div>
  </div>
)}

{step === "round-failed" && calibration && calibration.failure_reason !== "Mic_Mute" && (
  <div className="space-y-4">
    <div className="flex items-start gap-3 p-4 bg-orange-50 dark:bg-orange-500/10 border border-orange-200 dark:border-orange-500/20 rounded-xl">
      <AlertTriangle className="w-5 h-5 text-orange-500 mt-0.5 flex-shrink-0" />
      <div>
        <p className="text-sm font-semibold text-orange-800 dark:text-orange-300">
          Precisamos tentar de novo
        </p>
        <p className="text-xs text-orange-700 dark:text-orange-400 mt-1">
          {calibration.failure_reason === "Clipping" || calibration.failure_reason === "Noise"
            ? FAILURE_MESSAGES[calibration.failure_reason]
            : "Calibração falhou."}
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
```

- [ ] **Step 8: Substituir o callback de "Abrir painel de som" pelo open shell**

O passo anterior usou `invoke("open_compliance_window")` como placeholder. Substitua por chamada ao tauri-plugin-shell ou o equivalente nativo. Verifique primeiro se o plugin está habilitado:

```bash
grep -n "tauri-plugin-shell\|tauri_plugin_shell" src-tauri/Cargo.toml src-tauri/src/main.rs
```

Se **não estiver instalado**, faça este fallback (chama um comando Tauri novo):

Adicionar em `src-tauri/src/commands.rs` (final do arquivo, antes do último `}`):

```rust
/// Abre o painel de Som do Windows (ou diagnóstico equivalente em outras plataformas).
#[tauri::command]
pub async fn open_windows_sound_panel() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "ms-settings:sound"])
            .spawn()
            .map_err(|e| format!("Erro ao abrir painel de som: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Disponível apenas no Windows".to_string())
    }
}
```

Registrar em `src-tauri/src/main.rs` (na lista `invoke_handler`):

```rust
            commands::open_windows_sound_panel,
```

E no frontend (Step 7), substituir:

```tsx
onClick={() => invoke("open_compliance_window").catch(() => {})}
```

Por:

```tsx
onClick={() => invoke("open_windows_sound_panel").catch(() => {})}
```

- [ ] **Step 9: Verificar build**

```bash
cd src-tauri && cargo check
cd .. && npm run build
```

Expected: ambos passam sem erros.

- [ ] **Step 10: Smoke test manual**

```bash
npm run tauri dev
```

1. Desabilite seu microfone no Windows (ou desconecte o jack/USB).
2. Abra Settings → Calibrar microfone → fale durante a fase de fala.
3. Confirme que aparece a UI **vermelha** "Seu microfone não está captando som" com dropdown e o link de painel de som.
4. Clique no link "Abrir painel de som" — abre `ms-settings:sound` no Windows.
5. Reconecte o mic, troque pelo dropdown, e clique "Tentar de novo" — re-roda a calibragem.

- [ ] **Step 11: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/main.rs src/components/MicCalibrationWizard.tsx src/services/audioCaptureService.ts
git commit -m "feat(calibracao): UI especifica pra mic mudo + mapeamento de codigos

failure_reason agora e codigo (Mic_Mute/Clipping/Noise) em vez de string PT-BR.
Caso Mic_Mute mostra UI dedicada com dropdown embutido pra trocar mic e link
pro painel de som do Windows (open_windows_sound_panel)."
```

---

## Task 7: Adicionar prop onComplete ao MicCalibrationWizard

**Files:**
- Modify: `src/components/MicCalibrationWizard.tsx:12-17` (interface props)
- Modify: `src/components/MicCalibrationWizard.tsx:208-229` (handleApply)

- [ ] **Step 1: Estender a interface de props**

Localize:

```tsx
interface MicCalibrationWizardProps {
  settings: AppSettings;
  onApply: (patch: Partial<AppSettings>) => void;
  onSaveSnapshot?: (snapshot: CalibrationSnapshot) => void;
  onClose: () => void;
}
```

Adicione `onComplete`:

```tsx
interface MicCalibrationWizardProps {
  settings: AppSettings;
  onApply: (patch: Partial<AppSettings>) => void;
  onSaveSnapshot?: (snapshot: CalibrationSnapshot) => void;
  onClose: () => void;
  /** Disparado APENAS após calibração bem-sucedida (apply). Cancel/close NÃO dispara. */
  onComplete?: () => void;
}
```

E desestruture na função:

```tsx
export function MicCalibrationWizard({ settings, onApply, onSaveSnapshot, onClose, onComplete }: MicCalibrationWizardProps) {
```

- [ ] **Step 2: Chamar onComplete em handleApply**

Localize `handleApply`:

```tsx
const handleApply = useCallback(() => {
  if (!calibration) return;
  onApply({
    mic_auto_gain: calibration.mic_auto_gain,
    // ...
  });
  if (profileName.trim() && calibration && onSaveSnapshot) {
    onSaveSnapshot({ /* ... */ });
  }
  onClose();
}, [calibration, profileName, onApply, onSaveSnapshot, onClose]);
```

Adicione `onComplete?.()` antes de `onClose()`:

```tsx
const handleApply = useCallback(() => {
  if (!calibration) return;
  onApply({
    mic_auto_gain: calibration.mic_auto_gain,
    mic_gain_max: calibration.mic_gain_max,
    mic_silence_threshold: calibration.mic_silence_threshold,
    mic_noise_gate_ratio: calibration.mic_noise_gate_ratio,
    mic_noise_gate_hold_secs: calibration.mic_noise_gate_hold_secs,
  });
  if (profileName.trim() && calibration && onSaveSnapshot) {
    onSaveSnapshot({
      name: profileName.trim(),
      created_at: new Date().toISOString(),
      mic_auto_gain: calibration.mic_auto_gain,
      mic_gain_max: calibration.mic_gain_max,
      mic_silence_threshold: calibration.mic_silence_threshold,
      mic_noise_gate_ratio: calibration.mic_noise_gate_ratio,
      mic_noise_gate_hold_secs: calibration.mic_noise_gate_hold_secs,
    });
  }
  onComplete?.();
  onClose();
}, [calibration, profileName, onApply, onSaveSnapshot, onClose, onComplete]);
```

- [ ] **Step 3: Verificar build**

```bash
npm run build
```

Expected: sem erros.

- [ ] **Step 4: Commit**

```bash
git add src/components/MicCalibrationWizard.tsx
git commit -m "feat(calibracao): prop onComplete dispara somente apos apply

Necessario para o SetupWizard saber quando avancar automaticamente."
```

---

## Task 8: Reescrever o resumo final em 3 blocos

**Files:**
- Modify: `src/components/MicCalibrationWizard.tsx` — branch `summary` (~linha 536), componente `SummaryDiff` (~linha 638)

- [ ] **Step 1: Adicionar constantes e helper de regras**

No topo do arquivo (junto com `PRESET_LABELS` e `FAILURE_MESSAGES`):

```tsx
const EXPECTED_PHRASE_WORDS = 15; // "A reunião de alinhamento com o cliente começa às quatorze horas na sala de conferências." = 15 palavras

const NOISE_GATE_LABELS: Record<"silent" | "meeting" | "auditorium", string> = {
  silent: "Ambiente silencioso",
  meeting: "Escritório",
  auditorium: "Sala barulhenta",
};

function currentPresetFromSettings(s: AppSettings): "silent" | "meeting" | "auditorium" {
  const ratio = s.mic_noise_gate_ratio ?? 0;
  return ratio === 0 ? "silent" : ratio <= 3 ? "meeting" : "auditorium";
}

/** Retorna 1–3 frases explicando o porquê das mudanças. Vazio se nada significativo mudou. */
function explainChanges(current: AppSettings, rec: CalibrationResult): string[] {
  const sentences: string[] = [];

  const currentGain = current.mic_gain_max ?? 4;
  const gainIncreasedAlot = rec.mic_gain_max > currentGain * 2;
  const gainTurnedOn = rec.mic_auto_gain && !current.mic_auto_gain;
  const gainDecreased = rec.mic_gain_max < currentGain;

  if (gainTurnedOn || gainIncreasedAlot) {
    sentences.push(
      "Seu microfone estava captando volume baixo em relação ao ideal. Agora ele será amplificado automaticamente para ficar no nível certo, sem você precisar gritar."
    );
  } else if (gainDecreased) {
    sentences.push(
      "Seu microfone estava captando volume alto demais. Reduzimos a amplificação pra evitar distorção."
    );
  }

  const currentPreset = currentPresetFromSettings(current);
  if (rec.noise_gate_preset !== currentPreset) {
    if (rec.noise_gate_preset === "auditorium") {
      sentences.push(
        "Como o ambiente tem ruído de fundo perceptível, ajustamos o filtro pra sala barulhenta — ele vai cortar sons fracos entre falas."
      );
    } else if (rec.noise_gate_preset === "silent") {
      sentences.push(
        "Seu ambiente está bem silencioso, então removemos quase todo o filtro de ruído pra captar até falas baixas."
      );
    }
  }

  const currentThreshold = current.mic_silence_threshold ?? 0.003;
  const thresholdChangePct = Math.abs(rec.mic_silence_threshold - currentThreshold) / Math.max(currentThreshold, 0.001);
  if (thresholdChangePct > 0.5) {
    sentences.push(
      "Ajustamos o corte de silêncio pro nível de ruído do seu ambiente — chunks silenciosos serão descartados antes da transcrição (economiza chamadas de API)."
    );
  }

  return sentences;
}
```

- [ ] **Step 2: Reescrever a branch summary**

Localize a branch atual:

```tsx
{/* summary */}
{step === "summary" && calibration && (
  <div className="space-y-4">
    <p className="text-sm font-semibold text-surface-800 dark:text-surface-100">
      Resumo das alterações
    </p>
    <SummaryDiff current={settings} recommended={calibration} />
    <div>
      <label className="block text-xs font-medium text-surface-500 dark:text-surface-400 mb-1">
        Salvar como perfil (opcional)
      </label>
      <input
        type="text"
        value={profileName}
        // ...
      />
    </div>
    <div className="flex gap-3 pt-2">
      {/* botões */}
    </div>
  </div>
)}
```

Substitua por:

```tsx
{/* summary — 3 blocos */}
{step === "summary" && calibration && (
  <div className="space-y-3">
    {/* Bloco 1: Precisão estimada */}
    {transcription && transcription.got !== "" ? (
      <SummaryAccuracyBlock similarity={transcription.similarity} />
    ) : (
      <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
              Calibração aplicada sem teste de precisão
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
              Recomendamos refazer o teste em ambiente mais silencioso quando possível.
            </p>
          </div>
        </div>
      </div>
    )}

    {/* Bloco 2: Antes → depois */}
    <SummaryDiffBlock current={settings} recommended={calibration} />

    {/* Bloco 3: Por quê */}
    <SummaryReasonsBlock current={settings} recommended={calibration} />

    {/* Perfil opcional */}
    <div>
      <label className="block text-xs font-medium text-surface-500 dark:text-surface-400 mb-1">
        Salvar como perfil (opcional)
      </label>
      <input
        type="text"
        value={profileName}
        onChange={(e) => setProfileName(e.target.value)}
        placeholder="ex: Escritório, Casa, Reunião fora"
        maxLength={40}
        className="w-full px-3 py-2 rounded-xl text-sm bg-surface-50 dark:bg-surface-800 border border-surface-200 dark:border-surface-700 text-surface-800 dark:text-surface-100 placeholder-surface-400 focus:outline-none focus:ring-2 focus:ring-primary-400"
      />
    </div>

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
```

- [ ] **Step 3: Remover o componente SummaryDiff antigo**

No final do arquivo (~linha 638), localize e **remova** toda a função `SummaryDiff`.

- [ ] **Step 4: Adicionar os 3 novos sub-componentes ao final do arquivo**

No mesmo lugar onde estava `SummaryDiff` (ou no final do arquivo, junto com `StepDot`):

```tsx
function SummaryAccuracyBlock({ similarity }: { similarity: number }) {
  const pct = Math.round(similarity * 100);
  const correctWords = Math.round(similarity * EXPECTED_PHRASE_WORDS);
  const color =
    pct >= 85 ? "emerald" : pct >= 60 ? "amber" : "red";

  return (
    <div
      className={clsx(
        "p-4 rounded-xl border",
        color === "emerald" && "bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/20",
        color === "amber" && "bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/20",
        color === "red" && "bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/20",
      )}
    >
      <div className="flex items-start gap-3">
        <CheckCircle2
          className={clsx(
            "w-5 h-5 mt-0.5 flex-shrink-0",
            color === "emerald" && "text-emerald-500",
            color === "amber" && "text-amber-500",
            color === "red" && "text-red-500",
          )}
        />
        <div>
          <p className={clsx(
            "text-sm font-semibold",
            color === "emerald" && "text-emerald-800 dark:text-emerald-300",
            color === "amber" && "text-amber-800 dark:text-amber-300",
            color === "red" && "text-red-800 dark:text-red-300",
          )}>
            Microfone configurado
          </p>
          <p className={clsx(
            "text-2xl font-bold mt-1",
            color === "emerald" && "text-emerald-700 dark:text-emerald-400",
            color === "amber" && "text-amber-700 dark:text-amber-400",
            color === "red" && "text-red-700 dark:text-red-400",
          )}>
            Precisão estimada: {pct}%
          </p>
          <p className={clsx(
            "text-xs mt-0.5",
            color === "emerald" && "text-emerald-700 dark:text-emerald-400",
            color === "amber" && "text-amber-700 dark:text-amber-400",
            color === "red" && "text-red-700 dark:text-red-400",
          )}>
            {correctWords} de {EXPECTED_PHRASE_WORDS} palavras transcritas corretamente no teste de leitura
          </p>
        </div>
      </div>
    </div>
  );
}

function SummaryDiffBlock({ current, recommended }: { current: AppSettings; recommended: CalibrationResult }) {
  type Row = { label: string; before: string; after: string };
  const rows: Row[] = [];

  // Amplificação automática
  if (recommended.mic_auto_gain !== (current.mic_auto_gain ?? false)) {
    rows.push({
      label: "Amplificação automática",
      before: (current.mic_auto_gain ?? false) ? "Ligada" : "Desligada",
      after: recommended.mic_auto_gain ? "Ligada" : "Desligada",
    });
  }

  // Ganho máximo
  const curGain = current.mic_gain_max ?? 4;
  if (Math.abs(recommended.mic_gain_max - curGain) > 0.1) {
    rows.push({
      label: "Ganho máximo",
      before: `${curGain.toFixed(1)}×`,
      after: `${recommended.mic_gain_max.toFixed(1)}×`,
    });
  }

  // Corte de silêncio
  const curThreshold = current.mic_silence_threshold ?? 0.003;
  if (Math.abs(recommended.mic_silence_threshold - curThreshold) > 0.0005) {
    rows.push({
      label: "Corte de silêncio",
      before: curThreshold.toFixed(4),
      after: recommended.mic_silence_threshold.toFixed(4),
    });
  }

  // Filtro de ruído
  const curPreset = currentPresetFromSettings(current);
  if (recommended.noise_gate_preset !== curPreset) {
    rows.push({
      label: "Filtro de ruído",
      before: NOISE_GATE_LABELS[curPreset],
      after: NOISE_GATE_LABELS[recommended.noise_gate_preset],
    });
  }

  if (rows.length === 0) {
    return (
      <div className="p-4 rounded-xl bg-surface-50 dark:bg-surface-800/40 border border-surface-100 dark:border-surface-700/50">
        <p className="text-sm text-surface-600 dark:text-surface-400 text-center">
          Suas configurações já estavam ótimas — nenhuma alteração necessária.
        </p>
      </div>
    );
  }

  return (
    <div className="p-4 rounded-xl bg-surface-50 dark:bg-surface-800/40 border border-surface-100 dark:border-surface-700/50">
      <p className="text-xs font-semibold uppercase tracking-wider text-surface-500 dark:text-surface-400 mb-3">
        O que mudou
      </p>
      <ul className="space-y-2">
        {rows.map((r, i) => (
          <li key={i} className="flex items-center justify-between text-sm">
            <span className="text-surface-600 dark:text-surface-400 flex items-center gap-1.5">
              <ChevronRight className="w-3 h-3 text-surface-400" />
              {r.label}
            </span>
            <span className="font-mono text-xs">
              <span className="text-surface-400 dark:text-surface-500">{r.before}</span>
              <span className="text-surface-400 dark:text-surface-500 mx-1.5">→</span>
              <span className="text-surface-800 dark:text-surface-100 font-semibold">{r.after}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SummaryReasonsBlock({ current, recommended }: { current: AppSettings; recommended: CalibrationResult }) {
  const reasons = explainChanges(current, recommended);
  if (reasons.length === 0) return null;
  return (
    <div className="p-4 rounded-xl bg-primary-50/50 dark:bg-primary-500/5 border border-primary-100 dark:border-primary-500/20">
      <p className="text-xs font-semibold uppercase tracking-wider text-primary-700 dark:text-primary-400 mb-2">
        Por que essas mudanças
      </p>
      <div className="space-y-2">
        {reasons.map((r, i) => (
          <p key={i} className="text-sm text-surface-700 dark:text-surface-300 leading-relaxed">
            {r}
          </p>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Verificar build**

```bash
npm run build
```

Expected: sem erros.

- [ ] **Step 6: Smoke test manual**

```bash
npm run tauri dev
```

1. Faça calibragem completa (Settings → Calibrar microfone, atravesse até "Ver resumo").
2. Confirme que aparecem **3 blocos** distintos: precisão estimada (cor depende do %), antes → depois (com setas), e por quê (se houve mudança).
3. Se nenhuma config mudou, o bloco "O que mudou" diz "já estavam ótimas" e o "por quê" some.
4. Pule o teste de transcrição com "Continuar mesmo assim" e confirme que o bloco 1 vira o aviso laranja em vez da precisão.

- [ ] **Step 7: Commit**

```bash
git add src/components/MicCalibrationWizard.tsx
git commit -m "feat(calibracao): resumo final em 3 blocos (precisao + diff + porque)

Bloco 1: precisao estimada do teste de transcricao (X% + X de Y palavras),
ou aviso se o teste foi pulado.
Bloco 2: tabela antes -> depois, escondendo linhas inalteradas.
Bloco 3: 1-3 frases em PT-BR explicando porque as mudancas (regras client-side)."
```

---

## Task 9: Novo passo "Seu microfone" no SetupWizard

**Files:**
- Modify: `src/components/SetupWizard.tsx`

- [ ] **Step 1: Adicionar imports necessários**

No topo do arquivo, no bloco de imports do lucide-react, adicione `Mic` se ainda não estiver:

```tsx
import {
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  Eye,
  EyeOff,
  Loader2,
  AlertCircle,
  Check,
  Link,
  ChevronLeft,
  ChevronRight,
  Mic,
  Pause,
  Square,
  Tag,
  Upload,
} from "lucide-react";
```

(`Mic` já existe — confirmar antes de adicionar.)

Adicione os imports novos abaixo de `getSettings, saveSettings`:

```tsx
import { listMicrophones } from "@/services/audioCaptureService";
import { MicCalibrationWizard } from "./MicCalibrationWizard";
import type { AudioDevice, CalibrationSnapshot } from "@/types";
```

(`AppSettings` provavelmente já está importado — confirmar.)

- [ ] **Step 2: Atualizar TOTAL_STEPS de 5 para 6**

Localize:

```tsx
export const SetupWizard: React.FC<SetupWizardProps> = ({ onComplete }) => {
  const [step, setStep] = useState(0);
  const TOTAL_STEPS = 5;
```

Substitua por:

```tsx
export const SetupWizard: React.FC<SetupWizardProps> = ({ onComplete }) => {
  const [step, setStep] = useState(0);
  const TOTAL_STEPS = 6;
```

- [ ] **Step 3: Adicionar state para o passo de microfone**

Logo após os `useState` existentes do JGRC (~linha 313):

```tsx
// Step 3 — Microfone
const [microphones, setMicrophones] = useState<AudioDevice[]>([]);
const [selectedMic, setSelectedMic] = useState("");
const [showCalibration, setShowCalibration] = useState(false);
const [calibrated, setCalibrated] = useState(false);
const [micSettings, setMicSettings] = useState<AppSettings | null>(null);
```

- [ ] **Step 4: Carregar microfones e settings ao entrar no novo step**

Logo após os useEffects/handlers existentes (não importa a ordem, mas mantenha agrupado com os outros `useCallback`):

```tsx
// Carrega microfones e settings ao entrar no step 3
React.useEffect(() => {
  if (step !== 3) return;
  Promise.all([listMicrophones(), getSettings()])
    .then(([devs, s]) => {
      setMicrophones(devs);
      setSelectedMic(s.selected_microphone ?? "");
      setMicSettings(s);
    })
    .catch((e) => console.error("Erro ao carregar mics/settings:", e));
}, [step]);

const handleMicChange = useCallback(async (newId: string) => {
  setSelectedMic(newId);
  const current = await getSettings();
  await saveSettings({ ...current, selected_microphone: newId });
  setMicSettings({ ...current, selected_microphone: newId });
}, []);

const handleApplyCalibration = useCallback(async (patch: Partial<AppSettings>) => {
  const current = await getSettings();
  const updated = { ...current, ...patch };
  await saveSettings(updated);
  setMicSettings(updated);
}, []);

const handleSaveCalibrationSnapshot = useCallback(async (snapshot: CalibrationSnapshot) => {
  const current = await getSettings();
  const snapshots = current.calibration_snapshots ?? [];
  await saveSettings({ ...current, calibration_snapshots: [...snapshots, snapshot] });
}, []);

const handleCalibrationComplete = useCallback(() => {
  setCalibrated(true);
  setShowCalibration(false);
  // Avança automaticamente pro próximo passo (JGRC)
  setStep((s) => s + 1);
}, []);
```

- [ ] **Step 5: Renumerar os steps existentes (mover JGRC e Pronto)**

No `renderStep` switch, localize a estrutura atual:

```
case 0: Boas-vindas
case 1: Tour
case 2: API Key
case 3: JGRC
case 4: Pronto
```

E renumere:

```
case 0: Boas-vindas
case 1: Tour
case 2: API Key
case 3: Microfone   ← NOVO
case 4: JGRC        ← (era case 3)
case 5: Pronto      ← (era case 4)
```

Mude `case 3` (JGRC) pra `case 4`. Mude `case 4` (Pronto) pra `case 5`. **Não mude** o conteúdo dessas branches — só o `case N:` label.

- [ ] **Step 6: Adicionar o novo case 3 (Microfone)**

Insira entre `case 2` e o que agora é `case 4`:

```tsx
// ── Step 3: Microfone ──────────────────────────────────────────────────
case 3:
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-bold text-surface-900 dark:text-surface-100 mb-1">
          Seu microfone
        </h2>
        <p className="text-sm text-surface-500 dark:text-surface-400">
          Escolha o microfone que você usa nas reuniões.
        </p>
      </div>

      <div className="space-y-2">
        <label className="text-xs font-medium text-surface-600 dark:text-surface-400">
          Dispositivo
        </label>
        <select
          value={selectedMic}
          onChange={(e) => handleMicChange(e.target.value)}
          className="w-full px-3 py-2 text-sm rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800/60 text-surface-800 dark:text-surface-200 focus:outline-none focus:ring-2 focus:ring-primary-500"
        >
          {microphones.map((m) => (
            <option key={m.id || "default"} value={m.id}>{m.name}</option>
          ))}
        </select>
      </div>

      <div className="flex items-start gap-3 p-3 rounded-xl bg-primary-50 dark:bg-primary-500/10 border border-primary-100 dark:border-primary-500/20">
        <Mic className="w-4 h-4 text-primary-500 mt-0.5 flex-shrink-0" />
        <p className="text-xs text-primary-800 dark:text-primary-200 leading-relaxed">
          <strong>Calibrar seu microfone melhora muito a transcrição</strong> — o app aprende seu volume normal e o ruído do seu ambiente. Você pode calibrar agora ou depois em <span className="font-medium">Configurações → Calibrar microfone</span>.
        </p>
      </div>

      {calibrated && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20">
          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
            Microfone calibrado!
          </span>
        </div>
      )}

      <button
        type="button"
        onClick={() => setShowCalibration(true)}
        disabled={calibrated}
        className={clsx(
          "flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition-all",
          calibrated
            ? "bg-surface-100 dark:bg-surface-800 text-surface-400 cursor-not-allowed"
            : "border-2 border-primary-500 text-primary-600 dark:text-primary-400 hover:bg-primary-50 dark:hover:bg-primary-500/10"
        )}
      >
        <Mic className="w-4 h-4" />
        {calibrated ? "Calibração concluída" : "Calibrar agora"}
      </button>
    </div>
  );
```

- [ ] **Step 7: Renderizar o MicCalibrationWizard por cima quando showCalibration=true**

No final do JSX retornado pelo componente, **antes** do `</div>` que fecha o backdrop, adicione:

Localize:

```tsx
return (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
    <div className={clsx(
      "w-full max-w-lg mx-4 rounded-2xl shadow-2xl overflow-hidden",
      "bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700"
    )}>
      {/* ... conteúdo do wizard ... */}
    </div>
  </div>
);
```

Substitua o `return` por:

```tsx
return (
  <>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className={clsx(
        "w-full max-w-lg mx-4 rounded-2xl shadow-2xl overflow-hidden",
        "bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700"
      )}>
        {/* ... conteúdo do wizard (sem mudança) ... */}
      </div>
    </div>

    {showCalibration && micSettings && (
      <MicCalibrationWizard
        settings={micSettings}
        onApply={handleApplyCalibration}
        onSaveSnapshot={handleSaveCalibrationSnapshot}
        onClose={() => setShowCalibration(false)}
        onComplete={handleCalibrationComplete}
      />
    )}
  </>
);
```

(Apenas envolveu em fragment `<>...</>` e adicionou o overlay condicional do MicCalibrationWizard.)

- [ ] **Step 8: Atualizar canSkip pra incluir o passo 3**

Localize:

```tsx
// Steps 2 e 3 sempre avançam (pulável)
const canSkip = step === 2 || step === 3;
```

Substitua por:

```tsx
// Steps 2 (API), 3 (Microfone) e 4 (JGRC) são puláveis
const canSkip = step === 2 || step === 3 || step === 4;
```

- [ ] **Step 9: Atualizar o passo "Pronto" com info do microfone**

Localize o `case 5` (antes era `case 4`) que mostra "Tudo pronto" com `ConfigItem`s:

```tsx
<div className="w-full max-w-xs space-y-2">
  <ConfigItem label="Transcrição e Resumo" value={apiKey ? PROVIDER_LABELS[provider] : "Não configurado"} ok={!!apiKey} />
  <ConfigItem label="Integração JGRC" value={jgrcConnected ? "Conectado" : "Não configurado"} ok={jgrcConnected} optional />
</div>
```

Substitua por (adiciona 2 linhas pro microfone):

```tsx
<div className="w-full max-w-xs space-y-2">
  <ConfigItem label="Transcrição e Resumo" value={apiKey ? PROVIDER_LABELS[provider] : "Não configurado"} ok={!!apiKey} />
  <ConfigItem
    label="Microfone"
    value={microphones.find((m) => m.id === selectedMic)?.name ?? "Padrão do sistema"}
    ok={true}
  />
  <ConfigItem
    label="Calibração"
    value={calibrated ? "Concluída" : "Pendente"}
    ok={calibrated}
    optional
  />
  <ConfigItem label="Integração JGRC" value={jgrcConnected ? "Conectado" : "Não configurado"} ok={jgrcConnected} optional />
</div>
```

- [ ] **Step 10: Verificar build**

```bash
npm run build
```

Expected: sem erros.

- [ ] **Step 11: Smoke test manual completo**

Pra testar, primeiro **forçar o onboarding** apagando `setup_done` das settings:
- Windows: `%APPDATA%\jgp-meeting\settings.json` — edite e mude `"setup_done": true` pra `false`. Ou rode `Remove-Item %APPDATA%\jgp-meeting\settings.json` pra resetar tudo.

```bash
npm run tauri dev
```

1. App abre direto no SetupWizard.
2. Avance até o passo 3 (deve ser "Seu microfone"). Verifique:
   - Dropdown com microfones do sistema.
   - Caixa informativa sobre calibragem.
   - Botão "Calibrar agora".
3. Mude o microfone no dropdown — confirme que é salvo (abra `settings.json` em outra janela ou re-abra o wizard).
4. Clique "Calibrar agora" → MicCalibrationWizard aparece por cima.
5. Cancele a calibragem → volta pro passo "Seu microfone".
6. Faça calibragem completa até "Aplicar configurações" → onboarding avança automaticamente pro JGRC.
7. Avance até o último passo ("Tudo pronto") e confira que mostra **Microfone: nome do device** e **Calibração: Concluída**.
8. Botão "Pular →" funciona no passo 3.
9. Clique "Começar a usar" — onboarding fecha e app abre normal.

Se algum dos pontos falhar, **NÃO COMMITAR** — corrigir antes.

- [ ] **Step 12: Commit**

```bash
git add src/components/SetupWizard.tsx
git commit -m "feat(onboarding): novo passo Seu microfone com selecao + CTA de calibracao

Passo 3 entre API Key e JGRC. Dropdown de microfones (salva imediato), texto
educativo sobre calibragem, e CTA Calibrar agora que abre o MicCalibrationWizard
por cima — ao concluir, onboarding avanca automaticamente. Tela final mostra
nome do mic selecionado e status da calibragem."
```

---

## Self-Review

**Spec coverage:**

| Seção do spec | Task(s) que implementa |
|---|---|
| §1 Onboarding novo passo | Task 9 |
| §1 onComplete prop | Task 7 |
| §1 ConfigItems no passo "Pronto" | Task 9 step 9 |
| §2 Nova lógica pass/fail | Task 1 |
| §2 gain_max → 12.0 | Task 1 step 2 |
| §2 failure_reason vira código | Task 1 step 1 + Task 6 step 3 |
| §2 UI especial Mic_Mute (dropdown + sound link) | Task 6 step 7 + 8 |
| §3 mic_peak no AudioCaptureState | Task 2 step 1 |
| §3 payload {rms, peak} (3 sites) | Task 2 steps 3-5 |
| §3 CalibrationLevelMeter | Task 4 |
| §3 Integração no wizard (3 telas) | Task 5 |
| §3 Inversão pra silence | Task 4 (lógica do componente) |
| §3 Compat audioCaptureService | Task 3 |
| §4 Bloco 1 precisão estimada | Task 8 (SummaryAccuracyBlock) |
| §4 Bloco 2 antes→depois | Task 8 (SummaryDiffBlock) |
| §4 Bloco 3 por quê | Task 8 (SummaryReasonsBlock + explainChanges) |
| §4 Caso teste pulado | Task 8 step 2 (branch transcription.got === "") |

Tudo coberto.

**Placeholder scan:** Nenhum "TBD"/"implement later"/etc. Todos os steps têm código exato e comandos exatos.

**Type consistency:**
- `MicTestLevel` é definido em Task 3 step 1 (`audioCaptureService.ts`) e usado em Task 4 step 1 (`CalibrationLevelMeter.tsx`) — mesmo nome, mesmos campos `rms` + `peak`. ✓
- `CalibrationResult.failure_reason` redefinido em Task 6 step 3 — bate com strings emitidas pelo Rust em Task 1 step 1 (`"Mic_Mute"`, `"Clipping"`, `"Noise"`). ✓
- `onComplete` adicionado em Task 7 (`MicCalibrationWizard` props), usado em Task 9 step 7 (`SetupWizard`). ✓
- `AudioDevice` importado de `@/types` em vários sites — consistente. ✓
- `handleCalibrationComplete` em Task 9 step 4 chama `setStep((s) => s + 1)` que respeita o novo `TOTAL_STEPS = 6` (Task 9 step 2). ✓
- `currentPresetFromSettings` (Task 8 step 1) é helper compartilhado entre `SummaryDiffBlock` e `explainChanges` — definido uma vez. ✓

---

## Out of Scope

- Migration de settings (quem já tem `setup_done: true` não vai ver o passo novo de microfone — usa o mic padrão até abrir Settings). Documentado e aceitável.
- Perfis de calibragem por microfone (lembrar última calibragem por device).
- Detectar automaticamente o ganho do Windows (ler/setar volume via registry).
- macOS/Linux suporte (WASAPI-only).
