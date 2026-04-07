// components/MeetingCard.tsx
// Row compacto de reunião para o histórico (layout de lista).

import React from "react";
import clsx from "clsx";
import {
  Calendar,
  Clock,
  Sparkles,
  Trash2,
  ChevronRight,
  CheckCircle2,
} from "lucide-react";
import type { Meeting, Tag } from "@/types";
import { formatMeetingDate, formatMeetingDuration, transcriptPreview } from "@/services/storageService";
import { Spinner } from "./LoadingSpinner";

interface MeetingCardProps {
  meeting: Meeting;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onGenerateSummary?: (id: string) => void;
  isGeneratingSummary?: boolean;
  className?: string;
  allTags?: Tag[];
}

export const MeetingCard: React.FC<MeetingCardProps> = ({
  meeting,
  onOpen,
  onDelete,
  onGenerateSummary,
  isGeneratingSummary = false,
  className,
  allTags,
}) => {
  const hasSummary = !!meeting.summary;
  const preview = transcriptPreview(meeting.transcript, 20);

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
        "group cursor-pointer flex items-center gap-4 px-4 py-3 rounded-xl",
        "bg-white border border-surface-100",
        "hover:bg-surface-50 hover:border-surface-200",
        "dark:bg-surface-800/40 dark:border-surface-700/40",
        "dark:hover:bg-surface-800/70 dark:hover:border-surface-600/50",
        "transition-all duration-150",
        className
      )}
      onClick={() => onOpen(meeting.id)}
    >
      {/* Título + preview */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-surface-800 dark:text-surface-200 truncate text-sm">
            {meeting.title}
          </h3>
          {hasSummary && (
            <div className="flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-primary-50 dark:bg-primary-500/10">
              <CheckCircle2 className="w-2.5 h-2.5 text-primary-500" />
              <span className="text-[10px] font-medium text-primary-600 dark:text-primary-400">Resumo</span>
            </div>
          )}
          {meeting.jgrc_event_id && (
            <span className="flex-shrink-0 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 px-1.5 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-500/10">
              JGRC
            </span>
          )}
        </div>
        {preview && (
          <p className="mt-0.5 text-xs text-surface-400 dark:text-surface-500 truncate">
            {preview}
          </p>
        )}
        {allTags && allTags.length > 0 && meeting.tags && meeting.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {meeting.tags.map((tagId) => {
              const tag = allTags.find((t) => t.id === tagId);
              if (!tag) return null;
              return (
                <span
                  key={tagId}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-surface-100 dark:bg-surface-700/60 text-surface-700 dark:text-surface-300"
                >
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: tag.color }}
                  />
                  {tag.name}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* Meta: data + duração */}
      <div className="flex items-center gap-3 flex-shrink-0">
        <span className="flex items-center gap-1 text-xs text-surface-400 dark:text-surface-500 whitespace-nowrap">
          <Calendar className="w-3 h-3" />
          {formatMeetingDate(meeting.started_at)}
        </span>
        {meeting.duration_secs > 0 && (
          <span className="flex items-center gap-1 text-xs text-surface-400 dark:text-surface-500 whitespace-nowrap">
            <Clock className="w-3 h-3" />
            {formatMeetingDuration(meeting.duration_secs)}
          </span>
        )}
      </div>

      {/* Ações */}
      <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        {!hasSummary && onGenerateSummary && (
          <button
            onClick={handleGenerateSummary}
            disabled={isGeneratingSummary}
            className={clsx(
              "flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium",
              "transition-all duration-150",
              isGeneratingSummary
                ? "text-surface-400 cursor-wait"
                : "text-primary-600 dark:text-primary-400 hover:bg-primary-50 dark:hover:bg-primary-500/10"
            )}
          >
            {isGeneratingSummary ? (
              <Spinner size="xs" color="primary" />
            ) : (
              <Sparkles className="w-3 h-3" />
            )}
          </button>
        )}

        <button
          onClick={handleDelete}
          className="p-1 rounded-lg text-surface-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-all duration-150"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Seta */}
      <ChevronRight className="w-4 h-4 text-surface-300 dark:text-surface-600 flex-shrink-0 group-hover:text-surface-500 dark:group-hover:text-surface-400 group-hover:translate-x-0.5 transition-all" />
    </div>
  );
};
