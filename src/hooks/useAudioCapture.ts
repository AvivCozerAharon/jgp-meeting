// hooks/useAudioCapture.ts
// Hook de captura de áudio: gerencia o ciclo de vida da gravação
// e expõe o estado para os componentes React.

import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  startCapture,
  stopCapture,
  onAudioLevel,
  onTranscriptionProcessing,
  onTranscriptionError,
} from "@/services/audioCaptureService";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { MeetingType } from "@/types";

export interface AudioCaptureState {
  isCapturing: boolean;
  audioLevel: number;
  micLevel: number;
  micMuted: boolean;
  isProcessing: boolean;
  error: string | null;
  duration: number;
  lastMeetingId: string | null;
}

export interface AudioCaptureActions {
  /** Inicia a captura com o tipo de reunião selecionado (Feature 8) */
  start: (meetingType?: MeetingType) => Promise<void>;
  stop: () => Promise<string | null>;
  /** Muta/desmuta o microfone durante a gravação */
  toggleMicMute: () => Promise<void>;
  clearError: () => void;
}

/**
 * Hook que gerencia a captura de áudio do sistema.
 * Configura os listeners de eventos Tauri e expõe o estado da captura.
 */
export function useAudioCapture(): [AudioCaptureState, AudioCaptureActions] {
  const [isCapturing, setIsCapturing] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [micMuted, setMicMuted] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [lastMeetingId, setLastMeetingId] = useState<string | null>(null);

  // Refs para listeners (para cleanup no unmount)
  const unlisteners = useRef<UnlistenFn[]>([]);
  // Ref para o timer de duração
  const durationTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Configura listeners de eventos Tauri
  useEffect(() => {
    let isMounted = true;

    const setupListeners = async () => {
      const unlistenLevel = await onAudioLevel((level) => {
        if (isMounted) setAudioLevel(level);
      });

      const { listen } = await import("@tauri-apps/api/event");
      const unlistenMic = await listen<number>("mic-level", (e) => {
        if (isMounted) setMicLevel(e.payload);
      });

      const unlistenProcessing = await onTranscriptionProcessing((processing) => {
        if (isMounted) setIsProcessing(processing);
      });

      const unlistenError = await onTranscriptionError((err) => {
        if (isMounted) setError(`Erro de transcrição: ${err}`);
      });

      // Sincroniza estado quando stop vem de outra janela (ex: compliance overlay)
      const unlistenStopped = await listen<string>("recording-stopped", (e) => {
        if (isMounted) {
          setIsCapturing(false);
          setAudioLevel(0);
          setIsProcessing(false);
          setLastMeetingId(e.payload);
        }
      });

      unlisteners.current = [unlistenLevel, unlistenMic, unlistenProcessing, unlistenError, unlistenStopped];
    };

    setupListeners().catch(console.error);

    return () => {
      isMounted = false;
      unlisteners.current.forEach((unlisten) => unlisten());
      if (durationTimer.current) clearInterval(durationTimer.current);
    };
  }, []);

  // Timer de duração (conta enquanto está capturando)
  useEffect(() => {
    if (isCapturing) {
      setDuration(0);
      durationTimer.current = setInterval(() => {
        setDuration((d) => d + 1);
      }, 1000);
    } else {
      if (durationTimer.current) {
        clearInterval(durationTimer.current);
        durationTimer.current = null;
      }
    }

    return () => {
      if (durationTimer.current) clearInterval(durationTimer.current);
    };
  }, [isCapturing]);

  const start = useCallback(async (meetingType?: MeetingType) => {
    setError(null);
    setDuration(0);
    setLastMeetingId(null);
    setMicMuted(false); // Reset mic muted ao iniciar
    try {
      await startCapture(meetingType);
      setIsCapturing(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    }
  }, []);

  const stop = useCallback(async (): Promise<string | null> => {
    try {
      const meetingId = await stopCapture();
      setIsCapturing(false);
      setAudioLevel(0);
      setIsProcessing(false);
      setLastMeetingId(meetingId);
      return meetingId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setIsCapturing(false);
      return null;
    }
  }, []);

  const toggleMicMute = useCallback(async () => {
    try {
      const muted = await invoke<boolean>("toggle_mic_mute");
      setMicMuted(muted);
    } catch (err) {
      console.error("Erro ao mutar microfone:", err);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return [
    { isCapturing, audioLevel, micLevel, micMuted, isProcessing, error, duration, lastMeetingId },
    { start, stop, toggleMicMute, clearError },
  ];
}
