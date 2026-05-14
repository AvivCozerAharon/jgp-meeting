import React, { useEffect, useRef } from "react";
import clsx from "clsx";

interface MicLevelMeterProps {
  level: number;
  className?: string;
}

const NUM_BARS = 32;

function getBarClasses(normalizedIndex: number, isActive: boolean): string {
  if (!isActive) return "bg-surface-200 dark:bg-surface-700";

  if (normalizedIndex < 0.6) return "bg-emerald-500 dark:bg-emerald-400";
  if (normalizedIndex < 0.8) return "bg-yellow-400 dark:bg-yellow-300";
  if (normalizedIndex < 0.92) return "bg-orange-500 dark:bg-orange-400";
  return "bg-red-500 dark:bg-red-400";
}

function scaleLevel(rawRms: number): number {
  return Math.min(1.0, Math.sqrt(rawRms * 12));
}

function getLabel(rawRms: number): { text: string; color: string } {
  if (rawRms < 0.005) return { text: "Sem sinal", color: "text-yellow-500" };
  if (rawRms < 0.01) return { text: "Muito baixo", color: "text-yellow-500" };
  if (rawRms < 0.05) return { text: "Nivel bom", color: "text-emerald-500" };
  if (rawRms < 0.15) return { text: "Alto", color: "text-orange-500" };
  return { text: "Saturando", color: "text-red-500" };
}

export const MicLevelMeter: React.FC<MicLevelMeterProps> = ({ level, className }) => {
  const smoothedRef = useRef(level);

  useEffect(() => {
    smoothedRef.current = smoothedRef.current * 0.6 + level * 0.4;
  });

  const smoothed = smoothedRef.current;
  const displayLevel = scaleLevel(smoothed);
  const activeBars = Math.round(displayLevel * NUM_BARS);
  const label = getLabel(smoothed);

  return (
    <div className={clsx("space-y-1.5", className)}>
      <div className="flex items-end gap-[2px]" style={{ height: 28 }} aria-hidden>
        {Array.from({ length: NUM_BARS }).map((_, i) => {
          const idx = i / NUM_BARS;
          const isActive = i < activeBars;
          return (
            <div
              key={i}
              className={clsx(
                "rounded-[1px] transition-all duration-75 w-full",
                getBarClasses(idx, isActive)
              )}
              style={{
                height: "100%",
                opacity: isActive ? 1 : 0.3,
              }}
            />
          );
        })}
      </div>
      <div className="flex justify-between items-center">
        <span className="text-[10px] text-surface-400 dark:text-surface-500 font-mono">
          RMS {smoothed.toFixed(4)}
        </span>
        <span className={clsx("text-[10px] font-medium", label.color)}>
          {label.text}
        </span>
      </div>
    </div>
  );
};
