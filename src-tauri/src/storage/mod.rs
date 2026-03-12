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

    /// Feature 1: amostras com RMS abaixo deste valor são descartadas (não vão ao Whisper)
    pub silence_threshold: f32,

    /// Feature 5: captura microfone junto com o áudio do sistema.
    /// Default true: sem o mic ativo, a voz do próprio usuário não é capturada
    /// (WASAPI loopback só capta o que sai nos alto-falantes).
    #[serde(default = "default_capture_mic")]
    pub capture_microphone: bool,

    /// Feature 7: usa whisper.cpp local em vez da API OpenAI
    pub use_local_whisper: bool,
    pub local_whisper_exe: String,   // caminho para whisper-cli.exe
    pub local_whisper_model: String, // ex: "base", "small", ou path do ggml

    /// Feature 8: tipo de reunião padrão
    pub default_meeting_type: MeetingType,

    /// Feature 13: atalho global para iniciar/parar gravação (ex: "ctrl+shift+r")
    #[serde(default = "default_hotkey")]
    pub global_hotkey: String,

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

fn default_capture_mic() -> bool {
    true
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
            silence_threshold: 0.005,
            capture_microphone: true,
            use_local_whisper: false,
            local_whisper_exe: String::new(),
            local_whisper_model: "base".to_string(),
            default_meeting_type: MeetingType::General,
            global_hotkey: "ctrl+shift+r".to_string(),
            auto_summary: false,
            local_models_dir: String::new(),
            selected_microphone: String::new(),
            theme: "dark".to_string(),
            jgrc_url: String::new(),
            jgrc_email: String::new(),
            jgrc_password: String::new(),
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
    // Se o JSON estiver desatualizado (campos novos faltando), usa defaults
    serde_json::from_str(&json)
        .context("Falha ao parsear configurações")
        .or_else(|_| Ok(AppSettings::with_defaults()))
}

pub fn save_settings(settings: &AppSettings) -> Result<()> {
    let path = settings_file_path()?;
    let json = serde_json::to_string_pretty(settings)
        .context("Falha ao serializar configurações")?;
    fs::write(&path, json).context("Falha ao salvar configurações")?;
    log::info!("Configurações salvas");
    Ok(())
}
