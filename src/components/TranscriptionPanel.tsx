// components/TranscriptionPanel.tsx
import React, { useEffect, useRef, useState, useCallback } from "react";
import clsx from "clsx";
import { FileText, Copy, Check, Mic, Volume2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { ProcessingBadge } from "./LoadingSpinner";
import { RecordingDot } from "./AudioIndicator";
import type { TranscriptSegment } from "@/types";

// ─── parseTranscript export (kept for backward compat with HistoryPage) ────────

type SegmentSource = "mic" | "system" | null;

interface ParsedSegment {
  source: SegmentSource;
  text: string;
}

/**
 * Divide o texto da transcrição em segmentos baseados nos prefixos [Você] e [Reunião].
 * Transcrições antigas sem prefixos são retornadas como segmento único sem source.
 */
export function parseTranscript(text: string): ParsedSegment[] {
  if (!text.trim()) return [];

  const parts = text.split(/(\[(?:Você|Reunião)\])/);
  const segments: ParsedSegment[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (part === "[Você]") {
      const nextText = parts[i + 1]?.trim() || "";
      if (nextText) {
        segments.push({ source: "mic", text: nextText });
      }
      i++;
    } else if (part === "[Reunião]") {
      const nextText = parts[i + 1]?.trim() || "";
      if (nextText) {
        segments.push({ source: "system", text: nextText });
      }
      i++;
    } else if (part.trim()) {
      segments.push({ source: null, text: part.trim() });
    }
  }

  return segments;
}

// ─── TranscriptionPanel ───────────────────────────────────────────────────────

interface TranscriptionPanelProps {
  segments: TranscriptSegment[];
  /** Transcript plano para reuniões antigas (sem segments) */
  legacyTranscript?: string;
  /** Meeting ID — necessário para persistir edições. Null durante gravação ao vivo. */
  meetingId?: string | null;
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

const SIMULTANEOUS_THRESHOLD_MS = 2000;

interface SegmentRowProps {
  segment: TranscriptSegment;
  index: number;
  isLast: boolean;
  isCapturing: boolean;
  meetingId: string | null | undefined;
  showSimultaneousMarker: boolean;
}

const SegmentRow: React.FC<SegmentRowProps> = ({
  segment,
  index: _index,
  isLast,
  isCapturing,
  meetingId,
  showSimultaneousMarker,
}) => {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(segment.text);
  // displayText tracks the last saved value locally so the UI doesn't revert
  // to the stale prop after save (parent never re-fetches segments on edit)
  const [displayText, setDisplayText] = useState(segment.text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync from prop only when the segment text changes externally (not on edit toggle)
  useEffect(() => {
    if (!editing) {
      setEditText(segment.text);
      setDisplayText(segment.text);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment.text]);

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const handleClick = useCallback(() => {
    if (!isCapturing) setEditing(true);
  }, [isCapturing]);

  const handleSave = useCallback(async () => {
    setEditing(false);
    const trimmed = editText.trim();
    if (trimmed === displayText || !meetingId) return;
    setDisplayText(trimmed);
    setEditText(trimmed);
    try {
      await invoke("update_meeting_segment", {
        meetingId,
        timestampMs: segment.timestamp_ms,
        text: trimmed,
      });
    } catch (e) {
      console.error("Erro ao salvar segmento:", e);
      setDisplayText(displayText);
      setEditText(displayText);
    }
  }, [editText, displayText, segment.timestamp_ms, meetingId]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      textareaRef.current?.blur();
    } else if (e.key === "Escape") {
      setEditing(false);
      setEditText(displayText);
    }
  }, [displayText]);

  const isMic = segment.source === "mic";

  return (
    <>
      {showSimultaneousMarker && (
        <div className="flex items-center gap-2 my-1">
          <div className="flex-1 border-t border-dashed border-surface-200 dark:border-surface-700" />
          <span className="text-[9px] text-surface-300 dark:text-surface-600 flex-shrink-0">simultâneo</span>
          <div className="flex-1 border-t border-dashed border-surface-200 dark:border-surface-700" />
        </div>
      )}
      <div
        className={clsx(
          "py-2 px-3 rounded-lg group",
          !isCapturing && "cursor-text hover:ring-1 hover:ring-surface-200 dark:hover:ring-surface-700",
          isMic
            ? "bg-emerald-50/60 dark:bg-emerald-500/5 border-l-2 border-emerald-400 dark:border-emerald-500/40"
            : "bg-blue-50/60 dark:bg-blue-500/5 border-l-2 border-blue-400 dark:border-blue-500/40"
        )}
        onClick={handleClick}
      >
        <div className="flex items-center gap-1.5 mb-1">
          {isMic ? (
            <>
              <Mic className="w-3 h-3 text-emerald-500 dark:text-emerald-400" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">Você</span>
            </>
          ) : (
            <>
              <Volume2 className="w-3 h-3 text-blue-500 dark:text-blue-400" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">Reunião</span>
            </>
          )}
        </div>

        {editing ? (
          <textarea
            ref={textareaRef}
            value={editText}
            onChange={e => setEditText(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            className={clsx(
              "w-full text-sm leading-relaxed resize-none bg-transparent outline-none",
              "text-surface-700 dark:text-surface-300",
              "border-b border-primary-400 dark:border-primary-500"
            )}
            rows={Math.max(2, editText.split("\n").length)}
          />
        ) : (
          <p className="text-sm leading-relaxed text-surface-700 dark:text-surface-300 whitespace-pre-wrap selection:bg-primary-100 dark:selection:bg-primary-500/30">
            {displayText}
            {isLast && isCapturing && (
              <span className="inline-block w-0.5 h-4 bg-primary-500 ml-0.5 align-middle animate-pulse" />
            )}
          </p>
        )}
      </div>
    </>
  );
};

export const TranscriptionPanel: React.FC<TranscriptionPanelProps> = ({
  segments,
  legacyTranscript,
  meetingId,
  isCapturing,
  isProcessing,
  duration = 0,
  className,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const [copied, setCopied] = useState(false);

  const hasSegments = segments.length > 0;
  const hasLegacy = !hasSegments && !!legacyTranscript?.trim();
  const isEmpty = !hasSegments && !hasLegacy;

  const fullText = hasSegments
    ? segments.map(s => s.text).join(" ")
    : legacyTranscript ?? "";

  useEffect(() => {
    if (!isCapturing) {
      isAtBottomRef.current = true;
      return;
    }
    if (!isAtBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [segments, isCapturing]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    isAtBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
  }, []);

  const handleCopy = async () => {
    if (!fullText) return;
    try {
      await navigator.clipboard.writeText(fullText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <div
      className={clsx(
        "flex flex-col rounded-2xl overflow-hidden",
        "bg-white border border-surface-100 shadow-card",
        "dark:bg-surface-800/60 dark:border-surface-700/50 dark:shadow-none",
        className
      )}
    >
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
                "flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-all duration-150",
                copied
                  ? "bg-primary-50 text-primary-600 dark:bg-primary-500/20 dark:text-primary-400"
                  : "text-surface-400 hover:text-surface-600 hover:bg-surface-50 dark:hover:text-surface-300 dark:hover:bg-surface-700/50"
              )}
            >
              {copied ? <><Check className="w-3.5 h-3.5" />Copiado!</> : <><Copy className="w-3.5 h-3.5" />Copiar</>}
            </button>
          )}
          {!isEmpty && (
            <span className="text-xs text-surface-400 dark:text-surface-500">
              {fullText.split(/\s+/).filter(Boolean).length} palavras
            </span>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 min-h-0" onScroll={handleScroll}>
        {isEmpty ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-center py-12">
            <div className={clsx("w-12 h-12 rounded-full flex items-center justify-center", isCapturing ? "bg-primary-50 dark:bg-primary-500/10 animate-pulse-slow" : "bg-surface-50 dark:bg-surface-800")}>
              <FileText className={clsx("w-6 h-6", isCapturing ? "text-primary-400" : "text-surface-300 dark:text-surface-600")} />
            </div>
            <div>
              <p className="text-sm font-medium text-surface-500 dark:text-surface-400">
                {isCapturing ? "Aguardando fala..." : "Nenhuma transcrição ainda"}
              </p>
              <p className="text-xs text-surface-400 dark:text-surface-500 mt-1">
                {isCapturing ? "O texto aparecerá aqui conforme a reunião avança" : "Pressione Start Listening para iniciar"}
              </p>
            </div>
          </div>
        ) : hasLegacy ? (
          <div className="py-1">
            <p className="text-sm leading-relaxed text-surface-700 dark:text-surface-300 whitespace-pre-wrap">
              {legacyTranscript}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {segments.map((seg, i) => {
              const prev = segments[i - 1];
              const showSimultaneous = !!prev &&
                Math.abs(seg.timestamp_ms - prev.timestamp_ms) < SIMULTANEOUS_THRESHOLD_MS &&
                seg.source !== prev.source;
              return (
                <SegmentRow
                  key={seg.timestamp_ms.toString()}
                  segment={seg}
                  index={i}
                  isLast={i === segments.length - 1}
                  isCapturing={isCapturing}
                  meetingId={meetingId}
                  showSimultaneousMarker={showSimultaneous}
                />
              );
            })}
          </div>
        )}
      </div>

      {!isEmpty && (
        <div className="px-4 py-2 border-t border-surface-50 dark:border-surface-700/30 bg-surface-50/50 dark:bg-surface-900/30 flex-shrink-0">
          <p className="text-xs text-surface-400 dark:text-surface-500">
            {fullText.length.toLocaleString("pt-BR")} caracteres
          </p>
        </div>
      )}
    </div>
  );
};
