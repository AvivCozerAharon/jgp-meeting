// hooks/useMeetingHistory.ts
// Hook de histórico: carrega, filtra e gerencia as reuniões salvas.

import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { listMeetings, deleteMeeting, getMeeting } from "@/services/storageService";
import { generateAndSaveSummary } from "@/services/aiSummaryService";
import { getSettings } from "@/services/storageService";
import type { Meeting, AppSettings } from "@/types";
import { MEETING_TYPE_LABELS } from "@/types";

function getSummaryCredentials(settings: AppSettings): { apiKey: string; baseUrl: string } {
  if (settings.summary_provider === "openrouter") {
    return {
      apiKey: settings.openrouter_api_key ?? "",
      baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    };
  }
  return {
    apiKey: settings.openai_api_key ?? "",
    baseUrl: "https://api.openai.com/v1/chat/completions",
  };
}

export interface MeetingHistoryState {
  /** Lista de reuniões já filtrada pelo searchQuery */
  meetings: Meeting[];
  /** Lista completa sem filtro */
  allMeetings: Meeting[];
  /** Está carregando? */
  isLoading: boolean;
  /** Reunião atualmente selecionada para visualização */
  selectedMeeting: Meeting | null;
  /** Está gerando resumo para alguma reunião? */
  isGeneratingSummary: boolean;
  /** Erro */
  error: string | null;
  /** Feature 16: texto de busca atual */
  searchQuery: string;
}

export interface MeetingHistoryActions {
  /** Recarrega a lista de reuniões */
  refresh: () => Promise<void>;
  /** Seleciona uma reunião para visualização */
  selectMeeting: (id: string) => Promise<void>;
  /** Fecha a visualização de detalhe */
  closeMeeting: () => void;
  /** Remove uma reunião */
  remove: (id: string) => Promise<void>;
  /** Gera o resumo de uma reunião existente. `focus` opcional dá ênfase a um tópico. */
  generateSummary: (meetingId: string, focus?: string) => Promise<void>;
  /** Limpa o erro */
  clearError: () => void;
  /** Feature 16: atualiza o filtro de busca */
  setSearchQuery: (q: string) => void;
  /** Atualiza título e/ou transcrição de uma reunião */
  updateMeta: (id: string, title?: string, transcript?: string) => Promise<void>;
  /** Exporta reunião para o JGRC, retorna o ID do evento criado */
  exportToJgrc: (meetingId: string) => Promise<string>;
}

/**
 * Hook para gerenciar o histórico de reuniões: carregar, selecionar,
 * deletar e gerar resumos de reuniões passadas.
 */
export function useMeetingHistory(): [MeetingHistoryState, MeetingHistoryActions] {
  const [allMeetings, setAllMeetings] = useState<Meeting[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null);
  const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Feature 16: filtra reuniões com base no texto de busca
  const meetings = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return allMeetings;
    return allMeetings.filter((m) => {
      const typeLabel = m.meeting_type
        ? MEETING_TYPE_LABELS[m.meeting_type].toLowerCase()
        : "";
      return (
        m.title.toLowerCase().includes(q) ||
        m.transcript.toLowerCase().includes(q) ||
        typeLabel.includes(q)
      );
    });
  }, [allMeetings, searchQuery]);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await listMeetings();
      setAllMeetings(data);
    } catch (err) {
      setError(`Erro ao carregar reuniões: ${err}`);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Carrega ao montar
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Escuta `meeting-updated` do backend (emitido quando o draining termina e
  // a reunião é re-salva com a transcrição completa). Recarrega a reunião
  // específica para atualizar o transcript e a lista.
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    listen<{ meeting_id: string; transcript_length: number }>("meeting-updated", async (event) => {
      const { meeting_id } = event.payload;
      try {
        const updated = await getMeeting(meeting_id);
        setAllMeetings((prev) =>
          prev.map((m) => (m.id === meeting_id ? updated : m))
        );
        // Se a reunião atualizada é a que está selecionada no detalhe, atualiza também
        setSelectedMeeting((prev) =>
          prev?.id === meeting_id ? updated : prev
        );
      } catch {
        // Se não encontrar, simplesmente recarrega tudo
        refresh();
      }
    })
      .then((fn) => { unlisten = fn; })
      .catch(console.error);

    return () => { unlisten?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  const selectMeeting = useCallback(async (id: string) => {
    setError(null);
    try {
      const meeting = await getMeeting(id);
      setSelectedMeeting(meeting);
    } catch (err) {
      setError(`Erro ao carregar reunião: ${err}`);
    }
  }, []);

  const closeMeeting = useCallback(() => {
    setSelectedMeeting(null);
  }, []);

  const remove = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await deleteMeeting(id);
        setAllMeetings((prev) => prev.filter((m) => m.id !== id));
        if (selectedMeeting?.id === id) {
          setSelectedMeeting(null);
        }
      } catch (err) {
        setError(`Erro ao remover reunião: ${err}`);
      }
    },
    [selectedMeeting]
  );

  const generateSummary = useCallback(async (meetingId: string, focus?: string) => {
    setIsGeneratingSummary(true);
    setError(null);
    try {
      const settings = await getSettings();
      const { apiKey, baseUrl } = getSummaryCredentials(settings);
      if (!apiKey) {
        throw new Error(
          settings.summary_provider === "openrouter"
            ? "Chave do OpenRouter não configurada."
            : "Chave da API OpenAI não configurada."
        );
      }
      const summary = await generateAndSaveSummary(meetingId, apiKey, settings.summary_model, baseUrl, focus);

      // Atualiza a reunião na lista e no detalhe
      setAllMeetings((prev) =>
        prev.map((m) => (m.id === meetingId ? { ...m, summary } : m))
      );
      setSelectedMeeting((prev) =>
        prev?.id === meetingId ? { ...prev, summary } : prev
      );
    } catch (err) {
      setError(`Erro ao gerar resumo: ${err}`);
    } finally {
      setIsGeneratingSummary(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const updateMeta = useCallback(async (id: string, title?: string, transcript?: string) => {
    setError(null);
    try {
      const updated = await invoke<Meeting>("update_meeting_meta", {
        meetingId: id,
        title: title ?? null,
        transcript: transcript ?? null,
      });
      setAllMeetings((prev) => prev.map((m) => (m.id === id ? updated : m)));
      setSelectedMeeting((prev) => (prev?.id === id ? updated : prev));
    } catch (err) {
      setError(`Erro ao atualizar reunião: ${err}`);
    }
  }, []);

  const exportToJgrc = useCallback(async (meetingId: string): Promise<string> => {
    setError(null);
    const eventId = await invoke<string>("export_to_jgrc", { meetingId });
    // Atualiza jgrc_event_id na lista local
    setAllMeetings((prev) =>
      prev.map((m) => (m.id === meetingId ? { ...m, jgrc_event_id: eventId } : m))
    );
    setSelectedMeeting((prev) =>
      prev?.id === meetingId ? { ...prev, jgrc_event_id: eventId } : prev
    );
    return eventId;
  }, []);

  return [
    { meetings, allMeetings, isLoading, selectedMeeting, isGeneratingSummary, error, searchQuery },
    { refresh, selectMeeting, closeMeeting, remove, generateSummary, clearError, setSearchQuery, updateMeta, exportToJgrc },
  ];
}
