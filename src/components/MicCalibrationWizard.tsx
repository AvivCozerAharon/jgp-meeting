import { useState, useEffect, useCallback, useRef } from "react";
import clsx from "clsx";
import {
  X, Mic, CheckCircle2, AlertCircle, AlertTriangle,
  ChevronRight, RotateCcw, Loader2, VolumeX,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, CalibrationSnapshot } from "@/types";
import { listMicrophones } from "@/services/audioCaptureService";
import { saveSettings } from "@/services/storageService";
import { CalibrationLevelMeter } from "./CalibrationLevelMeter";

interface MicCalibrationWizardProps {
  settings: AppSettings;
  onApply: (patch: Partial<AppSettings>) => void;
  onSaveSnapshot?: (snapshot: CalibrationSnapshot) => void;
  onClose: () => void;
  /** Disparado APENAS após calibração bem-sucedida (apply). Cancel/close NÃO dispara. */
  onComplete?: () => void;
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
  failure_reason: "Mic_Mute" | "Clipping" | "Noise" | null;
}

interface TranscriptionResult {
  similarity: number;
  expected: string;
  got: string;
  passed: boolean;
  diagnosis: string;
}

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

const FAILURE_MESSAGES: Record<"Clipping" | "Noise", string> = {
  Clipping: "Você está muito perto do microfone. Recue um pouco e tente novamente.",
  Noise: "Muito ruído de fundo — tente se afastar de fontes de ruído ou aproximar o microfone.",
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

export function MicCalibrationWizard({ settings, onApply, onSaveSnapshot, onClose, onComplete }: MicCalibrationWizardProps) {
  const [step, setStep] = useState<Step>("pre-check");
  const [profileName, setProfileName] = useState("");
  const [countdown, setCountdown] = useState(COUNTDOWN_SECS);
  const [round, setRound] = useState(1);
  const [speechInstructions, setSpeechInstructions] = useState(
    "Fale normalmente por 5 segundos — conte o que você está fazendo hoje, por exemplo."
  );
  const [calibration, setCalibration] = useState<CalibrationResult | null>(null);
  const [transcription, setTranscription] = useState<TranscriptionResult | null>(null);
  const [microphones, setMicrophones] = useState<{ id: string; name: string }[]>([]);
  const [selectedMic, setSelectedMic] = useState<string>(settings.selected_microphone ?? "");
  const [transcriptionRetries, setTranscriptionRetries] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");

  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearCountdown = useCallback(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
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
    invoke("record_calibration_phase", { phase: "speech" })
      .then(() => setStep("silence-recording"))
      .catch((e: unknown) => { setErrorMsg(String(e)); setStep("error"); });
  }, [step]);

  // silence-recording
  useEffect(() => {
    if (step !== "silence-recording") return;
    invoke("record_calibration_phase", { phase: "silence" })
      .then(() => setStep("computing"))
      .catch((e: unknown) => { setErrorMsg(String(e)); setStep("error"); });
  }, [step]);

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
          // Mapeia código → mensagem PT-BR para reuso do speech-ready banner.
          // Mic_Mute tem UI dedicada e não precisa de speechInstructions.
          if (result.failure_reason === "Clipping" || result.failure_reason === "Noise") {
            setSpeechInstructions(FAILURE_MESSAGES[result.failure_reason]);
          }
        }
      })
      .catch((e: unknown) => { setErrorMsg(String(e)); setStep("error"); });
  }, [step, round]);

  // Carrega lista de mics quando o caso Mic_Mute aparece
  useEffect(() => {
    if (step === "round-failed" && calibration?.failure_reason === "Mic_Mute") {
      listMicrophones()
        .then(setMicrophones)
        .catch((e) => console.error("Erro ao listar microfones:", e));
    }
  }, [step, calibration]);

  // transcription-recording
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
            <CalibrationLevelMeter mode="speech" durationSecs={5} />
          )}

          {/* silence-recording */}
          {step === "silence-recording" && (
            <CalibrationLevelMeter mode="silence" durationSecs={3} />
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
                onClick={() => invoke("open_windows_sound_panel").catch(() => {})}
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
              <div className="p-3 bg-primary-50 dark:bg-primary-500/10 rounded-xl border border-primary-100 dark:border-primary-500/20">
                <p className="text-sm font-medium text-primary-800 dark:text-primary-200 leading-relaxed">
                  "A reunião de alinhamento com o cliente começa às quatorze horas na sala de conferências."
                </p>
              </div>
              <CalibrationLevelMeter mode="speech" durationSecs={6} />
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
