// pages/HistoryPage.tsx
// Página de histórico de reuniões.

import React, { useState, useEffect, useRef, useMemo } from "react";
import clsx from "clsx";
import {
  Clock,
  RefreshCw,
  ArrowLeft,
  Calendar,
  AlertCircle,
  X,
  Mail,
  LayoutList,
  Search,
  MessageCircle,
  Pencil,
  Check,
  Upload,
  ExternalLink,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useMeetingHistory } from "@/hooks/useMeetingHistory";
import { useDraining } from "@/hooks/useDraining";
import { MeetingCard } from "@/components/MeetingCard";
import { SummaryPanel } from "@/components/SummaryPanel";
import { LoadingOverlay } from "@/components/LoadingSpinner";
import { ExportMenu } from "@/components/ExportMenu";
import { FollowupEmail } from "@/components/FollowupEmail";
import { TranscriptQA } from "@/components/TranscriptQA";
import { JgrcExportModal } from "@/components/JgrcExportModal";
import { TagPicker } from "@/components/TagPicker";
import { TranscriptionPanel } from "@/components/TranscriptionPanel";
import { getSettings, getTags, formatMeetingDate, formatMeetingDuration } from "@/services/storageService";
import type { Meeting, AppSettings, Tag } from "@/types";

export const HistoryPage: React.FC = () => {
  const [state, actions] = useMeetingHistory();
  const { meetings, allMeetings, isLoading, selectedMeeting, isGeneratingSummary, error, searchQuery } = state;
  const draining = useDraining();

  const handleOpenMeeting = (id: string) => {
    if (draining.isDraining && draining.meetingId === id) return;
    actions.selectMeeting(id);
  };

  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [activeTagFilter, setActiveTagFilter] = useState<string | null>(null);

  useEffect(() => {
    getTags().then(setAllTags).catch(console.error);
  }, []);

  const filteredMeetings = useMemo(
    () => meetings.filter(m => !activeTagFilter || (m.tags ?? []).includes(activeTagFilter)),
    [meetings, activeTagFilter]
  );

  const usedTags = useMemo(
    () => allTags.filter(tag => allMeetings.some(m => (m.tags ?? []).includes(tag.id))),
    [allTags, allMeetings]
  );

  if (selectedMeeting) {
    return (
      <MeetingDetailView
        meeting={selectedMeeting}
        allTags={allTags}
        onBack={actions.closeMeeting}
        onGenerateSummary={actions.generateSummary}
        isGeneratingSummary={isGeneratingSummary}
        error={error}
        onClearError={actions.clearError}
        onUpdateMeta={actions.updateMeta}
        onExportToJgrc={actions.exportToJgrc}
        onTagsChange={(meetingId, newIds) => {
          actions.refresh();
          void meetingId;
          void newIds;
        }}
        onTagsUpdated={(updated) => setAllTags(updated)}
      />
    );
  }

  return (
    <div className="flex flex-col h-full bg-surface-50 dark:bg-[#0c0f17]">
      {/* Header */}
      <div className="bg-white dark:bg-surface-900/50 border-b border-surface-100 dark:border-surface-800/50 px-6 py-4 flex-shrink-0">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-surface-400 dark:text-surface-500" />
            <h1 className="text-lg font-bold text-surface-900 dark:text-surface-100">
              Histórico de Reuniões
            </h1>
            {allMeetings.length > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-surface-100 dark:bg-surface-800 text-xs font-medium text-surface-600 dark:text-surface-400">
                {searchQuery || activeTagFilter ? `${filteredMeetings.length} / ${allMeetings.length}` : allMeetings.length}
              </span>
            )}
          </div>

          <button
            onClick={actions.refresh}
            disabled={isLoading}
            className={clsx(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium",
              "text-surface-500 hover:text-surface-700 hover:bg-surface-100",
              "dark:hover:text-surface-300 dark:hover:bg-surface-800",
              "transition-all duration-150 focus:outline-none",
              isLoading && "opacity-50 cursor-not-allowed"
            )}
          >
            <RefreshCw className={clsx("w-3.5 h-3.5", isLoading && "animate-spin")} />
            Atualizar
          </button>
        </div>

        {/* Barra de busca */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-surface-400 dark:text-surface-500 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => actions.setSearchQuery(e.target.value)}
            placeholder="Buscar por título, conteúdo ou tipo de reunião..."
            className="input-base pl-9 pr-8"
          />
          {searchQuery && (
            <button
              onClick={() => actions.setSearchQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600 dark:hover:text-surface-300"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Tag filter bar */}
        {usedTags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3">
            <button
              onClick={() => setActiveTagFilter(null)}
              className={clsx(
                "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-all",
                activeTagFilter === null
                  ? "border-primary-500 bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300"
                  : "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800 text-surface-600 dark:text-surface-400 hover:border-surface-300"
              )}
            >
              Todas
            </button>
            {usedTags.map((tag) => (
              <button
                key={tag.id}
                onClick={() => setActiveTagFilter(tag.id === activeTagFilter ? null : tag.id)}
                className={clsx(
                  "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-all",
                  activeTagFilter === tag.id
                    ? "border-primary-500 bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300"
                    : "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800 text-surface-600 dark:text-surface-400 hover:border-surface-300"
                )}
              >
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: tag.color }} />
                {tag.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Erro */}
      {error && (
        <div className="mx-6 mt-4 flex items-start gap-2 p-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl text-sm text-red-700 dark:text-red-400 flex-shrink-0">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={actions.clearError} className="text-red-400 hover:text-red-600 dark:hover:text-red-300">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Conteúdo */}
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <LoadingOverlay message="Carregando reuniões..." className="h-40" />
        ) : filteredMeetings.length === 0 ? (
          <EmptyHistory />
        ) : (
          <div className="flex flex-col gap-1">
            {filteredMeetings.map((meeting) => (
              <MeetingCard
                key={meeting.id}
                meeting={meeting}
                onOpen={handleOpenMeeting}
                onDelete={actions.remove}
                onGenerateSummary={actions.generateSummary}
                isGeneratingSummary={isGeneratingSummary}
                allTags={allTags}
                isDraining={draining.isDraining && draining.meetingId === meeting.id}
                drainProgress={draining.progress}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Vista de Detalhe ──────────────────────────────────────────────────────────

type DetailTab = 'summary' | 'email' | 'qa';

interface MeetingDetailViewProps {
  meeting: Meeting;
  allTags: Tag[];
  onBack: () => void;
  onGenerateSummary: (id: string, focus?: string) => Promise<void>;
  isGeneratingSummary: boolean;
  error: string | null;
  onClearError: () => void;
  onUpdateMeta: (id: string, title?: string, transcript?: string) => Promise<void>;
  onExportToJgrc: (meetingId: string) => Promise<string>;
  onTagsChange: (meetingId: string, newTagIds: string[]) => void;
  onTagsUpdated: (tags: Tag[]) => void;
}

const MeetingDetailView: React.FC<MeetingDetailViewProps> = ({
  meeting,
  allTags,
  onBack,
  onGenerateSummary,
  isGeneratingSummary,
  error,
  onClearError,
  onUpdateMeta,
  onExportToJgrc: _onExportToJgrc,
  onTagsChange,
  onTagsUpdated,
}) => {
  const [tab, setTab] = useState<DetailTab>('summary');
  const [settings, setSettings] = useState<Partial<AppSettings>>({});

  const [email, setEmail] = useState<string | null>(
    meeting.summary?.followup_email ?? null
  );
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState(meeting.title);
  const [isSavingTitle, setIsSavingTitle] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const [jgrcModalOpen, setJgrcModalOpen] = useState(false);
  const [jgrcStatus, setJgrcStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [jgrcMessage, setJgrcMessage] = useState<string>('');
  const [jgrcEventUrl, setJgrcEventUrl] = useState<string | null>(meeting.jgrc_event_url ?? null);

  useEffect(() => {
    setTitleValue(meeting.title);
    setJgrcEventUrl(meeting.jgrc_event_url ?? null);
    setJgrcStatus('idle');
  }, [meeting.id]);

  useEffect(() => {
    getSettings()
      .then((s) => setSettings(s))
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (editingTitle) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [editingTitle]);

  const summaryStatus = isGeneratingSummary
    ? "loading"
    : meeting.summary
    ? "done"
    : "idle";

  const apiKey = settings.openai_api_key ?? "";
  const model = settings.summary_model;
  const jgrcConfigured = !!settings.jgrc_session_cookie;

  const handleTitleSave = async () => {
    const trimmed = titleValue.trim();
    if (!trimmed || trimmed === meeting.title) {
      setEditingTitle(false);
      setTitleValue(meeting.title);
      return;
    }
    setIsSavingTitle(true);
    try {
      await onUpdateMeta(meeting.id, trimmed);
    } finally {
      setIsSavingTitle(false);
      setEditingTitle(false);
    }
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleTitleSave();
    if (e.key === "Escape") {
      setTitleValue(meeting.title);
      setEditingTitle(false);
    }
  };

  const handleExportJgrc = () => {
    setJgrcModalOpen(true);
  };

  const handleJgrcExported = (eventId: string, eventUrl: string) => {
    setJgrcModalOpen(false);
    setJgrcStatus('success');
    setJgrcMessage(`Evento #${eventId} criado no JGRC`);
    setJgrcEventUrl(eventUrl);
  };

  const handleOpenJgrc = () => {
    const url = jgrcEventUrl;
    if (url) invoke("open_url", { url }).catch(console.error);
  };

  const alreadyExported = !!(meeting.jgrc_event_id);

  return (
    <div className="flex flex-col h-full bg-surface-50 dark:bg-[#0c0f17]">
      {/* Header */}
      <div className="bg-white dark:bg-surface-900/50 border-b border-surface-100 dark:border-surface-800/50 px-6 py-4 flex-shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className={clsx(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium",
              "text-surface-500 hover:text-surface-700 hover:bg-surface-100",
              "dark:hover:text-surface-300 dark:hover:bg-surface-800",
              "transition-all duration-150"
            )}
          >
            <ArrowLeft className="w-4 h-4" />
            Voltar
          </button>

          <div className="w-px h-5 bg-surface-200 dark:bg-surface-700" />

          {/* Título editável */}
          <div className="flex-1 min-w-0">
            {editingTitle ? (
              <div className="flex items-center gap-1.5">
                <input
                  ref={titleInputRef}
                  value={titleValue}
                  onChange={(e) => setTitleValue(e.target.value)}
                  onBlur={handleTitleSave}
                  onKeyDown={handleTitleKeyDown}
                  disabled={isSavingTitle}
                  className={clsx(
                    "flex-1 min-w-0 text-base font-bold bg-surface-50 dark:bg-surface-800",
                    "text-surface-900 dark:text-surface-100",
                    "border border-primary-400 rounded-lg px-2 py-0.5",
                    "focus:outline-none focus:ring-2 focus:ring-primary-500"
                  )}
                />
                <button
                  onClick={handleTitleSave}
                  disabled={isSavingTitle}
                  className="p-1 rounded text-primary-600 dark:text-primary-400 hover:bg-primary-50 dark:hover:bg-primary-500/10 transition-colors"
                  title="Salvar título"
                >
                  <Check className="w-4 h-4" />
                </button>
                <button
                  onClick={() => { setTitleValue(meeting.title); setEditingTitle(false); }}
                  disabled={isSavingTitle}
                  className="p-1 rounded text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
                  title="Cancelar"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 group">
                <h1 className="text-base font-bold text-surface-900 dark:text-surface-100 truncate">
                  {meeting.title}
                </h1>
                <button
                  onClick={() => setEditingTitle(true)}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded text-surface-400 hover:text-surface-600 dark:hover:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800 transition-all"
                  title="Renomear reunião"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            <div className="flex items-center gap-3 mt-0.5">
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
              {alreadyExported && (
                <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                  <Check className="w-3 h-3" />
                  JGRC #{meeting.jgrc_event_id}
                </span>
              )}
            </div>
          </div>

          {/* Ações */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {jgrcConfigured && (
              <div className="flex flex-col items-end gap-0.5">
                <button
                  onClick={handleExportJgrc}
                  className={clsx(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium",
                    "transition-all duration-150 focus:outline-none",
                    alreadyExported
                      ? "text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 hover:bg-emerald-100 dark:hover:bg-emerald-500/20 border border-emerald-200 dark:border-emerald-500/20"
                      : "text-white bg-primary-600 hover:bg-primary-700"
                  )}
                  title={alreadyExported ? "Reenviar para JGRC" : "Exportar para JGRC"}
                >
                  <Upload className="w-3.5 h-3.5" />
                  {alreadyExported ? "Reenviar JGRC" : "Exportar JGRC"}
                </button>
                {jgrcStatus === 'success' && (
                  <span className="text-xs text-emerald-600 dark:text-emerald-400">{jgrcMessage}</span>
                )}
                {jgrcStatus === 'error' && (
                  <span className="text-xs text-red-500 dark:text-red-400 max-w-48 text-right leading-tight">{jgrcMessage}</span>
                )}
                {jgrcEventUrl && (
                  <button
                    onClick={handleOpenJgrc}
                    className="flex items-center gap-1 text-xs text-primary-500 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300 transition-colors"
                    title={jgrcEventUrl}
                  >
                    <ExternalLink className="w-3 h-3" />
                    Abrir no JGRC
                  </button>
                )}
              </div>
            )}
            <ExportMenu meetingId={meeting.id} />
          </div>
        </div>
      </div>

      {/* Erro */}
      {error && (
        <div className="mx-6 mt-4 flex items-start gap-2 p-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl text-sm text-red-700 dark:text-red-400 flex-shrink-0">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={onClearError} className="text-red-400 hover:text-red-600 dark:hover:text-red-300">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Conteúdo: transcrição + painel direito com abas */}
      <div className="flex-1 flex gap-4 p-6 min-h-0">
        {/* Transcrição */}
        <TranscriptionPanel
          segments={meeting.segments ?? []}
          legacyTranscript={(!meeting.segments?.length) ? meeting.transcript : undefined}
          meetingId={meeting.id}
          isCapturing={false}
          processingSource={null}
          className="flex-1"
        />

        {/* Painel direito: abas */}
        <div className="w-80 flex-shrink-0 flex flex-col gap-3">
          {/* Tags */}
          <div className="bg-white dark:bg-surface-800/60 border border-surface-100 dark:border-surface-700/50 rounded-xl shadow-card dark:shadow-none px-4 py-2.5 flex-shrink-0 flex items-center gap-2 flex-wrap">
            <TagPicker
              meetingId={meeting.id}
              currentTagIds={meeting.tags ?? []}
              allTags={allTags}
              onTagsChange={(newIds) => onTagsChange(meeting.id, newIds)}
              onTagsUpdated={onTagsUpdated}
            />
          </div>

          {/* Seletor de abas */}
          <div className="flex bg-white dark:bg-surface-800/60 border border-surface-100 dark:border-surface-700/50 rounded-xl shadow-card dark:shadow-none overflow-hidden flex-shrink-0">
            <TabButton active={tab === 'summary'} onClick={() => setTab('summary')} icon={<LayoutList className="w-3.5 h-3.5" />} label="Resumo" />
            <TabButton active={tab === 'email'} onClick={() => setTab('email')} icon={<Mail className="w-3.5 h-3.5" />} label="E-mail" />
            <TabButton active={tab === 'qa'} onClick={() => setTab('qa')} icon={<MessageCircle className="w-3.5 h-3.5" />} label="Perguntas" />
          </div>

          {tab === 'summary' && (
            <SummaryPanel
              summary={meeting.summary}
              status={summaryStatus}
              error={error}
              onGenerate={(focus) => onGenerateSummary(meeting.id, focus)}
              canGenerate={!!(meeting.transcript || meeting.segments?.length)}
              className="flex-1 min-h-0"
            />
          )}

          {tab === 'email' && (
            <div className="flex-1 min-h-0 bg-white dark:bg-surface-800/60 border border-surface-100 dark:border-surface-700/50 rounded-2xl shadow-card dark:shadow-none p-4 overflow-y-auto">
              <FollowupEmail
                meetingId={meeting.id}
                apiKey={apiKey}
                model={model}
                existingEmail={email}
                onGenerated={setEmail}
              />
            </div>
          )}

          {tab === 'qa' && (
            <div className="flex-1 min-h-0 bg-white dark:bg-surface-800/60 border border-surface-100 dark:border-surface-700/50 rounded-2xl shadow-card dark:shadow-none p-4 flex flex-col overflow-hidden">
              <TranscriptQA
                meetingId={meeting.id}
                apiKey={apiKey}
                model={model}
                hasTranscript={!!meeting.transcript}
              />
            </div>
          )}
        </div>
      </div>

      {/* Modal de exportação JGRC */}
      {jgrcModalOpen && (
        <JgrcExportModal
          meeting={meeting}
          settings={settings}
          onClose={() => setJgrcModalOpen(false)}
          onExported={handleJgrcExported}
        />
      )}
    </div>
  );
};

// ─── Tab Button ────────────────────────────────────────────────────────────────

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}

const TabButton: React.FC<TabButtonProps> = ({ active, onClick, icon, label }) => (
  <button
    onClick={onClick}
    className={clsx(
      "flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold",
      "transition-all duration-150 border-b-2",
      active
        ? "text-primary-600 dark:text-primary-400 border-primary-500 bg-primary-50 dark:bg-primary-500/10"
        : "text-surface-500 border-transparent hover:text-surface-700 dark:hover:text-surface-300 hover:bg-surface-50 dark:hover:bg-surface-700/30"
    )}
  >
    {icon}
    {label}
  </button>
);

// ─── Estado Vazio ──────────────────────────────────────────────────────────────

const EmptyHistory: React.FC = () => (
  <div className="flex flex-col items-center justify-center h-64 gap-4 text-center">
    <div className="w-16 h-16 rounded-2xl bg-surface-100 dark:bg-surface-800 flex items-center justify-center">
      <Clock className="w-8 h-8 text-surface-300 dark:text-surface-600" />
    </div>
    <div>
      <p className="text-base font-semibold text-surface-600 dark:text-surface-300">
        Nenhuma reunião gravada
      </p>
      <p className="text-sm text-surface-400 dark:text-surface-500 mt-1 max-w-xs">
        Suas reuniões aparecem aqui após você usar o{" "}
        <span className="font-medium text-surface-500 dark:text-surface-400">Start Listening</span> na
        página principal.
      </p>
    </div>
  </div>
);
