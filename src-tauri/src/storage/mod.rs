/// storage/mod.rs
/// Persistência local de reuniões e configurações em arquivos JSON.
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

use crate::ai::{MeetingSummary, SpeakerSegment};

// ─── MeetingType (Feature 8) ──────────────────────────────────────────────────

/// Tipo de reunião — determina o template de IA usado na geração do resumo.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum MeetingType {
    #[default]
    General,
    Standup,
    OneOnOne,
    Retrospective,
    Commercial,
    Interview,
}

impl MeetingType {
    pub fn label(&self) -> &'static str {
        match self {
            Self::General      => "Reunião Geral",
            Self::Standup      => "Daily Standup",
            Self::OneOnOne     => "1:1",
            Self::Retrospective => "Retrospectiva",
            Self::Commercial   => "Comercial",
            Self::Interview    => "Entrevista",
        }
    }

    pub fn icon(&self) -> &'static str {
        match self {
            Self::General      => "🏢",
            Self::Standup      => "⚡",
            Self::OneOnOne     => "👥",
            Self::Retrospective => "🔄",
            Self::Commercial   => "💼",
            Self::Interview    => "🎯",
        }
    }
}

// ─── Meeting ──────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Meeting {
    pub id: String,
    pub title: String,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub duration_secs: u64,
    pub transcript: String,
    pub summary: Option<MeetingSummary>,
    /// Feature 8: tipo de reunião para template de IA
    pub meeting_type: Option<MeetingType>,
    /// Feature 10: segmentos de fala identificados pela IA
    pub speakers: Option<Vec<SpeakerSegment>>,
    /// ID do evento no JGRC após exportação (None = ainda não exportado)
    #[serde(default)]
    pub jgrc_event_id: Option<String>,
}

impl Meeting {
    pub fn new() -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            title: format!("Reunião {}", chrono::Local::now().format("%d/%m/%Y %H:%M")),
            started_at: Utc::now(),
            ended_at: None,
            duration_secs: 0,
            transcript: String::new(),
            summary: None,
            meeting_type: None,
            speakers: None,
            jgrc_event_id: None,
        }
    }
}

impl Default for Meeting {
    fn default() -> Self {
        Self::new()
    }
}

// ─── AppSettings ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppSettings {
    pub openai_api_key: String,
    pub transcription_language: String,
    pub summary_model: String,
    pub chunk_duration_secs: f32,

    /// Provider de transcrição: "openai", "groq", "google_cloud", "local"
    #[serde(default = "default_transcription_provider")]
    pub transcription_provider: String,

    /// API key do Groq (para whisper-large-v3-turbo)
    #[serde(default)]
    pub groq_api_key: String,

    /// API key do Google Cloud (legado — mantido apenas para não quebrar settings.json existente)
    #[serde(default)]
    pub google_cloud_api_key: String,

    /// API key do OpenRouter (para geração de resumos com qualquer modelo)
    #[serde(default)]
    pub openrouter_api_key: String,

    /// Provider usado para geração de resumos: "openai" | "openrouter"
    #[serde(default = "default_summary_provider")]
    pub summary_provider: String,

    /// Feature 1: amostras com RMS abaixo deste valor são descartadas (não vão ao Whisper)
    pub silence_threshold: f32,

    /// Feature 5: captura microfone junto com o áudio do sistema.
    /// Default true: sem o mic ativo, a voz do próprio usuário não é capturada
    /// (WASAPI loopback só capta o que sai nos alto-falantes).
    #[serde(default = "default_capture_mic")]
    pub capture_microphone: bool,

    /// Feature 7: usa whisper.cpp local em vez da API OpenAI (legado — usar transcription_provider="local")
    pub use_local_whisper: bool,
    pub local_whisper_exe: String,   // caminho para whisper-cli.exe
    pub local_whisper_model: String, // ex: "base", "small", ou path do ggml

    /// Feature 8: tipo de reunião padrão
    pub default_meeting_type: MeetingType,

    /// Feature 13: atalho global para iniciar/parar gravação (ex: "ctrl+shift+r")
    #[serde(default = "default_hotkey")]
    pub global_hotkey: String,

    /// Atalho global para mutar/desmutar microfone (ex: "ctrl+shift+m")
    #[serde(default = "default_mute_hotkey")]
    pub mute_mic_hotkey: String,

    /// Atalho global para pausar/retomar transcrição (ex: "ctrl+shift+p")
    #[serde(default = "default_pause_hotkey")]
    pub pause_hotkey: String,

    /// Feature 15: gerar resumo automaticamente ao parar a gravação
    #[serde(default)]
    pub auto_summary: bool,

    /// Download de modelo Whisper: diretório onde os modelos ggml são salvos
    #[serde(default)]
    pub local_models_dir: String,

    /// Microfone selecionado pelo usuário (ID WASAPI).
    /// String vazia = microfone padrão do sistema.
    #[serde(default)]
    pub selected_microphone: String,

    /// Ganho automático (AGC) do microfone: normaliza o volume para melhorar transcrição.
    /// Default true — microfones geralmente têm volume mais baixo que loopback do sistema.
    #[serde(default = "default_true")]
    pub mic_auto_gain: bool,

    /// Fator de ganho máximo aplicado ao microfone quando AGC está ativo.
    /// Valores típicos: 2.0–8.0. Default 4.0 = amplifica até 4x o volume original.
    #[serde(default = "default_mic_gain")]
    pub mic_gain_max: f32,

    /// Threshold de silêncio separado para o microfone.
    /// Default 0.003 — mais sensível que o padrão do sistema (0.005) porque
    /// microfones tipicamente captam sinal mais fraco.
    #[serde(default = "default_mic_silence_threshold")]
    pub mic_silence_threshold: f32,

    /// Duração do chunk de áudio do microfone (em segundos).
    /// Default 5.0 — menor que o sistema (10s) para chunks mais limpos e
    /// menos ruído por envio ao Whisper.
    #[serde(default = "default_mic_chunk_duration")]
    pub mic_chunk_duration_secs: f32,

    /// Ganho automático (AGC) para o áudio do sistema (loopback).
    /// Default true — áudio do Teams/Zoom via loopback pode ser muito baixo dependendo
    /// do volume do Windows, causando chunks descartados como silenciosos.
    #[serde(default = "default_true")]
    pub system_auto_gain: bool,

    /// Fator de ganho máximo para o áudio do sistema quando AGC está ativo.
    /// Default 3.0 — menor que mic (4.0) pois loopback geralmente é menos distorcido.
    #[serde(default = "default_system_gain")]
    pub system_gain_max: f32,

    /// Prompt de contexto enviado ao Whisper para melhorar a transcrição.
    /// Ex: "Reunião de investimentos na JGP, gestora de fundos."
    #[serde(default)]
    pub whisper_prompt: String,

    // ─── Integração JGRC ──────────────────────────────────────────────────────
    /// URL base do JGRC (ex: "http://localhost:3000")
    #[serde(default)]
    pub jgrc_url: String,
    /// E-mail para login no JGRC
    #[serde(default)]
    pub jgrc_email: String,
    /// Senha para login no JGRC
    #[serde(default)]
    pub jgrc_password: String,

    /// Tema da interface: "dark", "light" ou "system"
    #[serde(default = "default_theme")]
    pub theme: String,

    /// Cookie de sessão do JGRC capturado via WebView login
    #[serde(default)]
    pub jgrc_session_cookie: String,

    // Campos legados — mantidos com serde(default) para não quebrar settings.json existente
    #[serde(default)]
    pub jgrc_token: String,
    #[serde(default)]
    pub jgrc_event_type_id: String,
    #[serde(default)]
    pub jgrc_responsible_id: String,
}

fn default_hotkey() -> String {
    "ctrl+shift+r".to_string()
}

fn default_mute_hotkey() -> String {
    "ctrl+shift+m".to_string()
}

fn default_pause_hotkey() -> String {
    "ctrl+shift+p".to_string()
}

fn default_transcription_provider() -> String {
    "openai".to_string()
}

fn default_summary_provider() -> String {
    "openai".to_string()
}

fn default_capture_mic() -> bool {
    true
}

fn default_true() -> bool {
    true
}

fn default_mic_gain() -> f32 {
    4.0
}

fn default_system_gain() -> f32 {
    3.0
}

fn default_mic_silence_threshold() -> f32 {
    0.003
}

fn default_mic_chunk_duration() -> f32 {
    5.0
}

fn default_theme() -> String {
    "dark".to_string()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self::with_defaults()
    }
}

impl AppSettings {
    pub fn with_defaults() -> Self {
        Self {
            openai_api_key: String::new(),
            transcription_language: "pt".to_string(),
            summary_model: "gpt-4o-mini".to_string(),
            chunk_duration_secs: 10.0,
            transcription_provider: "openai".to_string(),
            groq_api_key: String::new(),
            google_cloud_api_key: String::new(),
            openrouter_api_key: String::new(),
            summary_provider: "openai".to_string(),
            silence_threshold: 0.002,
            capture_microphone: true,
            use_local_whisper: false,
            local_whisper_exe: String::new(),
            local_whisper_model: "base".to_string(),
            default_meeting_type: MeetingType::General,
            global_hotkey: "ctrl+shift+r".to_string(),
            mute_mic_hotkey: "ctrl+shift+m".to_string(),
            pause_hotkey: "ctrl+shift+p".to_string(),
            auto_summary: false,
            local_models_dir: String::new(),
            selected_microphone: String::new(),
            mic_auto_gain: true,
            mic_gain_max: 4.0,
            mic_silence_threshold: 0.003,
            mic_chunk_duration_secs: 5.0,
            system_auto_gain: true,
            system_gain_max: 3.0,
            whisper_prompt: "JGP, gestora, fundo, renda fixa, ações, multimercado, \
                FII, NTN-B, IPCA, CDI, benchmark, drawdown, volatilidade, cotista, \
                mandato, alocação, hedge, debêntures, cupom, duration, spread, \
                yield, carry, valuation, follow-on, IPO, CVM, B3".to_string(),
            theme: "dark".to_string(),
            jgrc_url: String::new(),
            jgrc_email: String::new(),
            jgrc_password: String::new(),
            jgrc_session_cookie: String::new(),
            jgrc_token: String::new(),
            jgrc_event_type_id: String::new(),
            jgrc_responsible_id: String::new(),
        }
    }
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

pub fn app_data_dir() -> Result<PathBuf> {
    let base = dirs::data_dir()
        .context("Não foi possível determinar o diretório de dados do usuário")?;
    let app_dir = base.join("jgp-meeting");
    fs::create_dir_all(&app_dir).context("Falha ao criar diretório de dados")?;
    Ok(app_dir)
}

/// Retorna (e cria) o diretório onde os modelos Whisper ggml são baixados.
pub fn models_dir() -> Result<PathBuf> {
    let dir = app_data_dir()?.join("models");
    fs::create_dir_all(&dir).context("Falha ao criar diretório de modelos")?;
    Ok(dir)
}

fn meeting_file_path(id: &str) -> Result<PathBuf> {
    let dir = app_data_dir()?.join("meetings");
    fs::create_dir_all(&dir).context("Falha ao criar diretório de reuniões")?;
    Ok(dir.join(format!("{id}.json")))
}

fn settings_file_path() -> Result<PathBuf> {
    Ok(app_data_dir()?.join("settings.json"))
}

// ─── Reuniões ─────────────────────────────────────────────────────────────────

pub fn save_meeting(meeting: &Meeting) -> Result<()> {
    let path = meeting_file_path(&meeting.id)?;
    let json = serde_json::to_string_pretty(meeting)
        .context("Falha ao serializar reunião")?;
    fs::write(&path, &json)
        .context(format!("Falha ao gravar {}", path.display()))?;
    log::info!("Reunião {} salva em {}", meeting.id, path.display());
    Ok(())
}

pub fn load_meeting(id: &str) -> Result<Meeting> {
    let path = meeting_file_path(id)?;
    let json = fs::read_to_string(&path)
        .context(format!("Arquivo de reunião não encontrado: {}", path.display()))?;
    serde_json::from_str(&json).context("Falha ao deserializar reunião")
}

pub fn list_meetings() -> Result<Vec<Meeting>> {
    let dir = app_data_dir()?.join("meetings");
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut meetings: Vec<Meeting> = fs::read_dir(&dir)
        .context("Falha ao ler diretório de reuniões")?
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            if path.extension()?.to_str()? == "json" {
                let json = fs::read_to_string(&path).ok()?;
                serde_json::from_str::<Meeting>(&json).ok()
            } else {
                None
            }
        })
        .collect();

    meetings.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(meetings)
}

pub fn delete_meeting(id: &str) -> Result<()> {
    let path = meeting_file_path(id)?;
    if path.exists() {
        fs::remove_file(&path)
            .context(format!("Falha ao remover {}", path.display()))?;
        log::info!("Reunião {id} removida");
    }
    Ok(())
}

// ─── Configurações ────────────────────────────────────────────────────────────

pub fn load_settings() -> Result<AppSettings> {
    let path = settings_file_path()?;
    if !path.exists() {
        return Ok(AppSettings::with_defaults());
    }
    let json = fs::read_to_string(&path).context("Falha ao ler configurações")?;
    let mut settings: AppSettings = serde_json::from_str(&json)
        .context("Falha ao parsear configurações")
        .or_else(|_| Ok::<AppSettings, anyhow::Error>(AppSettings::with_defaults()))?;

    // Decrypt sensitive fields. On failure (e.g. old plain-text settings),
    // reset field to empty string so the user can re-enter the key.
    settings.openai_api_key =
        crate::crypto::decrypt_string(&settings.openai_api_key).unwrap_or_else(|e| {
            log::warn!("openai_api_key decrypt failed (resetting to empty): {e}");
            String::new()
        });
    settings.groq_api_key =
        crate::crypto::decrypt_string(&settings.groq_api_key).unwrap_or_else(|e| {
            log::warn!("groq_api_key decrypt failed (resetting to empty): {e}");
            String::new()
        });
    settings.openrouter_api_key =
        crate::crypto::decrypt_string(&settings.openrouter_api_key).unwrap_or_else(|e| {
            log::warn!("openrouter_api_key decrypt failed (resetting to empty): {e}");
            String::new()
        });
    settings.google_cloud_api_key =
        crate::crypto::decrypt_string(&settings.google_cloud_api_key).unwrap_or_else(|e| {
            log::warn!("google_cloud_api_key decrypt failed (resetting to empty): {e}");
            String::new()
        });
    settings.jgrc_session_cookie =
        crate::crypto::decrypt_string(&settings.jgrc_session_cookie).unwrap_or_else(|e| {
            log::warn!("jgrc_session_cookie decrypt failed (resetting to empty): {e}");
            String::new()
        });

    Ok(settings)
}

pub fn save_settings(settings: &AppSettings) -> Result<()> {
    let path = settings_file_path()?;

    // Clone and encrypt sensitive fields before serializing to disk.
    // If any encryption fails, abort — never write a partially-protected file.
    let mut storable = settings.clone();
    storable.openai_api_key = crate::crypto::encrypt_string(&settings.openai_api_key)
        .map_err(|e| anyhow::anyhow!("Falha ao encriptar openai_api_key: {e}"))?;
    storable.groq_api_key = crate::crypto::encrypt_string(&settings.groq_api_key)
        .map_err(|e| anyhow::anyhow!("Falha ao encriptar groq_api_key: {e}"))?;
    storable.openrouter_api_key = crate::crypto::encrypt_string(&settings.openrouter_api_key)
        .map_err(|e| anyhow::anyhow!("Falha ao encriptar openrouter_api_key: {e}"))?;
    storable.google_cloud_api_key = crate::crypto::encrypt_string(&settings.google_cloud_api_key)
        .map_err(|e| anyhow::anyhow!("Falha ao encriptar google_cloud_api_key: {e}"))?;
    storable.jgrc_session_cookie = crate::crypto::encrypt_string(&settings.jgrc_session_cookie)
        .map_err(|e| anyhow::anyhow!("Falha ao encriptar jgrc_session_cookie: {e}"))?;

    let json = serde_json::to_string_pretty(&storable)
        .context("Falha ao serializar configurações")?;
    fs::write(&path, json).context("Falha ao salvar configurações")?;
    log::info!("Configurações salvas");
    Ok(())
}

#[cfg(test)]
#[cfg(windows)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};
    static SETTINGS_FILE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    fn settings_test_lock() -> &'static Mutex<()> {
        SETTINGS_FILE_LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn test_save_load_roundtrip_encrypts_sensitive_fields() {
        let _guard = settings_test_lock().lock().unwrap();
        // Save settings with a known API key
        let mut settings = AppSettings::with_defaults();
        settings.openai_api_key = "sk-roundtrip-test-key".to_string();
        settings.groq_api_key = "gsk-roundtrip-groq".to_string();

        save_settings(&settings).expect("save should succeed");

        // The raw JSON on disk must NOT contain the plain-text key
        let path = settings_file_path().unwrap();
        let raw_json = std::fs::read_to_string(&path).unwrap();
        assert!(
            !raw_json.contains("sk-roundtrip-test-key"),
            "plain openai_api_key must not appear in settings.json"
        );
        assert!(
            !raw_json.contains("gsk-roundtrip-groq"),
            "plain groq_api_key must not appear in settings.json"
        );

        // load_settings must decrypt back to the original values
        let loaded = load_settings().expect("load should succeed");
        assert_eq!(loaded.openai_api_key, "sk-roundtrip-test-key");
        assert_eq!(loaded.groq_api_key, "gsk-roundtrip-groq");

        // Clean up: restore empty settings
        let _ = save_settings(&AppSettings::with_defaults());
    }

    #[test]
    fn test_plaintext_keys_in_old_settings_return_empty_on_load() {
        let _guard = settings_test_lock().lock().unwrap();
        // Simulate a pre-encryption settings.json by writing plain-text JSON directly
        let path = settings_file_path().unwrap();
        let old = AppSettings::with_defaults();
        // Get a clean base JSON then patch in a plain-text key before writing
        let mut json_value: serde_json::Value =
            serde_json::to_value(&old).unwrap();
        json_value["openai_api_key"] = serde_json::json!("sk-old-plain-text-key");
        std::fs::write(&path, serde_json::to_string_pretty(&json_value).unwrap()).unwrap();

        let loaded = load_settings().expect("load should not fail");
        assert_eq!(
            loaded.openai_api_key, "",
            "old plain-text key must be reset to empty string"
        );

        // Clean up
        let _ = save_settings(&AppSettings::with_defaults());
    }
}
