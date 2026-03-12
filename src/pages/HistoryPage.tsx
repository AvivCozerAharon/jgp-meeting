// pages/HistoryPage.tsx
// Página de histórico de reuniões.

import React, { useState, useEffect, useRef } from "react";
import clsx from "clsx";
import {
  Clock,
  RefreshCw,
  ArrowLeft,
  FileText,
  Calendar,
  AlertCircle,
  X,
  Users,
  Mail,
  LayoutList,
  Search,
  MessageCircle,
  Pencil,
  Check,
  Upload,
  Save,
} from "lucide-react";
import { useMeetingHistory } from "@/hooks/useMeetingHistory";
import { MeetingCard } from "@/components/MeetingCard";
import { SummaryPanel } from "@/components/SummaryPanel";
import { LoadingOverlay } from "@/components/LoadingSpinner";
import { ExportMenu } from "@/components/ExportMenu";
import { FollowupEmail } from "@/components/FollowupEmail";
import { SpeakersPanel } from "@/components/SpeakersPanel";
import { TranscriptQA } from "@/components/TranscriptQA";
import { getSettings, formatMeetingDate, formatMeetingDuration } from "@/services/storageService";
import type { Meeting, SpeakerSegment, AppSettings } from "@/types";

export const HistoryPage: React.FC = () => {
  const [state, actions] = useMeetingHistory();
  const { meetings, allMeetings, isLoading, selectedMeeting, isGeneratingSummary, error, searchQuery } = state;

  if (selectedMeeting) {
    return (
      <MeetingDetailView
        meeting={selectedMeeting}
        onBack={actions.closeMeeting}
        onGenerateSummary={actions.generateSummary}
        isGeneratingSummary={isGeneratingSummary}
        error={error}
        onClearError={actions.clearError}
        onUpdateMeta={actions.updateMeta}
        onExportToJgrc={actions.exportToJgrc}
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
                {searchQuery ? `${meetings.length} / ${allMeetings.length}` : allMeetings.length}
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
        ) : meetings.length === 0 ? (
          <EmptyHistory />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3">
            {meetings.map((meeting) => (
              <MeetingCard
                key={meeting.id}
                meeting={meeting}
                onOpen={actions.selectMeeting}
                onDelete={actions.remove}
                onGenerateSummary={actions.generateSummary}
                isGeneratingSummary={isGeneratingSummary}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Vista de Detalhe ──────────────────────────────────────────────────────────

type DetailTab = 'summary' | 'speakers' | 'email' | 'qa';

interface MeetingDetailViewProps {
  meeting: Meeting;
  onBack: () => void;
  onGenerateSummary: (id: string) => Promise<void>;
  isGeneratingSummary: boolean;
  error: string | null;
  onClearError: () => void;
  onUpdateMeta: (id: string, title?: string, transcript?: string) => Promise<void>;
  onExportToJgrc: (meetingId: string) => Promise<string>;
}

const MeetingDetailView: React.FC<MeetingDetailViewProps> = ({
  meeting,
  onBack,
  onGenerateSummary,
  isGeneratingSummary,
  error,
  onClearError,
  onUpdateMeta,
  onExportToJgrc,
}) => {
  const [tab, setTab] = useState<DetailTab>('summary');
  const [settings, setSettings] = useState<Partial<AppSettings>>({});

  const [email, setEmail] = useState<string | null>(
    meeting.summary?.followup_email ?? null
  );
  const [speakers, setSpeakers] = useState<SpeakerSegment[] | null>(
    meeting.speakers ?? null
  );

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState(meeting.title);
  const [isSavingTitle, setIsSavingTitle] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const [editingTranscript, setEditingTranscript] = useState(false);
  const [transcriptValue, setTranscriptValue] = useState(meeting.transcript);
  const [isSavingTranscript, setIsSavingTranscript] = useState(false);

  const [isExportingJgrc, setIsExportingJgrc] = useState(false);
  const [jgrcStatus, setJgrcStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [jgrcMessage, setJgrcMessage] = useState<string>('');

  useEffect(() => {
    setTitleValue(meeting.title);
    setTranscriptValue(meeting.transcript);
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
  const jgrcConfigured = !!(settings.jgrc_url && settings.jgrc_token);

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

  const handleTranscriptSave = async () => {
    const trimmed = transcriptValue.trim();
    setIsSavingTranscript(true);
    try {
      await onUpdateMeta(meeting.id, undefined, trimmed);
    } finally {
      setIsSavingTranscript(false);
      setEditingTranscript(false);
    }
  };

  const handleTranscriptCancel = () => {
    setTranscriptValue(meeting.transcript);
    setEditingTranscript(false);
  };

  const handleExportJgrc = async () => {
    setIsExportingJgrc(true);
    setJgrcStatus('idle');
    setJgrcMessage('');
    try {
      const eventId = await onExportToJgrc(meeting.id);
      setJgrcStatus('success');
      setJgrcMessage(`Evento #${eventId} criado no JGRC`);
    } catch (err) {
      setJgrcStatus('error');
      setJgrcMessage(`Erro: ${err}`);
    } finally {
      setIsExportingJgrc(false);
    }
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
                  disabled={isExportingJgrc}
                  className={clsx(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium",
                    "transition-all duration-150 focus:outline-none",
                    alreadyExported
                      ? "text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 hover:bg-emerald-100 dark:hover:bg-emerald-500/20 border border-emerald-200 dark:border-emerald-500/20"
                      : "text-white bg-primary-600 hover:bg-primary-700",
                    isExportingJgrc && "opacity-60 cursor-not-allowed"
                  )}
                  title={alreadyExported ? "Reenviar para JGRC" : "Exportar para JGRC"}
                >
                  {isExportingJgrc ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Upload className="w-3.5 h-3.5" />
                  )}
                  {alreadyExported ? "Reenviar JGRC" : "Exportar JGRC"}
                </button>
                {jgrcStatus === 'success' && (
                  <span className="text-xs text-emerald-600 dark:text-emerald-400">{jgrcMessage}</span>
                )}
                {jgrcStatus === 'error' && (
                  <span className="text-xs text-red-500 dark:text-red-400 max-w-48 text-right leading-tight">{jgrcMessage}</span>
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
        <div className="flex-1 bg-white dark:bg-surface-800/60 border border-surface-100 dark:border-surface-700/50 rounded-2xl shadow-card dark:shadow-none overflow-hidden flex flex-col">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-surface-100 dark:border-surface-700/50 flex-shrink-0">
            <FileText className="w-4 h-4 text-surface-400 dark:text-surface-500" />
            <span className="text-sm font-semibold text-surface-700 dark:text-surface-200">Transcrição</span>
            <span className="ml-auto text-xs text-surface-400 dark:text-surface-500">
              {(editingTranscript ? transcriptValue : meeting.transcript)
                .split(/\s+/)
                .filter(Boolean).length}{" "}
              palavras
            </span>

            {editingTranscript ? (
              <div className="flex items-center gap-1 ml-2">
                <button
                  onClick={handleTranscriptSave}
                  disabled={isSavingTranscript}
                  className={clsx(
                    "flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium",
                    "bg-primary-600 text-white hover:bg-primary-700 transition-colors",
                    isSavingTranscript && "opacity-60 cursor-not-allowed"
                  )}
                >
                  {isSavingTranscript ? (
                    <RefreshCw className="w-3 h-3 animate-spin" />
                  ) : (
                    <Save className="w-3 h-3" />
                  )}
                  Salvar
                </button>
                <button
                  onClick={handleTranscriptCancel}
                  disabled={isSavingTranscript}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-surface-500 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700/50 transition-colors"
                >
                  <X className="w-3 h-3" />
                  Cancelar
                </button>
              </div>
            ) : (
              <button
                onClick={() => setEditingTranscript(true)}
                className="flex items-center gap-1 ml-2 px-2 py-1 rounded-lg text-xs font-medium text-surface-400 hover:text-surface-600 dark:hover:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-700/50 transition-colors"
                title="Editar transcrição"
              >
                <Pencil className="w-3 h-3" />
                Editar
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {editingTranscript ? (
              <textarea
                value={transcriptValue}
                onChange={(e) => setTranscriptValue(e.target.value)}
                disabled={isSavingTranscript}
                className={clsx(
                  "w-full h-full min-h-32 resize-none text-sm leading-relaxed",
                  "text-surface-700 dark:text-surface-300 font-mono bg-transparent",
                  "focus:outline-none focus:ring-2 focus:ring-primary-400 rounded-lg p-1",
                  isSavingTranscript && "opacity-60 cursor-not-allowed"
                )}
                placeholder="Nenhuma transcrição disponível. Digite aqui para adicionar..."
              />
            ) : meeting.transcript ? (
              <p className="text-sm leading-relaxed text-surface-700 dark:text-surface-300 font-mono whitespace-pre-wrap">
                {meeting.transcript}
              </p>
            ) : (
              <div className="h-full flex items-center justify-center text-surface-400 dark:text-surface-500 text-sm">
                Sem transcrição disponível
              </div>
            )}
          </div>
        </div>

        {/* Painel direito: abas */}
        <div className="w-80 flex-shrink-0 flex flex-col gap-3">
          {/* Seletor de abas */}
          <div className="flex bg-white dark:bg-surface-800/60 border border-surface-100 dark:border-surface-700/50 rounded-xl shadow-card dark:shadow-none overflow-hidden flex-shrink-0">
            <TabButton active={tab === 'summary'} onClick={() => setTab('summary')} icon={<LayoutList className="w-3.5 h-3.5" />} label="Resumo" />
            <TabButton active={tab === 'speakers'} onClick={() => setTab('speakers')} icon={<Users className="w-3.5 h-3.5" />} label="Falantes" />
            <TabButton active={tab === 'email'} onClick={() => setTab('email')} icon={<Mail className="w-3.5 h-3.5" />} label="E-mail" />
            <TabButton active={tab === 'qa'} onClick={() => setTab('qa')} icon={<MessageCircle className="w-3.5 h-3.5" />} label="Perguntas" />
          </div>

          {tab === 'summary' && (
            <SummaryPanel
              summary={meeting.summary}
              status={summaryStatus}
              error={error}
              onGenerate={() => onGenerateSummary(meeting.id)}
              canGenerate={!!meeting.transcript}
              className="flex-1 min-h-0"
            />
          )}

          {tab === 'speakers' && (
            <div className="flex-1 min-h-0 bg-white dark:bg-surface-800/60 border border-surface-100 dark:border-surface-700/50 rounded-2xl shadow-card dark:shadow-none p-4 overflow-y-auto">
              <SpeakersPanel
                meetingId={meeting.id}
                apiKey={apiKey}
                model={model}
                segments={speakers}
                onDiarized={setSpeakers}
              />
            </div>
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
