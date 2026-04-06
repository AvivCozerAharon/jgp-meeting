// components/JgrcExportModal.tsx
// Modal para exportar reunião para o JGRC com campos pré-preenchidos por IA.

import React, { useState, useEffect } from "react";
import clsx from "clsx";
import {
  X,
  Upload,
  Sparkles,
  User,
  Users,
  Tag,
  FileText,
  ListChecks,
  Building2,
  MapPin,
  Calendar,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Spinner } from "./LoadingSpinner";
import type { Meeting, AppSettings } from "@/types";

// ─── Types ──────────────────────────────────────────────────────────────────

interface JgrcSelectOption {
  id: string;
  name: string;
}

interface JgrcManager {
  id: string;
  name: string;
  qtd_events: number;
}

interface JgrcUser {
  id: number;
  name: string;
  email: string;
}

interface JgrcExportData {
  user: JgrcUser;
  event_types: JgrcSelectOption[];
  responsibles: JgrcSelectOption[];
  internal_attendees: JgrcSelectOption[];
  managers: JgrcManager[];
  cities: JgrcSelectOption[];
}

interface AiSuggestion {
  event_type_id: string;
  subject: string;
  actions: string;
}

interface JgrcExportModalProps {
  meeting: Meeting;
  settings: Partial<AppSettings>;
  onClose: () => void;
  onExported: (eventId: string) => void;
}

// ─── AI Suggestion Helper ───────────────────────────────────────────────────

async function suggestFieldsWithAI(
  meeting: Meeting,
  eventTypes: JgrcSelectOption[],
  apiKey: string,
  model: string
): Promise<AiSuggestion> {
  const eventTypesStr = eventTypes
    .map((et) => `${et.id}: ${et.name}`)
    .join("\n");

  const summaryText = meeting.summary
    ? `Resumo: ${meeting.summary.summary}\nPontos: ${meeting.summary.key_points.join("; ")}\nAções: ${meeting.summary.tasks.join("; ")}`
    : `Transcrição: ${meeting.transcript.slice(0, 2000)}`;

  const prompt = `Você é um assistente que classifica reuniões de uma empresa financeira (JGP - gestora de investimentos).

Com base nos dados da reunião abaixo, sugira:
1. O tipo de evento mais adequado (event_type_id) dentre as opções disponíveis
2. Um assunto/subject curto e descritivo (máx 100 caracteres)
3. Ações/próximos passos (resumo das tarefas, máx 300 caracteres)

TIPOS DE EVENTO DISPONÍVEIS:
${eventTypesStr}

DADOS DA REUNIÃO:
Título: ${meeting.title}
${summaryText}

Responda APENAS em JSON, sem markdown:
{"event_type_id": "ID_NUMERICO", "subject": "assunto curto", "actions": "ações resumidas"}`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 300,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content ?? "{}";
  const cleaned = content
    .replace(/```json\s*/g, "")
    .replace(/```\s*/g, "")
    .trim();
  const parsed = JSON.parse(cleaned);

  return {
    event_type_id: String(parsed.event_type_id ?? ""),
    subject: String(parsed.subject ?? meeting.title),
    actions: String(parsed.actions ?? ""),
  };
}

// ─── Component ──────────────────────────────────────────────────────────────

export const JgrcExportModal: React.FC<JgrcExportModalProps> = ({
  meeting,
  settings,
  onClose,
  onExported,
}) => {
  // Form data from JGRC
  const [exportData, setExportData] = useState<JgrcExportData | null>(null);
  const [loadingData, setLoadingData] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // AI suggestion
  const [aiLoading, setAiLoading] = useState(false);
  const [aiDone, setAiDone] = useState(false);

  // Form fields
  const [eventTypeId, setEventTypeId] = useState("");
  const [responsibleId, setResponsibleId] = useState("");
  const [subject, setSubject] = useState(meeting.title);
  const [actions, setActions] = useState(
    meeting.summary?.tasks?.join("; ") ?? ""
  );
  const [managerId, setManagerId] = useState("");
  const [attendees, setAttendees] = useState("");
  const [internalAttendeeIds, setInternalAttendeeIds] = useState<string[]>([]);
  const [cityId, setCityId] = useState("");

  // Export state
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Meeting date (from recording)
  const meetingDate = meeting.started_at
    ? new Date(meeting.started_at).toISOString().split("T")[0]
    : new Date().toISOString().split("T")[0];

  // 1) Fetch form data from JGRC
  useEffect(() => {
    setLoadingData(true);
    setLoadError(null);
    invoke<JgrcExportData>("jgrc_get_export_data")
      .then((data) => {
        setExportData(data);
        // Auto-set responsible to logged-in user
        const userId = String(data.user.id);
        const isResponsible = data.responsibles.some((r) => r.id === userId);
        if (isResponsible) {
          setResponsibleId(userId);
        }
      })
      .catch((err) => {
        setLoadError(String(err));
      })
      .finally(() => setLoadingData(false));
  }, []);

  // 2) Once form data is loaded, run AI suggestion
  useEffect(() => {
    const apiKey = settings.summary_provider === "openrouter"
      ? settings.openrouter_api_key
      : settings.openai_api_key;
    const baseUrl = settings.summary_provider === "openrouter"
      ? "https://openrouter.ai/api/v1/chat/completions"
      : "https://api.openai.com/v1/chat/completions";
    if (!exportData || !apiKey || aiDone) return;

    setAiLoading(true);
    suggestFieldsWithAI(
      meeting,
      exportData.event_types,
      apiKey,
      settings.summary_model ?? "gpt-4o-mini"
    )
      .then((suggestion) => {
        if (suggestion.event_type_id) {
          const exists = exportData.event_types.some(
            (et) => et.id === suggestion.event_type_id
          );
          if (exists) setEventTypeId(suggestion.event_type_id);
        }
        if (suggestion.subject) setSubject(suggestion.subject);
        if (suggestion.actions) setActions(suggestion.actions);
        setAiDone(true);
      })
      .catch((err) => {
        console.warn("AI suggestion failed:", err);
        setAiDone(true);
      })
      .finally(() => setAiLoading(false));
    void baseUrl; // used for future invoke calls
  }, [exportData, settings.summary_provider, settings.openrouter_api_key, settings.openai_api_key]);

  // 3) Export handler
  const handleExport = async () => {
    setIsExporting(true);
    setExportError(null);
    try {
      const eventId = await invoke<string>("export_to_jgrc", {
        meetingId: meeting.id,
        eventTypeId: eventTypeId || null,
        responsibleId: responsibleId || null,
        subject,
        actions: actions || null,
        managerId: managerId || null,
        attendees: attendees || null,
        internalAttendeeIds:
          internalAttendeeIds.length > 0 ? internalAttendeeIds : null,
        cityId: cityId || null,
      });
      onExported(eventId);
    } catch (err) {
      setExportError(String(err));
    } finally {
      setIsExporting(false);
    }
  };

  // Toggle internal attendee
  const toggleAttendee = (id: string) => {
    setInternalAttendeeIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        className={clsx(
          "w-full max-w-2xl mx-4 rounded-2xl shadow-2xl overflow-hidden",
          "bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700"
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-100 dark:border-surface-800">
          <div className="flex items-center gap-2">
            <Upload className="w-5 h-5 text-primary-500" />
            <h2 className="text-base font-bold text-surface-900 dark:text-surface-100">
              Exportar para JGRC
            </h2>
            {aiLoading && (
              <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 animate-pulse">
                <Sparkles className="w-3 h-3" />
                IA preenchendo...
              </span>
            )}
            {aiDone && !aiLoading && (
              <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                <Sparkles className="w-3 h-3" />
                IA aplicada
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-surface-400 hover:text-surface-600 hover:bg-surface-100 dark:hover:text-surface-300 dark:hover:bg-surface-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {loadingData ? (
            <div className="flex items-center justify-center py-10">
              <Spinner size="lg" />
              <span className="ml-3 text-sm text-surface-500">
                Carregando dados do JGRC...
              </span>
            </div>
          ) : loadError ? (
            <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl">
              <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-red-700 dark:text-red-400">
                {loadError}
              </p>
            </div>
          ) : (
            <>
              {/* User info + Date */}
              <div className="flex items-center gap-4 p-2.5 bg-surface-50 dark:bg-surface-800/60 rounded-xl text-xs text-surface-600 dark:text-surface-400">
                <span className="flex items-center gap-1.5">
                  <User className="w-3.5 h-3.5" />
                  <strong className="text-surface-800 dark:text-surface-200">
                    {exportData?.user.name}
                  </strong>
                </span>
                <span className="flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5" />
                  {meetingDate}
                </span>
              </div>

              {/* Row 1: Subject */}
              <FieldGroup icon={<FileText />} label="Assunto">
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className={inputClass}
                  placeholder="Assunto do evento"
                />
              </FieldGroup>

              {/* Row 2: Event Type + Responsible */}
              <div className="grid grid-cols-2 gap-3">
                <FieldGroup icon={<Tag />} label="Tipo de Evento">
                  <select
                    value={eventTypeId}
                    onChange={(e) => setEventTypeId(e.target.value)}
                    className={inputClass}
                  >
                    <option value="">— Selecionar —</option>
                    {exportData?.event_types.map((et) => (
                      <option key={et.id} value={et.id}>
                        {et.name}
                      </option>
                    ))}
                  </select>
                </FieldGroup>

                <FieldGroup icon={<User />} label="Responsável">
                  <select
                    value={responsibleId}
                    onChange={(e) => setResponsibleId(e.target.value)}
                    className={inputClass}
                  >
                    <option value="">— Selecionar —</option>
                    {exportData?.responsibles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </FieldGroup>
              </div>

              {/* Row 3: Manager (Cliente) */}
              <FieldGroup
                icon={<Building2 />}
                label="Cliente - Quantidade de Eventos"
              >
                <select
                  value={managerId}
                  onChange={(e) => setManagerId(e.target.value)}
                  className={inputClass}
                >
                  <option value="">— Selecionar —</option>
                  {exportData?.managers.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {m.qtd_events > 0 ? ` - ${m.qtd_events}` : ""}
                    </option>
                  ))}
                </select>
              </FieldGroup>

              {/* Row 4: Participantes JGP (multi-select chips) */}
              <FieldGroup icon={<Users />} label="Participantes (JGP)">
                <div
                  className={clsx(
                    "flex flex-wrap gap-1.5 p-2 rounded-xl border max-h-28 overflow-y-auto",
                    "border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800/60"
                  )}
                >
                  {exportData?.internal_attendees.map((att) => {
                    const selected = internalAttendeeIds.includes(att.id);
                    return (
                      <button
                        key={att.id}
                        type="button"
                        onClick={() => toggleAttendee(att.id)}
                        className={clsx(
                          "px-2 py-0.5 rounded-full text-xs font-medium border transition-all",
                          selected
                            ? "bg-primary-500 border-primary-500 text-white"
                            : "bg-surface-50 dark:bg-surface-700/50 border-surface-200 dark:border-surface-600 text-surface-600 dark:text-surface-300 hover:border-primary-400"
                        )}
                      >
                        {att.name}
                      </button>
                    );
                  })}
                  {exportData?.internal_attendees.length === 0 && (
                    <span className="text-xs text-surface-400 italic">
                      Nenhum participante interno encontrado
                    </span>
                  )}
                </div>
              </FieldGroup>

              {/* Row 5: Participantes (externo, texto livre) */}
              <FieldGroup icon={<Users />} label="Participantes (Externos)">
                <input
                  type="text"
                  value={attendees}
                  onChange={(e) => setAttendees(e.target.value)}
                  className={inputClass}
                  placeholder="Nomes ou e-mails dos participantes externos"
                />
              </FieldGroup>

              {/* Row 6: City */}
              <FieldGroup icon={<MapPin />} label="Cidade">
                <select
                  value={cityId}
                  onChange={(e) => setCityId(e.target.value)}
                  className={inputClass}
                >
                  <option value="">— Selecionar —</option>
                  {exportData?.cities.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </FieldGroup>

              {/* Row 7: Actions */}
              <FieldGroup icon={<ListChecks />} label="Ações / Próximos Passos">
                <textarea
                  value={actions}
                  onChange={(e) => setActions(e.target.value)}
                  rows={2}
                  className={clsx(inputClass, "resize-none")}
                  placeholder="Ações resultantes da reunião..."
                />
              </FieldGroup>
            </>
          )}

          {exportError && (
            <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl">
              <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-red-700 dark:text-red-400">
                {exportError}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-surface-100 dark:border-surface-800 bg-surface-50/50 dark:bg-surface-800/30">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm font-medium text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={handleExport}
            disabled={isExporting || loadingData || !!loadError}
            className={clsx(
              "flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold",
              "bg-primary-500 text-white shadow-sm",
              "hover:bg-primary-600 transition-all duration-150",
              "disabled:opacity-60 disabled:cursor-not-allowed"
            )}
          >
            {isExporting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Exportando...
              </>
            ) : (
              <>
                <Upload className="w-4 h-4" />
                Exportar para JGRC
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const inputClass = clsx(
  "w-full px-3 py-2 text-sm rounded-xl border",
  "border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800/60",
  "text-surface-800 dark:text-surface-200",
  "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
  "transition-all"
);

interface FieldGroupProps {
  icon: React.ReactElement;
  label: string;
  children: React.ReactNode;
}

const FieldGroup: React.FC<FieldGroupProps> = ({ icon, label, children }) => (
  <div className="space-y-1.5">
    <label className="flex items-center gap-1.5 text-xs font-medium text-surface-600 dark:text-surface-400">
      {React.cloneElement(icon, { className: "w-3.5 h-3.5" })}
      {label}
    </label>
    {children}
  </div>
);
