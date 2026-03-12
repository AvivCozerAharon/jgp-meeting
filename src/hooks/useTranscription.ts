// hooks/useTranscription.ts
// Hook de transcrição: escuta atualizações em tempo real e gerencia
// o estado do texto transcrito e do resumo gerado.

import { useState, useEffect, useRef, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { generateSummary } from "@/services/aiSummaryService";
import { getSettings } from "@/services/storageService";
import type { MeetingSummary, SummaryStatus } from "@/types";
import type { UnlistenFn } from "@tauri-apps/api/event";

export interface TranscriptionState {
  /** Texto completo transcrito até o momento */
  transcript: string;
  /** Resumo gerado pela IA */
  summary: MeetingSummary | null;
  /** Status da geração do resumo */
  summaryStatus: SummaryStatus;
  /** Erro de geração de resumo */
  summaryError: string | null;
}

export interface TranscriptionActions {
  /** Limpa a transcrição atual */
  clearTranscript: () => void;
  /** Gera o resumo a partir da transcrição atual */
  generateSummaryFromCurrent: () => Promise<void>;
  /** Define manualmente a transcrição (para restaurar estado) */
  setTranscript: (text: string) => void;
  /** Para de escutar atualizações do backend (usado após stop para não poluir a tela com draining) */
  muteUpdates: () => void;
  /** Volta a escutar atualizações do backend (usado ao iniciar nova gravação) */
  unmuteUpdates: () => void;
}

/**
 * Hook que escuta eventos de transcrição em tempo real do backend Tauri
 * e gerencia a geração de resumo via IA.
 */
export function useTranscription(): [TranscriptionState, TranscriptionActions] {
  const [transcript, setTranscriptState] = useState("");
  const [summary, setSummary] = useState<MeetingSummary | null>(null);
  const [summaryStatus, setSummaryStatus] = useState<SummaryStatus>("idle");
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const unlistenerRef = useRef<UnlistenFn | null>(null);
  // Quando true, ignora eventos transcription-update do backend.
  // Ativado após stop (para não repopular a tela com texto do draining).
  // Desativado ao iniciar nova gravação.
  const mutedRef = useRef(false);

  // Escuta atualizações de transcrição em tempo real
  useEffect(() => {
    let isMounted = true;

    const setup = async () => {
      const unlisten = await listen<string>("transcription-update", (event) => {
        if (isMounted && !mutedRef.current) {
          setTranscriptState(event.payload);
        }
      });
      unlistenerRef.current = unlisten;
    };

    setup().catch(console.error);

    return () => {
      isMounted = false;
      if (unlistenerRef.current) {
        unlistenerRef.current();
      }
    };
  }, []);

  const clearTranscript = useCallback(() => {
    setTranscriptState("");
    setSummary(null);
    setSummaryStatus("idle");
    setSummaryError(null);
  }, []);

  const setTranscript = useCallback((text: string) => {
    setTranscriptState(text);
  }, []);

  const generateSummaryFromCurrent = useCallback(async () => {
    if (!transcript.trim()) {
      setSummaryError("Transcrição vazia. Grave uma reunião primeiro.");
      return;
    }

    setSummaryStatus("loading");
    setSummaryError(null);
    setSummary(null);

    try {
      const settings = await getSettings();

      if (!settings.openai_api_key) {
        throw new Error("Chave da API OpenAI não configurada. Acesse as Configurações.");
      }

      const result = await generateSummary(
        transcript,
        settings.openai_api_key,
        settings.summary_model || "gpt-4o-mini"
      );

      setSummary(result);
      setSummaryStatus("done");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSummaryError(msg);
      setSummaryStatus("error");
    }
  }, [transcript]);

  const muteUpdates = useCallback(() => {
    mutedRef.current = true;
  }, []);

  const unmuteUpdates = useCallback(() => {
    mutedRef.current = false;
  }, []);

  return [
    { transcript, summary, summaryStatus, summaryError },
    { clearTranscript, generateSummaryFromCurrent, setTranscript, muteUpdates, unmuteUpdates },
  ];
}
