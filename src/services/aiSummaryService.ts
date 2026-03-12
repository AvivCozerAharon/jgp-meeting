// services/aiSummaryService.ts
// Serviço de geração de resumo via IA: interface TypeScript para os comandos
// Tauri de geração de resumo com GPT.

import { invoke } from "@tauri-apps/api/core";
import type { MeetingSummary } from "@/types";

/**
 * Gera um resumo estruturado a partir de uma transcrição.
 *
 * @param transcript - Texto da transcrição
 * @param apiKey - Chave da API OpenAI
 * @param model - Modelo GPT (default: gpt-4o-mini)
 */
export async function generateSummary(
  transcript: string,
  apiKey: string,
  model?: string
): Promise<MeetingSummary> {
  return await invoke<MeetingSummary>("generate_summary", {
    transcript,
    apiKey,
    model: model ?? "gpt-4o-mini",
  });
}

/**
 * Gera e salva o resumo de uma reunião existente no histórico.
 *
 * @param meetingId - ID da reunião
 * @param apiKey - Chave da API OpenAI
 * @param model - Modelo GPT (default: gpt-4o-mini)
 */
export async function generateAndSaveSummary(
  meetingId: string,
  apiKey: string,
  model?: string
): Promise<MeetingSummary> {
  return await invoke<MeetingSummary>("generate_and_save_summary", {
    meetingId,
    apiKey,
    model: model ?? "gpt-4o-mini",
  });
}

/**
 * Feature 29: Responde a uma pergunta sobre a transcrição de uma reunião.
 */
export async function askAboutTranscript(
  meetingId: string,
  question: string,
  apiKey: string,
  model?: string
): Promise<string> {
  return await invoke<string>("ask_about_transcript", {
    meetingId,
    question,
    apiKey,
    model: model ?? "gpt-4o-mini",
  });
}

/**
 * Verifica se um resumo tem conteúdo significativo
 */
export function hasMeaningfulSummary(summary: MeetingSummary | null): boolean {
  if (!summary) return false;
  return (
    summary.summary.length > 10 ||
    summary.decisions.length > 0 ||
    summary.tasks.length > 0 ||
    summary.key_points.length > 0
  );
}
