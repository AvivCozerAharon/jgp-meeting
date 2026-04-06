// services/aiSummaryService.ts
import { invoke } from "@tauri-apps/api/core";
import type { MeetingSummary } from "@/types";

export async function generateSummary(
  transcript: string,
  apiKey: string,
  model?: string,
  baseUrl?: string
): Promise<MeetingSummary> {
  return await invoke<MeetingSummary>("generate_summary", {
    transcript,
    apiKey,
    model: model ?? "gpt-4o-mini",
    baseUrl: baseUrl ?? null,
  });
}

export async function generateAndSaveSummary(
  meetingId: string,
  apiKey: string,
  model?: string,
  baseUrl?: string
): Promise<MeetingSummary> {
  return await invoke<MeetingSummary>("generate_and_save_summary", {
    meetingId,
    apiKey,
    model: model ?? "gpt-4o-mini",
    baseUrl: baseUrl ?? null,
  });
}

export async function askAboutTranscript(
  meetingId: string,
  question: string,
  apiKey: string,
  model?: string,
  baseUrl?: string
): Promise<string> {
  return await invoke<string>("ask_about_transcript", {
    meetingId,
    question,
    apiKey,
    model: model ?? "gpt-4o-mini",
    baseUrl: baseUrl ?? null,
  });
}

export function hasMeaningfulSummary(summary: MeetingSummary | null): boolean {
  if (!summary) return false;
  return summary.summary.length > 10;
}
