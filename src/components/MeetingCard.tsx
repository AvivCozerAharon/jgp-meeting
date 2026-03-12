// components/MeetingCard.tsx
// Card de reunião para o histórico.

import React from "react";
import clsx from "clsx";
import {
  Calendar,
  Clock,
  FileText,
  Sparkles,
  Trash2,
  ChevronRight,
  CheckCircle2,
} from "lucide-react";
import type { Meeting } from "@/types";
import { formatMeetingDate, formatMeetingDuration, transcriptPreview } from "@/services/storageService";
import { Spinner } from "./LoadingSpinner";

interface MeetingCardProps {
  meeting: Meeting;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onGenerateSummary?: (id: string) => void;
  isGeneratingSummary?: boolean;
  className?: string;
}

export const MeetingCard: React.FC<MeetingCardProps> = ({
  meeting,
  onOpen,
  onDelete,
  onGenerateSummary,
  isGeneratingSummary = false,
  className,
}) => {
  const hasSummary = !!meeting.summary;
  const preview = transcriptPreview(meeting.transcript, 15);

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm(`Excluir a reunião "${meeting.title}"? Esta ação não pode ser desfeita.`)) {
      onDelete(meeting.id);
    }
  };

  const handleGenerateSummary = (e: React.MouseEvent) => {
    e.stopPropagation();
    onGenerateSummary?.(meeting.id);
  };

  return (
    <div
      className={clsx(
        "group cursor-pointer rounded-2xl p-4",
        "bg-white border border-surface-100 shadow-card",
        "hover:shadow-card-hover hover:border-surface-200",
        "dark:bg-surface-800/60 dark:border-surface-700/50 dark:shadow-none",
        "dark:hover:bg-surface-800/80 dark:hover:border-surface-600/50",
        "transition-all duration-200 animate-fade-in",
        className
      )}
      onClick={() => onOpen(meeting.id)}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-surface-800 dark:text-surface-200 truncate text-sm">
            {meeting.title}
          </h3>
          <div className="flex items-center gap-3 mt-1">
            <span className="flex items-center gap-1 text-xs text-surface-400 dark:text-surface-500">
              <Calendar className="w-3 h-3" />
              {formatMeetingDate(meeting.started_at)}
            </span>
            {meeting.duration_secs > 0 && (
              <span className="flex items-center gap-1 text-xs text-surface-400 dark:text-surface-500">
                <Clock className="w-3 h-3" />
                {formatMeetingDuration(meeting.duration_secs)}
              </span>
            )}
          </div>
        </div>

        {hasSummary && (
          <div className="flex-shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary-50 dark:bg-primary-500/10 border border-primary-100 dark:border-primary-500/20">
            <CheckCircle2 className="w-3 h-3 text-primary-500" />
            <span className="text-[10px] font-medium text-primary-600 dark:text-primary-400">Resumo</span>
          </div>
        )}
      </div>

      {/* Preview */}
      {meeting.transcript && (
        <p className="mt-2.5 text-xs text-surface-500 dark:text-surface-400 line-clamp-2 leading-relaxed">
          <FileText className="w-3 h-3 inline mr-1 text-surface-300 dark:text-surface-600" />
          {preview}
        </p>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between mt-3 pt-3 border-t border-surface-50 dark:border-surface-700/30">
        <div className="flex items-center gap-1.5">
          {!hasSummary && onGenerateSummary && (
            <button
              onClick={handleGenerateSummary}
              disabled={isGeneratingSummary}
              className={clsx(
                "flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium",
                "transition-all duration-150",
                isGeneratingSummary
                  ? "bg-surface-50 dark:bg-surface-700/30 text-surface-400 cursor-wait"
                  : "bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-400 hover:bg-primary-100 dark:hover:bg-primary-500/20"
              )}
            >
              {isGeneratingSummary ? (
                <>
                  <Spinner size="xs" color="primary" />
                  Gerando...
                </>
              ) : (
                <>
                  <Sparkles className="w-3 h-3" />
                  Gerar Resumo
                </>
              )}
            </button>
          )}

          <button
            onClick={handleDelete}
            className={clsx(
              "flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium",
              "text-surface-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10",
              "transition-all duration-150"
            )}
          >
            <Trash2 className="w-3 h-3" />
            Excluir
          </button>
        </div>

        <div className="flex items-center gap-1 text-xs text-surface-400 dark:text-surface-500 group-hover:text-surface-600 dark:group-hover:text-surface-300 transition-colors">
          <span>Abrir</span>
          <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
        </div>
      </div>
    </div>
  );
};
