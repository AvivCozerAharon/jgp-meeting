// services/storageService.ts
// Serviço de persistência: interface TypeScript para os comandos Tauri
// relacionados ao histórico de reuniões e configurações.

import { invoke } from "@tauri-apps/api/core";
import type { Meeting, AppSettings } from "@/types";

// ─── Reuniões ─────────────────────────────────────────────────────────────────

/**
 * Lista todas as reuniões salvas, ordenadas da mais recente para a mais antiga.
 */
export async function listMeetings(): Promise<Meeting[]> {
  return await invoke<Meeting[]>("list_meetings");
}

/**
 * Carrega uma reunião específica pelo ID.
 */
export async function getMeeting(id: string): Promise<Meeting> {
  return await invoke<Meeting>("get_meeting", { id });
}

/**
 * Remove uma reunião pelo ID.
 */
export async function deleteMeeting(id: string): Promise<void> {
  await invoke("delete_meeting", { id });
}

// ─── Configurações ────────────────────────────────────────────────────────────

/**
 * Carrega as configurações do aplicativo.
 */
export async function getSettings(): Promise<AppSettings> {
  return await invoke<AppSettings>("get_settings");
}

/**
 * Salva as configurações do aplicativo.
 */
export async function saveSettings(settings: AppSettings): Promise<void> {
  await invoke("save_settings", { settings });
}

// ─── Utilitários ──────────────────────────────────────────────────────────────

/**
 * Formata a data de uma reunião para exibição
 */
export function formatMeetingDate(isoDate: string): string {
  const date = new Date(isoDate);
  return date.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Calcula a duração de uma reunião em formato legível
 */
export function formatMeetingDuration(seconds: number): string {
  if (seconds === 0) return "—";
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}min`;
  return `${m}min`;
}

/**
 * Gera um trecho de preview da transcrição (primeiras N palavras)
 */
export function transcriptPreview(transcript: string, wordCount = 20): string {
  if (!transcript) return "Sem transcrição";
  const words = transcript.split(/\s+/).slice(0, wordCount);
  const preview = words.join(" ");
  return transcript.split(/\s+/).length > wordCount ? `${preview}...` : preview;
}
