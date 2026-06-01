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
