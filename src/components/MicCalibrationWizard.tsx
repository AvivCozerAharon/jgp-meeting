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
  const [calibration, setCalibration] = useState<CalibrationResult | null>(null);
  const [transcription, setTranscription] = useState<TranscriptionResult | null>(null);
  const [transcriptionRetries, setTranscriptionRetries] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
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

  // pre-check — auto-run on mount
  useEffect(() => {
    if (step !== "pre-check") return;
    invoke<{ avg_rms: number }>("measure_ambient_noise")
      .then(({ avg_rms }) => {
        setStep(avg_rms > 0.015 ? "ambient-warning" : "speech-ready");
      })
      .catch((e: unknown) => {
        setErrorMsg(String(e));
        setStep("error");
      });
  }, [step]);

  // speech-countdown
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

  // silence-recording
  useEffect(() => {
    if (step !== "silence-recording") return;
    setMicLevel(0);
    subscribeToLevel().then(() => {
      invoke("record_calibration_phase", { phase: "silence" })
        .then(() => setStep("computing"))
        .catch((e: unknown) => { setErrorMsg(String(e)); setStep("error"); });
    }).catch((e: unknown) => { setErrorMsg(String(e)); setStep("error"); });
  }, [step, subscribeToLevel]);

  // computing
  useEffect(() => {
    if (step !== "computing") return;
    invoke<CalibrationResult>("compute_calibration")
      .then((result) => {
        setCalibration(result);
        if (result.round_passed || round >= 3) {
          setStep("transcription-ready");
        } else {
          setStep("round-failed");
          if (result.failure_reason) setSpeechInstructions(result.failure_reason);
        }
      })
      .catch((e: unknown) => { setErrorMsg(String(e)); setStep("error"); });
  }, [step, round]);

  // transcription-recording
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
        .catch((e: unknown) => { setErrorMsg(String(e)); setStep("error"); });
    }).catch((e: unknown) => { setErrorMsg(String(e)); setStep("error"); });
  }, [step, calibration, subscribeToLevel]);

  const handleStartSpeech = useCallback(() => setStep("speech-countdown"), []);

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

  const showProgressDots = step !== "pre-check" && step !== "error" && step !== "ambient-warning";

  const inCalibrationPhase = [
    "speech-ready", "speech-countdown", "speech-recording",
    "silence-recording", "computing", "round-failed",
  ].includes(step);

  const inTranscriptionPhase = [
    "transcription-ready", "transcription-recording", "transcription-result",
  ].includes(step);

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
          {showProgressDots && (
            <div className="flex items-center justify-center gap-2">
              <StepDot
                active={inCalibrationPhase}
                done={inTranscriptionPhase || step === "summary"}
                label="Calibração"
              />
              <div className="w-8 h-px bg-surface-200 dark:bg-surface-700" />
              <StepDot
                active={inTranscriptionPhase}
                done={step === "summary"}
                label="Teste de voz"
              />
              <div className="w-8 h-px bg-surface-200 dark:bg-surface-700" />
              <StepDot active={step === "summary"} done={false} label="Resultado" />
            </div>
          )}

          {/* pre-check */}
          {step === "pre-check" && (
            <div className="text-center py-4">
              <Loader2 className="w-8 h-8 text-primary-500 animate-spin mx-auto mb-3" />
              <p className="text-sm font-medium text-surface-700 dark:text-surface-300">
                Verificando o ambiente...
              </p>
            </div>
          )}

          {/* ambient-warning */}
          {step === "ambient-warning" && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 bg-yellow-50 dark:bg-yellow-500/10 border border-yellow-200 dark:border-yellow-500/20 rounded-xl">
                <AlertTriangle className="w-5 h-5 text-yellow-500 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-yellow-800 dark:text-yellow-300">
                    Ambiente barulhento detectado
                  </p>
                  <p className="text-xs text-yellow-700 dark:text-yellow-400 mt-1">
                    Detectamos ruído de fundo no seu ambiente. A calibração pode ser menos precisa. Recomendamos calibrar num ambiente mais silencioso.
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

          {/* speech-ready */}
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

          {/* speech-countdown */}
          {step === "speech-countdown" && (
            <div className="text-center py-4 space-y-3">
              <div className="text-5xl font-bold text-primary-500">{countdown}</div>
              <p className="text-sm text-surface-500 dark:text-surface-400">Prepare-se para falar...</p>
            </div>
          )}

          {/* speech-recording */}
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

          {/* silence-recording */}
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

          {/* computing */}
          {step === "computing" && (
            <div className="text-center py-4">
              <Loader2 className="w-8 h-8 text-primary-500 animate-spin mx-auto mb-3" />
              <p className="text-sm font-medium text-surface-700 dark:text-surface-300">
                Calculando as melhores configurações...
              </p>
            </div>
          )}

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

          {/* transcription-ready */}
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

          {/* transcription-recording */}
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

          {/* transcription-result */}
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

          {/* summary */}
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

          {/* error */}
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
                onClick={() => {
                  setStep("pre-check");
                  setRound(1);
                  setCalibration(null);
                  setTranscription(null);
                  setTranscriptionRetries(0);
                  setSpeechInstructions(
                    "Fale normalmente por 5 segundos — conte o que você está fazendo hoje, por exemplo."
                  );
                }}
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

// ── Sub-components ───────────────────────────────────────────────────────────

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

  if (recommended.mic_auto_gain && Math.abs(recommended.mic_gain_max - (current.mic_gain_max ?? 4)) > 0.1) {
    if (recommended.mic_gain_max > (current.mic_gain_max ?? 4)) {
      lines.push(`Amplificamos seu microfone (nível máximo: ${recommended.mic_gain_max.toFixed(1)}×)`);
    } else {
      lines.push(`Reduzimos a amplificação (nível máximo: ${recommended.mic_gain_max.toFixed(1)}×)`);
    }
  }

  if (Math.abs(recommended.mic_silence_threshold - (current.mic_silence_threshold ?? 0.003)) > 0.0005) {
    lines.push("Corte de silêncio ajustado para o seu ambiente");
  }

  const currentRatio = current.mic_noise_gate_ratio ?? 0;
  const currentPreset = currentRatio === 0 ? "silent" : currentRatio <= 3 ? "meeting" : "auditorium";
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
