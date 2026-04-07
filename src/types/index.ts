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

// ─── Tags ─────────────────────────────────────────────────────────────────────

export interface Tag {
  id: string;
  name: string;
  color: string;
}

export const TAG_COLORS = [
  "#ef4444", // Vermelho
  "#f97316", // Laranja
  "#eab308", // Amarelo
  "#22c55e", // Verde
  "#14b8a6", // Turquesa
  "#3b82f6", // Azul
  "#6366f1", // Índigo
  "#a855f7", // Roxo
  "#ec4899", // Rosa
  "#6b7280", // Cinza
] as const;

// ─── Feature 10: Diarização ───────────────────────────────────────────────────

export interface SpeakerSegment {
  speaker: string;
  text: string;
  index: number;
}

// ─── Resumo ───────────────────────────────────────────────────────────────────

export interface MeetingSummary {
  summary: string;
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
  /** Tags associadas à reunião (IDs) */
  tags?: string[];
}

// ─── Configurações ────────────────────────────────────────────────────────────

export interface AppSettings {
  openai_api_key: string;
  transcription_language: string;
  summary_model: string;
  chunk_duration_secs: number;
  /** Provider de transcrição: "openai", "groq", "google_cloud", "local" */
  transcription_provider: string;
  /** API key do Groq */
  groq_api_key: string;
  /** API key do OpenRouter (resumos com qualquer modelo) */
  openrouter_api_key: string;
  /** Provider de resumos: "openai" | "openrouter" */
  summary_provider: string;
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
  /** Atalho global para mutar/desmutar mic (ex: "ctrl+shift+m") */
  mute_mic_hotkey: string;
  /** Atalho global para pausar/retomar transcrição (ex: "ctrl+shift+p") */
  pause_hotkey: string;
  /** Feature 15: gerar resumo automaticamente ao parar */
  auto_summary: boolean;
  /** Download de modelo Whisper: diretório dos modelos */
  local_models_dir: string;
  /** Microfone selecionado (ID WASAPI). Vazio = padrão do sistema */
  selected_microphone: string;
  /** AGC: normalização automática de volume do mic */
  mic_auto_gain: boolean;
  /** Fator de ganho máximo do mic quando AGC ativo (ex: 4.0) */
  mic_gain_max: number;
  /** Threshold de silêncio separado para o microfone */
  mic_silence_threshold: number;
  /** Duração do chunk de áudio do microfone (segundos) */
  mic_chunk_duration_secs: number;
  /** AGC: normalização automática de volume do áudio do sistema (loopback) */
  system_auto_gain: boolean;
  /** Fator de ganho máximo do sistema quando AGC ativo (ex: 3.0) */
  system_gain_max: number;
  /** Prompt de contexto para o Whisper (melhora transcrição) */
  whisper_prompt: string;
  /** Tema da interface: "dark", "light" ou "system" */
  theme: 'dark' | 'light' | 'system';
  // ─── Integração JGRC ──────────────────────────────────────────────────────
  jgrc_url: string;
  jgrc_token: string;
  jgrc_event_type_id: string;
  jgrc_responsible_id: string;
  /** Cookie de sessão do JGRC capturado via WebView */
  jgrc_session_cookie: string;
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
  mic_muted: boolean;
  is_paused: boolean;
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
