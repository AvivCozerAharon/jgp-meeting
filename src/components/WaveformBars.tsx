// components/WaveformBars.tsx
import React, { useEffect, useRef, useState } from "react";
import clsx from "clsx";

interface WaveformBarsProps {
  level: number       // 0.0–1.0
  isActive: boolean
  color?: string      // tailwind bg class, e.g. "bg-blue-500"
  barCount?: number   // default 12
  className?: string
}

const BAR_FACTORS = [0.4, 0.6, 0.8, 1.0, 0.9, 0.7, 1.0, 0.8, 0.6, 0.9, 0.5, 0.7];

function scaleLevel(raw: number): number {
  return Math.min(1.0, Math.sqrt(raw * 12));
}

export const WaveformBars: React.FC<WaveformBarsProps> = ({
  level,
  isActive,
  color = "bg-primary-500",
  barCount = 12,
  className,
}) => {
  const [noise, setNoise] = useState<number[]>(() => BAR_FACTORS.slice(0, barCount));
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isActive) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
      setNoise(Array.from({ length: barCount }, () => 0));
      return;
    }
    intervalRef.current = setInterval(() => {
      setNoise(Array.from({ length: barCount }, (_, i) => {
        const base = BAR_FACTORS[i % BAR_FACTORS.length];
        return base * (0.6 + Math.random() * 0.8);
      }));
    }, 80);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isActive, barCount]);

  return (
    <div
      className={clsx("flex items-end gap-px", className)}
      style={{ height: 20 }}
      aria-hidden
    >
      {Array.from({ length: barCount }).map((_, i) => {
        const factor = isActive ? noise[i] ?? 0 : 0;
        const displayLevel = scaleLevel(level);
        const height = isActive
          ? Math.max(2, Math.round(factor * displayLevel * 20))
          : 2;
        return (
          <div
            key={i}
            className={clsx("rounded-sm transition-all duration-75", color)}
            style={{ width: 2, height }}
          />
        );
      })}
    </div>
  );
};
