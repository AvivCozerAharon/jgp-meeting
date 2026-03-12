// components/TranscriptionPanel.tsx
// Painel de transcrição em tempo real.

import React, { useEffect, useRef } from "react";
import clsx from "clsx";
import { FileText, Copy, Check } from "lucide-react";
import { ProcessingBadge } from "./LoadingSpinner";
import { RecordingDot } from "./AudioIndicator";

interface TranscriptionPanelProps {
  transcript: string;
  isCapturing: boolean;
  isProcessing: boolean;
  duration?: number;
  className?: string;
}

function formatTimer(secs: number): string {
  const m = Math.floor(secs / 60).toString().padStart(2, "0");
  const s = (secs % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

export const TranscriptionPanel: React.FC<TranscriptionPanelProps> = ({
  transcript,
  isCapturing,
  isProcessing,
  duration = 0,
  className,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = React.useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [transcript]);

  const handleCopy = async () => {
    if (!transcript) return;
    try {
      await navigator.clipboard.writeText(transcript);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback silencioso
    }
  };

  const isEmpty = !transcript.trim();

  return (
    <div
      className={clsx(
        "flex flex-col rounded-2xl overflow-hidden",
        "bg-white border border-surface-100 shadow-card",
        "dark:bg-surface-800/60 dark:border-surface-700/50 dark:shadow-none",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-100 dark:border-surface-700/50 flex-shrink-0">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-surface-400 dark:text-surface-500" />
          <span className="text-sm font-semibold text-surface-700 dark:text-surface-200">Transcrição</span>

          {isCapturing && (
            <div className="flex items-center gap-1.5 ml-1">
              <RecordingDot isActive />
              <span className="text-xs font-mono text-primary-600 dark:text-primary-400 font-medium">
                {formatTimer(duration)}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {isProcessing && <ProcessingBadge />}

          {!isEmpty && (
            <button
              onClick={handleCopy}
              title="Copiar transcrição"
              className={clsx(
                "flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium",
                "transition-all duration-150",
                copied
                  ? "bg-primary-50 text-primary-600 dark:bg-primary-500/20 dark:text-primary-400"
                  : "text-surface-400 hover:text-surface-600 hover:bg-surface-50 dark:hover:text-surface-300 dark:hover:bg-surface-700/50"
              )}
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  Copiado!
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  Copiar
                </>
              )}
            </button>
          )}

          {!isEmpty && (
            <span className="text-xs text-surface-400 dark:text-surface-500">
              {transcript.split(/\s+/).filter(Boolean).length} palavras
            </span>
          )}
        </div>
      </div>

      {/* Conteúdo */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 min-h-0"
        style={{ scrollBehavior: "smooth" }}
      >
        {isEmpty ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-center py-12">
            <div
              className={clsx(
                "w-12 h-12 rounded-full flex items-center justify-center",
                isCapturing
                  ? "bg-primary-50 dark:bg-primary-500/10 animate-pulse-slow"
                  : "bg-surface-50 dark:bg-surface-800"
              )}
            >
              <FileText
                className={clsx(
                  "w-6 h-6",
                  isCapturing ? "text-primary-400" : "text-surface-300 dark:text-surface-600"
                )}
              />
            </div>
            <div>
              <p className="text-sm font-medium text-surface-500 dark:text-surface-400">
                {isCapturing
                  ? "Aguardando fala..."
                  : "Nenhuma transcrição ainda"}
              </p>
              <p className="text-xs text-surface-400 dark:text-surface-500 mt-1">
                {isCapturing
                  ? "O texto aparecerá aqui conforme a reunião avança"
                  : "Pressione Start Listening para iniciar"}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-0">
            <p className="text-sm leading-relaxed text-surface-700 dark:text-surface-300 whitespace-pre-wrap font-mono selection:bg-primary-100 dark:selection:bg-primary-500/30">
              {transcript}
              {isCapturing && (
                <span className="inline-block w-0.5 h-4 bg-primary-500 ml-0.5 align-middle animate-pulse" />
              )}
            </p>
          </div>
        )}
      </div>

      {/* Footer */}
      {!isEmpty && (
        <div className="px-4 py-2 border-t border-surface-50 dark:border-surface-700/30 bg-surface-50/50 dark:bg-surface-900/30 flex-shrink-0">
          <p className="text-xs text-surface-400 dark:text-surface-500">
            {transcript.length.toLocaleString("pt-BR")} caracteres
          </p>
        </div>
      )}
    </div>
  );
};
