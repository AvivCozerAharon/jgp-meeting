// components/JgrcExportModal.tsx
// Modal para exportar reunião para o JGRC com campos pré-preenchidos por IA.

import React, { useState, useEffect, useRef, useCallback } from "react";
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
  ChevronDown,
  Search,
  List,
  ListOrdered,
} from "lucide-react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
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
  onExported: (eventId: string, eventUrl: string) => void;
}

// ─── RichTextEditor ──────────────────────────────────────────────────────────

const ToolbarBtn: React.FC<{
  onClick: () => void;
  active: boolean;
  title: string;
  children: React.ReactNode;
}> = ({ onClick, active, title, children }) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    className={clsx(
      "w-7 h-7 rounded-lg flex items-center justify-center transition-colors",
      active
        ? "bg-primary-100 dark:bg-primary-500/20 text-primary-700 dark:text-primary-300"
        : "text-surface-500 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700"
    )}
  >
    {children}
  </button>
);

const RichTextEditor: React.FC<{ content: string; onChange: (html: string) => void }> = ({
  content,
  onChange,
}) => {
  const editor = useEditor({
    extensions: [StarterKit, Underline],
    content,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
  });

  if (!editor) return null;

  return (
    <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800/60 overflow-hidden">
      <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-surface-100 dark:border-surface-700">
        <ToolbarBtn onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive("bold")} title="Negrito">
          <strong className="text-xs">B</strong>
        </ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive("italic")} title="Itálico">
          <em className="text-xs">I</em>
        </ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive("underline")} title="Sublinhado">
          <span className="text-xs underline">U</span>
        </ToolbarBtn>
        <div className="w-px h-4 bg-surface-200 dark:bg-surface-600 mx-1" />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive("bulletList")} title="Lista">
          <List className="w-3.5 h-3.5" />
        </ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive("orderedList")} title="Lista numerada">
          <ListOrdered className="w-3.5 h-3.5" />
        </ToolbarBtn>
      </div>
      <EditorContent
        editor={editor}
        className="px-3 py-2 text-sm text-surface-800 dark:text-surface-200 min-h-[120px] max-h-[200px] overflow-y-auto prose prose-sm dark:prose-invert max-w-none"
      />
    </div>
  );
};

// ─── SearchableSelect ────────────────────────────────────────────────────────

interface SearchableSelectProps {
  options: JgrcSelectOption[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
}

const SearchableSelect: React.FC<SearchableSelectProps> = ({
  options,
  value,
  onChange,
  placeholder = "— Selecionar —",
  searchPlaceholder = "Pesquisar...",
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = query.trim()
    ? options.filter((o) =>
        o.name.toLowerCase().includes(query.toLowerCase())
      )
    : options;

  const selectedOption = options.find((o) => o.id === value);

  // Fecha ao clicar fora
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Foca o input ao abrir e reseta estado
  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlighted(0);
      setTimeout(() => searchRef.current?.focus(), 0);
    }
  }, [open]);

  // Scroll para o item destacado
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const item = list.children[highlighted] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [highlighted, open]);

  const select = useCallback(
    (id: string) => {
      onChange(id);
      setOpen(false);
    },
    [onChange]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlighted((h) => Math.min(h + 1, filtered.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlighted((h) => Math.max(h - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (filtered[highlighted]) select(filtered[highlighted].id);
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        break;
    }
  };

  // Reset highlight when filter changes
  useEffect(() => {
    setHighlighted(0);
  }, [query]);

  return (
    <div ref={containerRef} className="relative" onKeyDown={handleKeyDown}>
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          inputClass,
          "flex items-center justify-between gap-2 text-left cursor-pointer",
          open && "ring-2 ring-primary-500 border-transparent"
        )}
      >
        <span className={clsx(!selectedOption && "text-surface-400 dark:text-surface-500")}>
          {selectedOption ? selectedOption.name : placeholder}
        </span>
        <ChevronDown
          className={clsx(
            "w-4 h-4 flex-shrink-0 text-surface-400 transition-transform duration-150",
            open && "rotate-180"
          )}
        />
      </button>

      {/* Dropdown */}
      {open && (
        <div
          className={clsx(
            "absolute z-50 mt-1 w-full rounded-xl shadow-xl border overflow-hidden",
            "bg-white dark:bg-surface-800",
            "border-surface-200 dark:border-surface-700"
          )}
        >
          {/* Search input */}
          <div className="p-2 border-b border-surface-100 dark:border-surface-700">
            <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-surface-50 dark:bg-surface-700/60">
              <Search className="w-3.5 h-3.5 text-surface-400 flex-shrink-0" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full bg-transparent text-sm text-surface-800 dark:text-surface-200 placeholder-surface-400 focus:outline-none"
              />
            </div>
          </div>

          {/* Options */}
          <ul ref={listRef} className="max-h-48 overflow-y-auto py-1">
            {/* Opção vazia */}
            <li>
              <button
                type="button"
                onClick={() => select("")}
                className={clsx(
                  "w-full px-3 py-2 text-sm text-left",
                  "text-surface-400 dark:text-surface-500 italic",
                  "hover:bg-surface-50 dark:hover:bg-surface-700/50 transition-colors"
                )}
              >
                {placeholder}
              </button>
            </li>
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-surface-400 dark:text-surface-500 italic">
                Nenhum resultado
              </li>
            ) : (
              filtered.map((opt, idx) => (
                <li key={opt.id}>
                  <button
                    type="button"
                    onClick={() => select(opt.id)}
                    className={clsx(
                      "w-full px-3 py-2 text-sm text-left transition-colors",
                      idx === highlighted
                        ? "bg-primary-50 dark:bg-primary-500/15 text-primary-700 dark:text-primary-300"
                        : "text-surface-800 dark:text-surface-200 hover:bg-surface-50 dark:hover:bg-surface-700/50",
                      opt.id === value && idx !== highlighted && "font-medium"
                    )}
                    onMouseEnter={() => setHighlighted(idx)}
                  >
                    {opt.name}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
};

// ─── AI Suggestion Helper ───────────────────────────────────────────────────

async function suggestFieldsWithAI(
  meeting: Meeting,
  eventTypes: JgrcSelectOption[],
  apiKey: string,
  model: string,
  baseUrl?: string
): Promise<AiSuggestion> {
  const eventTypesStr = eventTypes
    .map((et) => `${et.id}: ${et.name}`)
    .join("\n");

  const summaryText = meeting.summary
    ? `Resumo: ${meeting.summary.summary}`
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

  const url = baseUrl || "https://api.openai.com/v1/chat/completions";
  const response = await fetch(url, {
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
  const [content, setContent] = useState(
    meeting.summary?.summary ?? meeting.transcript.slice(0, 3000)
  );
  const [actions, setActions] = useState("");
  const [managerId, setManagerId] = useState("");
  const [attendees, setAttendees] = useState("");
  const [internalAttendeeIds, setInternalAttendeeIds] = useState<string[]>([]);
  const [cityId, setCityId] = useState("");
  const [company, setCompany] = useState<"jgp" | "regia">("jgp");

  // Filtro de participantes JGP
  const [attendeeSearch, setAttendeeSearch] = useState("");

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
      settings.summary_model ?? "gpt-4o-mini",
      baseUrl
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
  }, [exportData, settings.summary_provider, settings.openrouter_api_key, settings.openai_api_key, settings.summary_model, meeting]);

  // 3) Export handler
  const handleExport = async () => {
    setIsExporting(true);
    setExportError(null);
    try {
      const result = await invoke<{ event_id: string; event_url: string }>("export_to_jgrc", {
        meetingId: meeting.id,
        eventTypeId: eventTypeId || null,
        responsibleId: responsibleId || null,
        subject,
        content: content || null,
        actions: actions || null,
        managerId: managerId || null,
        attendees: attendees || null,
        internalAttendeeIds:
          internalAttendeeIds.length > 0 ? internalAttendeeIds : null,
        cityId: cityId || null,
        company,
      });
      onExported(result.event_id, result.event_url);
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

  // Participantes filtrados pela busca
  const filteredAttendees = attendeeSearch.trim()
    ? (exportData?.internal_attendees ?? []).filter((a) =>
        a.name.toLowerCase().includes(attendeeSearch.toLowerCase())
      )
    : (exportData?.internal_attendees ?? []);

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

              {/* Empresa */}
              <FieldGroup icon={<Building2 />} label="Empresa">
                <div className="flex gap-2">
                  {(["jgp", "regia"] as const).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setCompany(c)}
                      className={clsx(
                        "flex-1 py-1.5 rounded-lg text-xs font-semibold border transition-all",
                        company === c
                          ? "bg-primary-500 border-primary-500 text-white"
                          : "border-surface-200 dark:border-surface-700 text-surface-500 dark:text-surface-400 hover:border-primary-400 dark:hover:border-primary-500 hover:text-primary-600 dark:hover:text-primary-400"
                      )}
                    >
                      {c === "jgp" ? "JGP" : "Régia"}
                    </button>
                  ))}
                </div>
              </FieldGroup>

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

              {/* Row 1b: Content */}
              <FieldGroup
                icon={<FileText />}
                label={
                  meeting.summary
                    ? "Conteúdo (resumo — editável)"
                    : "Conteúdo (transcrição — editável)"
                }
              >
                <RichTextEditor content={content} onChange={setContent} />
              </FieldGroup>

              {/* Row 2: Event Type + Responsible */}
              <div className="grid grid-cols-2 gap-3">
                <FieldGroup icon={<Tag />} label="Tipo de Evento">
                  <SearchableSelect
                    options={exportData?.event_types ?? []}
                    value={eventTypeId}
                    onChange={setEventTypeId}
                    placeholder="— Selecionar —"
                    searchPlaceholder="Buscar tipo..."
                  />
                </FieldGroup>

                <FieldGroup icon={<User />} label="Responsável">
                  <SearchableSelect
                    options={exportData?.responsibles ?? []}
                    value={responsibleId}
                    onChange={setResponsibleId}
                    placeholder="— Selecionar —"
                    searchPlaceholder="Buscar responsável..."
                  />
                </FieldGroup>
              </div>

              {/* Row 3: Manager (Cliente) */}
              <FieldGroup
                icon={<Building2 />}
                label="Cliente - Quantidade de Eventos"
              >
                <SearchableSelect
                  options={(exportData?.managers ?? []).map((m) => ({
                    id: m.id,
                    name: m.qtd_events > 0 ? `${m.name} — ${m.qtd_events}` : m.name,
                  }))}
                  value={managerId}
                  onChange={setManagerId}
                  placeholder="— Selecionar —"
                  searchPlaceholder="Buscar cliente..."
                />
              </FieldGroup>

              {/* Row 4: Participantes JGP (chips com filtro) */}
              <FieldGroup icon={<Users />} label="Participantes (JGP)">
                <div
                  className={clsx(
                    "rounded-xl border",
                    "border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800/60"
                  )}
                >
                  {/* Filtro */}
                  <div className="flex items-center gap-2 px-2.5 py-2 border-b border-surface-100 dark:border-surface-700">
                    <Search className="w-3.5 h-3.5 text-surface-400 flex-shrink-0" />
                    <input
                      type="text"
                      value={attendeeSearch}
                      onChange={(e) => setAttendeeSearch(e.target.value)}
                      placeholder="Filtrar participantes..."
                      className="w-full bg-transparent text-sm text-surface-800 dark:text-surface-200 placeholder-surface-400 focus:outline-none"
                    />
                    {internalAttendeeIds.length > 0 && (
                      <span className="text-xs font-medium text-primary-600 dark:text-primary-400 flex-shrink-0">
                        {internalAttendeeIds.length} sel.
                      </span>
                    )}
                  </div>
                  {/* Chips */}
                  <div className="flex flex-wrap gap-1.5 p-2 max-h-24 overflow-y-auto">
                    {filteredAttendees.map((att) => {
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
                    {filteredAttendees.length === 0 && (
                      <span className="text-xs text-surface-400 italic">
                        {attendeeSearch ? "Nenhum resultado" : "Nenhum participante interno encontrado"}
                      </span>
                    )}
                  </div>
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
                <SearchableSelect
                  options={exportData?.cities ?? []}
                  value={cityId}
                  onChange={setCityId}
                  placeholder="— Selecionar —"
                  searchPlaceholder="Buscar cidade..."
                />
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
  label: React.ReactNode;
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
