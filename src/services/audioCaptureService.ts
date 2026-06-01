// services/audioCaptureService.ts
// Serviço de captura de áudio: interface TypeScript para os comandos Tauri
// relacionados à captura de áudio do sistema.

import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import type {
  CaptureStatus,
  MeetingType,
  AudioLevelPayload,
  TranscriptionUpdatePayload,
  TranscriptionProcessingPayload,
  TranscriptionErrorPayload,
} from "@/types";

// ─── Comandos ─────────────────────────────────────────────────────────────────

/**
 * Inicia a captura de áudio do sistema.
 * Retorna void em caso de sucesso ou lança um erro descritivo.
 */
/** Inicia a captura de áudio com o tipo de reunião selecionado (Feature 8). */
export async function startCapture(meetingType?: MeetingType): Promise<void> {
  await invoke("start_capture", { meetingType: meetingType ?? null });
}

/**
 * Para a captura de áudio e finaliza a reunião atual.
 * Retorna o ID da reunião salva.
 */
export async function stopCapture(): Promise<string> {
  return await invoke<string>("stop_capture");
}

/**
 * Retorna o status atual da captura (está gravando, nível de áudio, etc.)
 */
export async function getCaptureStatus(): Promise<CaptureStatus> {
  return await invoke<CaptureStatus>("get_capture_status");
}

/**
 * Retorna a transcrição atual (útil para sincronização após reload)
 */
export async function getCurrentTranscript(): Promise<string> {
  return await invoke<string>("get_current_transcript");
}

// ─── Listeners de Eventos ─────────────────────────────────────────────────────

/**
 * Escuta atualizações de transcrição em tempo real.
 * Retorna função para cancelar o listener.
 */
export async function onTranscriptionUpdate(
  callback: (transcript: string) => void
): Promise<UnlistenFn> {
  return listen<TranscriptionUpdatePayload>("transcription-update", (event) => {
    callback(event.payload);
  });
}

/**
 * Escuta o nível de áudio em tempo real (0.0 a 1.0).
 * Retorna função para cancelar o listener.
 */
export async function onAudioLevel(
  callback: (level: number) => void
): Promise<UnlistenFn> {
  return listen<AudioLevelPayload>("audio-level", (event) => {
    callback(event.payload);
  });
}

/**
 * Escuta eventos de processamento (enviando chunk para Whisper).
 * Retorna função para cancelar o listener.
 */
export async function onTranscriptionProcessing(
  callback: (payload: TranscriptionProcessingPayload) => void
): Promise<UnlistenFn> {
  return listen<TranscriptionProcessingPayload>(
    "transcription-processing",
    (event) => {
      callback(event.payload);
    }
  );
}

/**
 * Escuta erros de transcrição.
 * Retorna função para cancelar o listener.
 */
export async function onTranscriptionError(
  callback: (error: string) => void
): Promise<UnlistenFn> {
  return listen<TranscriptionErrorPayload>("transcription-error", (event) => {
    callback(event.payload);
  });
}

// ─── Utilitários ──────────────────────────────────────────────────────────────

/**
 * Formata duração em segundos para string legível (ex: "1h 23min 45s")
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}min ${s}s`;
  return `${m}min ${s}s`;
}

// ─── Mic Tuner ───────────────────────────────────────────────────────────────

export interface MicTestResult {
  status: string;
  transcript: string;
  avg_rms: string;
  peak: string;
  quality: "good" | "low" | "high" | "no_speech";
  message: string;
}

export async function testMicWithTranscription(durationSecs?: number): Promise<MicTestResult> {
  return await invoke<MicTestResult>("test_mic_with_transcription", {
    durationSecs: durationSecs ?? null,
  });
}

export interface MicTestLevel {
  rms: number;
  peak: number;
}

export async function onMicTestLevel(
  callback: (level: MicTestLevel) => void
): Promise<UnlistenFn> {
  return listen<MicTestLevel>("mic-test-level", (event) => {
    callback(event.payload);
  });
}
