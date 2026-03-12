// types/index.ts — JGP Meeting
// Espelham as structs Rust do backend Tauri.

// ─── Feature 8: Tipo de reunião ───────────────────────────────────────────────

export type MeetingType =
  | 'general'
  | 'standup'
  | 'one_on_one'
  | 'retrospective'
  | 'commercial'
  | 'interview';

export const MEETING_TYPE_LABELS: Record<MeetingType, string> = {
  general:       'Reunião Geral',
  standup:       'Daily Standup',
  one_on_one:    '1:1',
  retrospective: 'Retrospectiva',
  commercial:    'Comercial',
  interview:     'Entrevista',
};

export const MEETING_TYPE_ICONS: Record<MeetingType, string> = {
  general:       '🏢',
  standup:       '⚡',
  one_on_one:    '👥',
  retrospective: '🔄',
  commercial:    '💼',
  interview:     '🎯',
};

// ─── Feature 10: Diarização ───────────────────────────────────────────────────

export interface SpeakerSegment {
  speaker: string;
  text: string;
  index: number;
}

// ─── Resumo ───────────────────────────────────────────────────────────────────

export interface MeetingSummary {
  summary: string;
  decisions: string[];
  tasks: string[];
  key_points: string[];
  /** Feature 9: rascunho de e-mail de follow-up */
  followup_email?: string | null;
}

// ─── Reunião ──────────────────────────────────────────────────────────────────

export interface Meeting {
  id: string;
  title: string;
  started_at: string;
  ended_at: string | null;
  duration_secs: number;
  transcript: string;
  summary: MeetingSummary | null;
  /** Feature 8 */
  meeting_type?: MeetingType | null;
  /** Feature 10 */
  speakers?: SpeakerSegment[] | null;
  /** ID do evento no JGRC após exportação */
  jgrc_event_id?: string | null;
}

// ─── Configurações ────────────────────────────────────────────────────────────

export interface AppSettings {
  openai_api_key: string;
  transcription_language: string;
  summary_model: string;
  chunk_duration_secs: number;
  /** Feature 1: threshold de silêncio */
  silence_threshold: number;
  /** Feature 5: captura microfone */
  capture_microphone: boolean;
  /** Feature 7: whisper local */
  use_local_whisper: boolean;
  local_whisper_exe: string;
  local_whisper_model: string;
  /** Feature 8: tipo padrão */
  default_meeting_type: MeetingType;
  /** Feature 13: atalho global (ex: "ctrl+shift+r") */
  global_hotkey: string;
  /** Feature 15: gerar resumo automaticamente ao parar */
  auto_summary: boolean;
  /** Download de modelo Whisper: diretório dos modelos */
  local_models_dir: string;
  /** Microfone selecionado (ID WASAPI). Vazio = padrão do sistema */
  selected_microphone: string;
  /** Tema da interface: "dark", "light" ou "system" */
  theme: 'dark' | 'light' | 'system';
  // ─── Integração JGRC ──────────────────────────────────────────────────────
  jgrc_url: string;
  jgrc_token: string;
  jgrc_event_type_id: string;
  jgrc_responsible_id: string;
}

/** Dispositivo de áudio de entrada disponível no sistema */
export interface AudioDevice {
  id: string;
  name: string;
}

// ─── Status ───────────────────────────────────────────────────────────────────

export interface CaptureStatus {
  is_capturing: boolean;
  audio_level: number;
  mic_level: number;
  transcript_length: number;
  duration_secs: number;
}

/** Feature 12: app de reunião detectado */
export interface DetectedApp {
  name: string;
  process: string;
}

export type AppPage = 'main' | 'history' | 'settings';
export type TranscriptionStatus = 'idle' | 'capturing' | 'processing' | 'error';
export type SummaryStatus = 'idle' | 'loading' | 'done' | 'error';

// Eventos Tauri
export type TranscriptionUpdatePayload = string;
export type AudioLevelPayload = number;
export type TranscriptionProcessingPayload = boolean;
export type TranscriptionErrorPayload = string;

/** Progresso do draining de chunks pendentes após parar gravação */
export interface TranscriptionDrainingPayload {
  pending: number;
  total: number;
}
