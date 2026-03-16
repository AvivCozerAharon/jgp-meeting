// components/TranscriptionPanel.tsx
// Painel de transcrição em tempo real com segmentação visual por fonte.

import React, { useEffect, useRef, useMemo } from "react";
import clsx from "clsx";
import { FileText, Copy, Check, Mic, Volume2 } from "lucide-react";
import { ProcessingBadge } from "./LoadingSpinner";
import { RecordingDot } from "./AudioIndicator";

interface TranscriptionPanelProps {
  transcript: string;
  isCapturing: boolean;
  isProcessing: boolean;
  duration?: number;
  className?: string;
}

// ─── Parser de segmentos ──────────────────────────────────────────────────────

type SegmentSource = "mic" | "system" | null;

interface Segment {
  source: SegmentSource;
  text: string;
}

/**
 * Divide o texto da transcrição em segmentos baseados nos prefixos [Você] e [Reunião].
 * Transcrições antigas sem prefixos são retornadas como segmento único sem source.
 */
export function parseTranscript(text: string): Segment[] {
  if (!text.trim()) return [];

  // Split mantendo os delimitadores [Você] e [Reunião]
  const parts = text.split(/(\[(?:Você|Reunião)\])/);
  const segments: Segment[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (part === "[Você]") {
      const nextText = parts[i + 1]?.trim() || "";
      if (nextText) {
        segments.push({ source: "mic", text: nextText });
      }
      i++; // pula o texto já consumido
    } else if (part === "[Reunião]") {
      const nextText = parts[i + 1]?.trim() || "";
      if (nextText) {
        segments.push({ source: "system", text: nextText });
      }
      i++;
    } else if (part.trim()) {
      // Texto sem tag (transcrições antigas ou texto inicial)
      segments.push({ source: null, text: part.trim() });
    }
  }

  return segments;
}

// ─── Componente de segmento ───────────────────────────────────────────────────

const SegmentBlock: React.FC<{ segment: Segment; isLast: boolean; isCapturing: boolean }> = ({
  segment,
  isLast,
  isCapturing,
}) => {
  const { source, text } = segment;

  if (source === null) {
    // Texto sem tag (transcrições antigas) — renderiza simples
    return (
      <div className="py-1">
        <p className="text-sm leading-relaxed text-surface-700 dark:text-surface-300 whitespace-pre-wrap selection:bg-primary-100 dark:selection:bg-primary-500/30">
          {text}
          {isLast && isCapturing && <CursorBlink />}
        </p>
      </div>
    );
  }

  const isMic = source === "mic";

  return (
    <div
      className={clsx(
        "py-2 px-3 rounded-lg",
        isMic
          ? "bg-emerald-50/60 dark:bg-emerald-500/5 border-l-2 border-emerald-400 dark:border-emerald-500/40"
          : "bg-blue-50/60 dark:bg-blue-500/5 border-l-2 border-blue-400 dark:border-blue-500/40"
      )}
    >
      {/* Badge da fonte */}
      <div className="flex items-center gap-1.5 mb-1">
        {isMic ? (
          <>
            <Mic className="w-3 h-3 text-emerald-500 dark:text-emerald-400" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
              Você
            </span>
          </>
        ) : (
          <>
            <Volume2 className="w-3 h-3 text-blue-500 dark:text-blue-400" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">
              Reunião
            </span>
          </>
        )}
      </div>

      {/* Texto do segmento */}
      <p className="text-sm leading-relaxed text-surface-700 dark:text-surface-300 whitespace-pre-wrap selection:bg-primary-100 dark:selection:bg-primary-500/30">
        {text}
        {isLast && isCapturing && <CursorBlink />}
      </p>
    </div>
  );
};

const CursorBlink: React.FC = () => (
  <span className="inline-block w-0.5 h-4 bg-primary-500 ml-0.5 align-middle animate-pulse" />
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTimer(secs: number): string {
  const m = Math.floor(secs / 60).toString().padStart(2, "0");
  const s = (secs % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

// ─── Componente principal ─────────────────────────────────────────────────────

export const TranscriptionPanel: React.FC<TranscriptionPanelProps> = ({
  transcript,
  isCapturing,
  isProcessing,
  duration = 0,
  className,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = React.useState(false);

  const segments = useMemo(() => parseTranscript(transcript), [transcript]);

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
          <div className="space-y-2">
            {segments.map((seg, i) => (
              <SegmentBlock
                key={i}
                segment={seg}
                isLast={i === segments.length - 1}
                isCapturing={isCapturing}
              />
            ))}
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
