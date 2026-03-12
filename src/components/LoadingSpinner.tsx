// components/LoadingSpinner.tsx
// Componentes de loading: spinner, skeleton e badge de processamento.

import React from "react";
import clsx from "clsx";

interface SpinnerProps {
  size?: "xs" | "sm" | "md" | "lg";
  color?: "primary" | "white" | "muted";
  className?: string;
}

const sizeClasses = {
  xs: "h-3 w-3 border",
  sm: "h-4 w-4 border-2",
  md: "h-6 w-6 border-2",
  lg: "h-8 w-8 border-2",
};

const colorClasses = {
  primary: "border-primary-500 border-t-transparent",
  white: "border-white border-t-transparent",
  muted: "border-surface-300 border-t-surface-600 dark:border-surface-600 dark:border-t-surface-300",
};

export const Spinner: React.FC<SpinnerProps> = ({
  size = "md",
  color = "primary",
  className,
}) => (
  <div
    className={clsx(
      "rounded-full animate-spin",
      sizeClasses[size],
      colorClasses[color],
      className
    )}
    aria-label="Carregando..."
  />
);

interface LoadingOverlayProps {
  message?: string;
  className?: string;
}

export const LoadingOverlay: React.FC<LoadingOverlayProps> = ({
  message = "Carregando...",
  className,
}) => (
  <div
    className={clsx(
      "flex flex-col items-center justify-center gap-3",
      className
    )}
  >
    <Spinner size="lg" />
    <p className="text-sm text-surface-500 dark:text-surface-400 font-medium">{message}</p>
  </div>
);

interface SkeletonProps {
  className?: string;
  lines?: number;
}

export const TextSkeleton: React.FC<SkeletonProps> = ({
  className,
  lines = 3,
}) => (
  <div className={clsx("space-y-2", className)}>
    {Array.from({ length: lines }).map((_, i) => (
      <div
        key={i}
        className={clsx(
          "h-4 bg-surface-100 dark:bg-surface-700/50 rounded animate-pulse",
          i === lines - 1 ? "w-3/4" : "w-full"
        )}
      />
    ))}
  </div>
);

export const CardSkeleton: React.FC<{ className?: string }> = ({ className }) => (
  <div
    className={clsx(
      "bg-white dark:bg-surface-800/40 border border-surface-100 dark:border-surface-700/30 rounded-xl p-4 space-y-3",
      className
    )}
  >
    <div className="h-5 bg-surface-100 dark:bg-surface-700/50 rounded w-1/3 animate-pulse" />
    <div className="space-y-2">
      <div className="h-3 bg-surface-100 dark:bg-surface-700/50 rounded animate-pulse" />
      <div className="h-3 bg-surface-100 dark:bg-surface-700/50 rounded w-5/6 animate-pulse" />
      <div className="h-3 bg-surface-100 dark:bg-surface-700/50 rounded w-4/6 animate-pulse" />
    </div>
  </div>
);

interface ProcessingBadgeProps {
  label?: string;
  className?: string;
}

export const ProcessingBadge: React.FC<ProcessingBadgeProps> = ({
  label = "Transcrevendo...",
  className,
}) => (
  <div
    className={clsx(
      "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full",
      "bg-primary-50 text-primary-700 dark:bg-primary-500/15 dark:text-primary-400 text-xs font-medium",
      className
    )}
  >
    <Spinner size="xs" color="primary" />
    {label}
  </div>
);
