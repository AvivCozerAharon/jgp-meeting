// hooks/useTranscription.ts
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { generateSummary } from "@/services/aiSummaryService";
import { getSettings } from "@/services/storageService";
import type { TranscriptSegment, MeetingSummary, SummaryStatus, AppSettings } from "@/types";
import type { UnlistenFn } from "@tauri-apps/api/event";

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

export interface TranscriptionState {
  segments: TranscriptSegment[];
  /** Texto plano derivado dos segmentos (para resumo/export) */
  transcript: string;
  summary: MeetingSummary | null;
  summaryStatus: SummaryStatus;
  summaryError: string | null;
}

export interface TranscriptionActions {
  clearTranscript: () => void;
  generateSummaryFromCurrent: () => Promise<void>;
  setTranscript: (text: string) => void;
  muteUpdates: () => void;
  unmuteUpdates: () => void;
}

export function useTranscription(): [TranscriptionState, TranscriptionActions] {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [summary, setSummary] = useState<MeetingSummary | null>(null);
  const [summaryStatus, setSummaryStatus] = useState<SummaryStatus>("idle");
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const unlistenerRef = useRef<UnlistenFn | null>(null);
  const mutedRef = useRef(false);

  const transcript = useMemo(() => segments.map(s => s.text).join(" "), [segments]);

  useEffect(() => {
    let isMounted = true;

    const setup = async () => {
      const unlisten = await listen<TranscriptSegment>("transcription-update", (event) => {
        if (!isMounted || mutedRef.current) return;
        const seg = event.payload;
        setSegments(prev => {
          const existingIdx = prev.findIndex(s => s.timestamp_ms === seg.timestamp_ms);
          if (existingIdx !== -1) {
            const updated = [...prev];
            updated[existingIdx] = seg;
            return updated;
          }
          const pos = prev.findIndex(s => s.timestamp_ms > seg.timestamp_ms);
          if (pos === -1) return [...prev, seg];
          return [...prev.slice(0, pos), seg, ...prev.slice(pos)];
        });
      });
      unlistenerRef.current = unlisten;
    };

    setup().catch(console.error);

    return () => {
      isMounted = false;
      unlistenerRef.current?.();
    };
  }, []);

  const clearTranscript = useCallback(() => {
    setSegments([]);
    setSummary(null);
    setSummaryStatus("idle");
    setSummaryError(null);
  }, []);

  const setTranscript = useCallback((text: string) => {
    if (text.trim()) {
      setSegments([{ source: "system", timestamp_ms: 0, text }]);
    } else {
      setSegments([]);
    }
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
      const { apiKey, baseUrl } = getSummaryCredentials(settings);
      if (!apiKey) {
        throw new Error(
          settings.summary_provider === "openrouter"
            ? "Chave do OpenRouter não configurada."
            : "Chave da API OpenAI não configurada."
        );
      }
      const result = await generateSummary(transcript, apiKey, settings.summary_model || "gpt-4o-mini", baseUrl);
      setSummary(result);
      setSummaryStatus("done");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSummaryError(msg);
      setSummaryStatus("error");
    }
  }, [transcript]);

  const muteUpdates = useCallback(() => { mutedRef.current = true; }, []);
  const unmuteUpdates = useCallback(() => { mutedRef.current = false; }, []);

  return [
    { segments, transcript, summary, summaryStatus, summaryError },
    { clearTranscript, generateSummaryFromCurrent, setTranscript, muteUpdates, unmuteUpdates },
  ];
}
