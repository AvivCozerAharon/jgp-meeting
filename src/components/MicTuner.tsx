import React, { useState, useEffect, useCallback, useRef } from "react";
import clsx from "clsx";
import {
  X,
  Mic,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  RotateCcw,
  Loader2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import type { AppSettings, AudioDevice } from "@/types";
import { MicLevelMeter } from "./MicLevelMeter";

interface MicTunerProps {
  settings: AppSettings;
  onUpdateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  onClose: () => void;
}

type TestPhase = "idle" | "countdown" | "recording" | "transcribing" | "done" | "error";

interface TestResult {
  transcript: string;
  avg_rms: string;
  peak: string;
  quality: "good" | "low" | "high" | "no_speech";
  message: string;
}

const NOISE_GATE_PRESETS = [
  { label: "Silenciosa", ratio: 0, hold: 0.3 },
  { label: "Reuniao", ratio: 3, hold: 0.4 },
  { label: "Auditorio", ratio: 6, hold: 0.6 },
];

const Tip: React.FC<{ content: string }> = ({ content }) => {
  const [visible, setVisible] = useState(false);
  return (
    <span className="relative inline-flex items-center flex-shrink-0">
      <button
        type="button"
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        onClick={() => setVisible((v) => !v)}
        className="w-3.5 h-3.5 rounded-full bg-surface-200 dark:bg-surface-700 text-surface-400 dark:text-surface-500 text-[9px] font-bold flex items-center justify-center hover:bg-surface-300 dark:hover:bg-surface-600 transition-colors cursor-help"
        aria-label="Mais informacoes"
      >
        i
      </button>
      {visible && (
        <span className="absolute left-5 top-0 z-50 w-56 p-2 text-[11px] text-surface-600 dark:text-surface-300 bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded-xl shadow-lg leading-relaxed">
          {content}
        </span>
      )}
    </span>
  );
};

export const MicTuner: React.FC<MicTunerProps> = ({ settings, onUpdateSetting, onClose }) => {
  const [micLevel, setMicLevel] = useState(0);
  const [phase, setPhase] = useState<TestPhase>("idle");
  const [countdown, setCountdown] = useState(5);
  const [result, setResult] = useState<TestResult | null>(null);
  const [microphones, setMicrophones] = useState<AudioDevice[]>([]);
  const [error, setError] = useState<string | null>(null);

  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unlistenersRef = useRef<UnlistenFn[]>([]);

  useEffect(() => {
    invoke<AudioDevice[]>("list_microphones")
      .then(setMicrophones)
      .catch(console.error);

    listen<number>("mic-test-level", (e) => setMicLevel(e.payload))
      .then((un) => { unlistenersRef.current.push(un); });

    return () => {
      unlistenersRef.current.forEach((un) => un());
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, []);

  const cleanupCountdown = useCallback(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }, []);

  const startTest = useCallback(async () => {
    cleanupCountdown();
    setResult(null);
    setError(null);
    setPhase("countdown");
    setCountdown(5);
    setMicLevel(0);

    let current = 5;
    countdownRef.current = setInterval(() => {
      current -= 1;
      setCountdown(current);
      if (current <= 0) {
        cleanupCountdown();
        setPhase("recording");

        invoke<TestResult>("test_mic_with_transcription", { durationSecs: 5 })
          .then((res) => {
            setResult(res);
            setPhase("done");
            setMicLevel(0);
          })
          .catch((err: unknown) => {
            setError(String(err));
            setPhase("error");
            setMicLevel(0);
          });
      }
    }, 1000);
  }, [cleanupCountdown]);

  const testAgain = useCallback(() => {
    setPhase("idle");
    setResult(null);
    setError(null);
  }, []);

  const qualityConfig = {
    good: {
      icon: <CheckCircle2 className="w-5 h-5 text-emerald-500" />,
      label: "Qualidade boa",
      description: "A transcricao capturou sua fala corretamente.",
      border: "border-emerald-300 dark:border-emerald-500/40",
      bg: "bg-emerald-50 dark:bg-emerald-500/5",
    },
    low: {
      icon: <AlertTriangle className="w-5 h-5 text-yellow-500" />,
      label: "Volume baixo",
      description: "A transcricao pode estar fraca. Tente aumentar o ganho ou se aproximar do microfone.",
      border: "border-yellow-300 dark:border-yellow-500/40",
      bg: "bg-yellow-50 dark:bg-yellow-500/5",
    },
    high: {
      icon: <AlertTriangle className="w-5 h-5 text-orange-500" />,
      label: "Volume alto",
      description: "Pode haver saturacao. Reduza o ganho ou afaste-se do microfone.",
      border: "border-orange-300 dark:border-orange-500/40",
      bg: "bg-orange-50 dark:bg-orange-500/5",
    },
    no_speech: {
      icon: <AlertCircle className="w-5 h-5 text-red-500" />,
      label: "Sem fala detectada",
      description: "Nenhuma fala foi detectada. Verifique se o microfone esta correto e tente falar mais alto.",
      border: "border-red-300 dark:border-red-500/40",
      bg: "bg-red-50 dark:bg-red-500/5",
    },
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white dark:bg-surface-900 rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-surface-100 dark:border-surface-800">
          <div className="flex items-center gap-2">
            <Mic className="w-5 h-5 text-primary-500" />
            <h2 className="text-base font-bold text-surface-900 dark:text-surface-100">
              Ajustar Microfone
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
          >
            <X className="w-4 h-4 text-surface-500" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <MicLevelMeter level={micLevel} className="p-3 rounded-xl bg-surface-50 dark:bg-surface-800/40 border border-surface-100 dark:border-surface-700/50" />

          <div>
            <label className="text-xs font-medium text-surface-600 dark:text-surface-400 mb-1.5 flex items-center gap-1.5">
              <Mic className="w-3.5 h-3.5" />
              Dispositivo de entrada
              <Tip content="Selecione qual microfone o app deve usar. 'Microfone padrao do sistema' usa o que o Windows tiver configurado como padrao." />
            </label>
            <select
              value={settings.selected_microphone ?? ""}
              onChange={(e) => onUpdateSetting("selected_microphone", e.target.value)}
              className={clsx(
                "w-full px-3 py-2 text-sm rounded-xl border",
                "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
                "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              )}
            >
              {microphones.map((mic) => (
                <option key={mic.id} value={mic.id}>
                  {mic.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-3 pl-3 border-l-2 border-emerald-200 dark:border-emerald-500/30">
            <p className="text-[10px] uppercase tracking-wider font-semibold text-surface-400 dark:text-surface-500">
              Configuracoes do microfone
            </p>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1">
                <p className="text-xs font-medium text-surface-700 dark:text-surface-300">Ganho Automatico (AGC)</p>
                <Tip content="Normaliza automaticamente o volume do microfone para que sua fala fique sempre audivel, mesmo se voce falar mais longe ou mais perto. Recomendado para a maioria dos casos." />
              </div>
              <div
                onClick={() => onUpdateSetting("mic_auto_gain", !settings.mic_auto_gain)}
                className={clsx(
                  "relative w-9 h-[18px] rounded-full transition-colors duration-200 cursor-pointer flex-shrink-0",
                  settings.mic_auto_gain ? "bg-emerald-500" : "bg-surface-200 dark:bg-surface-600"
                )}
              >
                <span
                  className={clsx(
                    "absolute top-[2px] left-[2px] w-3.5 h-3.5 bg-white rounded-full shadow transition-transform duration-200",
                    settings.mic_auto_gain ? "translate-x-[18px]" : "translate-x-0"
                  )}
                />
              </div>
            </div>

            {settings.mic_auto_gain && (
              <div>
                <p className="text-xs font-medium text-surface-700 dark:text-surface-300 mb-1 flex items-center gap-1">
                  Ganho maximo: {settings.mic_gain_max?.toFixed(1) ?? '4.0'}x
                  <Tip content="Limite maximo de amplificacao que o AGC pode aplicar. Valores altos (8x-10x) podem amplificar ruido de fundo. Se o microfone ja for bom, use valores baixos (1.5x-3x)." />
                </p>
                <input
                  type="range"
                  min={1.5}
                  max={10}
                  step={0.5}
                  value={settings.mic_gain_max ?? 4}
                  onChange={(e) => onUpdateSetting("mic_gain_max", parseFloat(e.target.value))}
                  className="w-full accent-emerald-500"
                />
                <div className="flex justify-between text-[10px] text-surface-400 dark:text-surface-500 mt-0.5">
                  <span>1.5x (sutil)</span>
                  <span>10x (maximo)</span>
                </div>
              </div>
            )}

            <div>
              <p className="text-xs font-medium text-surface-700 dark:text-surface-300 mb-1 flex items-center gap-1">
                Sensibilidade: {settings.mic_silence_threshold?.toFixed(3) ?? '0.003'}
                <Tip content="Define o volume minimo para que o microfone seja considerado 'ativo'. Chunks de audio com volume abaixo desse valor sao descartados e nao enviados para transcricao. Valores baixos = capta ate sussurros. Valores altos = ignora ruido de fundo." />
              </p>
              <input
                type="range"
                min={0.001}
                max={0.03}
                step={0.001}
                value={settings.mic_silence_threshold ?? 0.003}
                onChange={(e) => onUpdateSetting("mic_silence_threshold", parseFloat(e.target.value))}
                className="w-full accent-emerald-500"
              />
              <div className="flex justify-between text-[10px] text-surface-400 dark:text-surface-500 mt-0.5">
                <span>Mais sensivel</span>
                <span>Menos sensivel</span>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1">
                  <p className="text-xs font-medium text-surface-700 dark:text-surface-300">
                    Noise gate
                  </p>
                  <Tip content="Filtro inteligente que aprende o nivel de ruido do ambiente e so deixa passar sons acima desse nivel. 'Silenciosa' desativa o filtro. 'Reuniao' e bom para escritorios. 'Auditorio' filtra ruidos de plateia." />
                </div>
                <div className="flex gap-1">
                  {NOISE_GATE_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => {
                        onUpdateSetting("mic_noise_gate_ratio", preset.ratio);
                        onUpdateSetting("mic_noise_gate_hold_secs", preset.hold);
                      }}
                      className={clsx(
                        "px-2 py-0.5 rounded text-[10px] font-medium border transition-colors",
                        settings.mic_noise_gate_ratio === preset.ratio
                          ? "bg-emerald-500 text-white border-emerald-500"
                          : "border-surface-200 dark:border-surface-600 text-surface-500 dark:text-surface-400 hover:border-emerald-400"
                      )}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
              {(settings.mic_noise_gate_ratio ?? 0) > 0 && (
                <>
                  <p className="text-[10px] text-surface-500 dark:text-surface-400 mb-1 flex items-center gap-1">
                    Intensidade
                    <Tip content="Quanto mais agressivo, mais ruido e filtrado. Porem, valores muito altos podem cortar o inicio ou fim das palavras." />
                  </p>
                  <input
                    type="range"
                    min={1.5}
                    max={10}
                    step={0.5}
                    value={settings.mic_noise_gate_ratio ?? 3}
                    onChange={(e) => onUpdateSetting("mic_noise_gate_ratio", parseFloat(e.target.value))}
                    className="w-full accent-emerald-500"
                  />
                  <div className="flex justify-between text-[10px] text-surface-400 dark:text-surface-500 mt-0.5 mb-2">
                    <span>Sutil</span>
                    <span>Agressivo</span>
                  </div>
                  <p className="text-[10px] text-surface-500 dark:text-surface-400 mb-1 flex items-center gap-1">
                    Hold time
                    <Tip content="Tempo que o filtro espera apos a fala acabar antes de cortar. Tempos curtos (0.1s) podem cortar entre palavras. Tempos longos (1.5s) mantem mais contexto mas podem capturar pausas." />
                  </p>
                  <input
                    type="range"
                    min={0.1}
                    max={1.5}
                    step={0.1}
                    value={settings.mic_noise_gate_hold_secs ?? 0.4}
                    onChange={(e) => onUpdateSetting("mic_noise_gate_hold_secs", parseFloat(e.target.value))}
                    className="w-full accent-emerald-500"
                  />
                  <div className="flex justify-between text-[10px] text-surface-400 dark:text-surface-500 mt-0.5">
                    <span>0.1s</span>
                    <span>1.5s</span>
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={startTest}
              disabled={phase === "countdown" || phase === "recording" || phase === "transcribing"}
              className={clsx(
                "flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold transition-all",
                phase === "countdown" || phase === "recording"
                  ? "bg-primary-500/80 text-white cursor-default"
                  : phase === "transcribing"
                    ? "bg-primary-500 text-white cursor-wait"
                    : "bg-primary-500 text-white hover:bg-primary-600 shadow-sm active:scale-[0.98]"
              )}
            >
              {(phase === "countdown" || phase === "recording") && (
                <Mic className="w-4 h-4 animate-pulse" />
              )}
              {phase === "transcribing" && (
                <Loader2 className="w-4 h-4 animate-spin" />
              )}
              {phase === "countdown"
                ? `Fale agora... ${countdown}`
                : phase === "recording"
                  ? "Gravando..."
                  : phase === "transcribing"
                    ? "Transcrevendo..."
                    : "Testar agora"}
            </button>

            {phase === "done" && (
              <button
                onClick={testAgain}
                className="flex items-center gap-1.5 px-4 py-3 rounded-xl text-sm font-medium text-surface-600 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800 border border-surface-200 dark:border-surface-700 transition-all active:scale-[0.98]"
              >
                <RotateCcw className="w-4 h-4" />
                De novo
              </button>
            )}

            {phase === "error" && (
              <button
                onClick={testAgain}
                className="flex items-center gap-1.5 px-4 py-3 rounded-xl text-sm font-medium text-surface-600 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800 border border-surface-200 dark:border-surface-700 transition-all active:scale-[0.98]"
              >
                <RotateCcw className="w-4 h-4" />
                Tentar de novo
              </button>
            )}
          </div>

          {phase === "countdown" && (
            <div className="text-center">
              <p className="text-xs text-surface-500 dark:text-surface-400">
                Fale normalmente. O microfone vai capturar sua voz por 5 segundos.
              </p>
            </div>
          )}

          {result && phase === "done" && (
            <div className={clsx(
              "rounded-xl border p-3 space-y-2",
              qualityConfig[result.quality].border,
              qualityConfig[result.quality].bg
            )}>
              <div className="flex items-center gap-2">
                {qualityConfig[result.quality].icon}
                <span className="text-sm font-semibold text-surface-800 dark:text-surface-200">
                  {qualityConfig[result.quality].label}
                </span>
              </div>
              <p className="text-[11px] text-surface-600 dark:text-surface-400">
                {qualityConfig[result.quality].description}
              </p>

              {result.transcript ? (
                <div className="mt-2 p-2.5 rounded-lg bg-white/60 dark:bg-surface-900/60 border border-surface-200/50 dark:border-surface-700/50">
                  <p className="text-[10px] uppercase tracking-wider font-semibold text-surface-400 mb-1">
                    Transcricao
                  </p>
                  <p className="text-sm text-surface-700 dark:text-surface-200 leading-relaxed italic">
                    &ldquo;{result.transcript}&rdquo;
                  </p>
                </div>
              ) : (
                <p className="text-sm text-surface-500 italic mt-1">
                  Nenhuma transcricao obtida.
                </p>
              )}

              <div className="flex gap-4 text-[10px] text-surface-400 dark:text-surface-500 font-mono mt-1">
                <span>RMS: {result.avg_rms}</span>
                <span>Pico: {result.peak}</span>
              </div>

              {result.quality !== "good" && (
                <p className="text-xs text-surface-500 dark:text-surface-400 mt-1">
                  Ajuste os controles acima e clique <strong>&ldquo;De novo&rdquo;</strong> para testar com as novas configuracoes.
                </p>
              )}
            </div>
          )}

          {error && phase === "error" && (
            <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl">
              <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-red-700 dark:text-red-400">{error}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
