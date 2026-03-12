// components/AudioIndicator.tsx
// Indicador visual de áudio: exibe barras animadas quando o app está
// capturando áudio, com altura proporcional ao nível de áudio atual.

import React from "react";
import clsx from "clsx";

interface AudioIndicatorProps {
  isActive: boolean;
  level?: number;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const NUM_BARS = 5;

export const AudioIndicator: React.FC<AudioIndicatorProps> = ({
  isActive,
  level = 0,
  size = "md",
  className,
}) => {
  const heightClasses = {
    sm: "h-3",
    md: "h-5",
    lg: "h-8",
  };

  const widthClasses = {
    sm: "w-0.5",
    md: "w-1",
    lg: "w-1.5",
  };

  const getBarStyle = (index: number): React.CSSProperties => {
    if (!isActive) {
      return { transform: "scaleY(0.25)", opacity: 0.3 };
    }

    const centerIndex = Math.floor(NUM_BARS / 2);
    const distanceFromCenter = Math.abs(index - centerIndex);
    const baseFactor = 1 - distanceFromCenter * 0.15;
    const scaledLevel = Math.max(0.2, level * 2);
    const scaleY = Math.min(1, baseFactor * scaledLevel);
    const delays = [0, 100, 200, 100, 0];

    return {
      transform: `scaleY(${Math.max(0.15, scaleY)})`,
      transition: "transform 0.1s ease-out",
      animationDelay: `${delays[index]}ms`,
    };
  };

  return (
    <div
      className={clsx("flex items-center gap-0.5", className)}
      aria-label={isActive ? "Capturando áudio" : "Microfone inativo"}
    >
      {Array.from({ length: NUM_BARS }).map((_, i) => (
        <div
          key={i}
          className={clsx(
            widthClasses[size],
            heightClasses[size],
            "rounded-full origin-bottom transition-all duration-100",
            isActive
              ? "bg-primary-500"
              : "bg-surface-300 dark:bg-surface-600"
          )}
          style={{
            ...getBarStyle(i),
            animationName: isActive ? "wave" : "none",
            animationDuration: "0.8s",
            animationTimingFunction: "ease-in-out",
            animationIterationCount: "infinite",
            animationDelay: `${i * 0.1}s`,
          }}
        />
      ))}
    </div>
  );
};

export const RecordingDot: React.FC<{ isActive: boolean; className?: string }> = ({
  isActive,
  className,
}) => (
  <div className={clsx("relative flex items-center justify-center", className)}>
    {isActive && (
      <span className="absolute inline-flex h-3 w-3 rounded-full bg-primary-400 opacity-75 animate-ping" />
    )}
    <span
      className={clsx(
        "relative inline-flex h-2.5 w-2.5 rounded-full",
        isActive ? "bg-primary-500" : "bg-surface-300 dark:bg-surface-600"
      )}
    />
  </div>
);
