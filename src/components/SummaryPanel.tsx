// components/SummaryPanel.tsx
// Painel de resumo da reunião: cards organizados por categoria.

import React, { useState } from "react";
import clsx from "clsx";
import {
  Sparkles,
  AlertCircle,
  Target,
} from "lucide-react";
import type { MeetingSummary, SummaryStatus } from "@/types";
import { Spinner } from "./LoadingSpinner";

interface SummaryPanelProps {
  summary: MeetingSummary | null;
  status: SummaryStatus;
  error?: string | null;
  /** Chamado com o texto de foco (vazio = sem foco). */
  onGenerate: (focus: string) => void;
  canGenerate?: boolean;
  className?: string;
}

export const SummaryPanel: React.FC<SummaryPanelProps> = ({
  summary,
  status,
  error,
  onGenerate,
  canGenerate = false,
  className,
}) => {
  const isLoading = status === "loading";
  const hasSummary = status === "done" && summary;
  const [focus, setFocus] = useState("");

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
          <Sparkles className="w-4 h-4 text-primary-500" />
          <span className="text-sm font-semibold text-surface-700 dark:text-surface-200">
            Resumo IA
          </span>
        </div>

        {!hasSummary && (
          <button
            onClick={() => onGenerate(focus)}
            disabled={!canGenerate || isLoading}
            className={clsx(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold",
              "transition-all duration-150 focus:outline-none",
              canGenerate && !isLoading
                ? "bg-primary-500 text-white hover:bg-primary-600 shadow-sm hover:shadow"
                : "bg-surface-100 text-surface-400 cursor-not-allowed dark:bg-surface-700/50 dark:text-surface-500"
            )}
          >
            {isLoading ? (
              <>
                <Spinner size="xs" color="white" />
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

        {hasSummary && (
          <button
            onClick={() => onGenerate(focus)}
            disabled={isLoading}
            className="text-xs text-primary-500 hover:text-primary-400 font-medium transition-colors"
          >
            Regenerar
          </button>
        )}
      </div>

      {/* Input de foco — sempre visível quando ainda não há resumo OU em regen */}
      {!isLoading && (
        <div className="px-4 py-3 border-b border-surface-100 dark:border-surface-700/50 flex-shrink-0 space-y-1.5">
          <label className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-surface-500 dark:text-surface-400">
            <Target className="w-3 h-3" />
            Foco do resumo (opcional)
          </label>
          <input
            type="text"
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            placeholder="Ex: decisões sobre o follow-on da Régia"
            disabled={!canGenerate}
            className={clsx(
              "w-full px-2.5 py-1.5 rounded-lg text-xs",
              "bg-surface-50 dark:bg-surface-900/50",
              "border border-surface-200 dark:border-surface-700",
              "text-surface-700 dark:text-surface-200",
              "placeholder:text-surface-400 dark:placeholder:text-surface-500",
              "focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:border-primary-400",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          />
          <p className="text-[10px] text-surface-400 dark:text-surface-500 leading-snug">
            Quando preenchido, o resumo detalha esta parte e trata o resto de forma sucinta.
          </p>
        </div>
      )}

      {/* Conteúdo */}
      <div className="flex-1 overflow-y-auto p-4 min-h-0">
        {isLoading && (
          <div className="animate-fade-in">
            <SummarySkeleton />
          </div>
        )}

        {status === "error" && error && (
          <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-500/10 border border-red-100 dark:border-red-500/20 rounded-xl text-sm text-red-700 dark:text-red-400">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {hasSummary && (
          <div className="animate-slide-up">
            {summary.summary && (
              <SummaryCard
                icon={<Sparkles className="w-4 h-4 text-primary-500" />}
                title="Resumo"
                accentColor="primary"
              >
                <p className="text-sm text-surface-600 dark:text-surface-300 leading-relaxed whitespace-pre-line">
                  {summary.summary}
                </p>
              </SummaryCard>
            )}
          </div>
        )}

        {status === "idle" && (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-center py-12">
            <div className="w-12 h-12 rounded-full bg-primary-50 dark:bg-primary-500/10 flex items-center justify-center">
              <Sparkles className="w-6 h-6 text-primary-300 dark:text-primary-500/50" />
            </div>
            <div>
              <p className="text-sm font-medium text-surface-500 dark:text-surface-400">
                Resumo não gerado
              </p>
              <p className="text-xs text-surface-400 dark:text-surface-500 mt-1">
                {canGenerate
                  ? "Clique em Gerar Resumo para analisar a transcrição"
                  : "Grave uma reunião primeiro para gerar o resumo"}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Sub-componentes ──────────────────────────────────────────────────────────

type AccentColor = "primary" | "emerald" | "blue" | "amber";

const cardBgClasses: Record<AccentColor, string> = {
  primary: "bg-primary-50 border-primary-100 dark:bg-primary-500/10 dark:border-primary-500/20",
  emerald: "bg-emerald-50 border-emerald-100 dark:bg-emerald-500/10 dark:border-emerald-500/20",
  blue: "bg-blue-50 border-blue-100 dark:bg-blue-500/10 dark:border-blue-500/20",
  amber: "bg-amber-50 border-amber-100 dark:bg-amber-500/10 dark:border-amber-500/20",
};

const cardTitleClasses: Record<AccentColor, string> = {
  primary: "text-primary-700 dark:text-primary-400",
  emerald: "text-emerald-700 dark:text-emerald-400",
  blue: "text-blue-700 dark:text-blue-400",
  amber: "text-amber-700 dark:text-amber-400",
};

interface SummaryCardProps {
  icon: React.ReactNode;
  title: string;
  accentColor: AccentColor;
  children: React.ReactNode;
}

const SummaryCard: React.FC<SummaryCardProps> = ({
  icon,
  title,
  accentColor,
  children,
}) => (
  <div
    className={clsx(
      "border rounded-xl p-3 space-y-2",
      cardBgClasses[accentColor]
    )}
  >
    <div className="flex items-center gap-1.5">
      {icon}
      <h3 className={clsx("text-xs font-bold uppercase tracking-wide", cardTitleClasses[accentColor])}>
        {title}
      </h3>
    </div>
    {children}
  </div>
);

const SummarySkeleton: React.FC = () => (
  <div className="space-y-4 animate-pulse">
    {/* Section 1 — Resumo */}
    <div className="border border-surface-100 dark:border-surface-700/30 rounded-xl p-3 space-y-2">
      <div className="h-3 bg-surface-200 dark:bg-surface-700 rounded w-1/4" />
      <div className="h-3 bg-surface-100 dark:bg-surface-700/50 rounded w-full" />
      <div className="h-3 bg-surface-100 dark:bg-surface-700/50 rounded w-5/6" />
      <div className="h-3 bg-surface-100 dark:bg-surface-700/50 rounded w-4/6" />
    </div>
    {/* Section 2 — Decisões */}
    <div className="border border-surface-100 dark:border-surface-700/30 rounded-xl p-3 space-y-2">
      <div className="h-3 bg-surface-200 dark:bg-surface-700 rounded w-1/3" />
      <div className="h-3 bg-surface-100 dark:bg-surface-700/50 rounded w-2/5" />
      <div className="h-3 bg-surface-100 dark:bg-surface-700/50 rounded w-1/3" />
      <div className="h-3 bg-surface-100 dark:bg-surface-700/50 rounded w-2/4" />
    </div>
    {/* Section 3 — Próximos passos */}
    <div className="border border-surface-100 dark:border-surface-700/30 rounded-xl p-3 space-y-2">
      <div className="h-3 bg-surface-200 dark:bg-surface-700 rounded w-2/5" />
      <div className="h-3 bg-surface-100 dark:bg-surface-700/50 rounded w-1/3" />
      <div className="h-3 bg-surface-100 dark:bg-surface-700/50 rounded w-2/5" />
    </div>
  </div>
);
