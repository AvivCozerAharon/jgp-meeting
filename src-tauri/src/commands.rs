/// commands.rs
/// Comandos Tauri expostos ao frontend React via invoke().
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::ai::{self, MeetingSummary, SpeakerSegment};
use crate::audio::{self, AudioCaptureState, AudioChunk, AudioSource};
use crate::detection;
use crate::export;
use crate::storage::{self, AppSettings, Meeting, MeetingType};
use crate::transcription;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Retorna (api_key, endpoint) para geração de resumos com base nas configurações.
fn summary_credentials(settings: &storage::AppSettings) -> (String, &'static str) {
    if settings.summary_provider == "openrouter" {
        (settings.openrouter_api_key.clone(), ai::OPENROUTER_ENDPOINT)
    } else {
        (settings.openai_api_key.clone(), ai::OPENAI_ENDPOINT)
    }
}

// ─── Estado Global ────────────────────────────────────────────────────────────

pub struct AppState {
    pub capture_state: Arc<AudioCaptureState>,
    pub transcript: Mutex<String>,
    pub current_meeting: Mutex<Option<Meeting>>,
    pub capture_start: Mutex<Option<Instant>>,
    pub stop_tx: Mutex<Option<mpsc::Sender<()>>>,
    /// ID da reunião sendo drenada (worker processando chunks pendentes após stop).
    /// Usado para re-salvar a reunião com a transcrição completa após draining.
    pub draining_meeting_id: Mutex<Option<String>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            capture_state: Arc::new(AudioCaptureState::new()),
            transcript: Mutex::new(String::new()),
            current_meeting: Mutex::new(None),
            capture_start: Mutex::new(None),
            stop_tx: Mutex::new(None),
            draining_meeting_id: Mutex::new(None),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

// ─── DTOs ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CaptureStatus {
    pub is_capturing: bool,
    pub audio_level: f32,
    pub mic_level: f32,
    pub mic_muted: bool,
    pub is_paused: bool,
    pub transcript_length: usize,
    pub duration_secs: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MeetingResult {
    pub id: String,
    pub title: String,
    pub transcript: String,
    pub summary: Option<MeetingSummary>,
}

// ─── Comandos: Captura de Áudio ───────────────────────────────────────────────

/// Inicia a captura de áudio + pipeline de transcrição.
/// Feature 1: usa silence_threshold das configurações.
/// Feature 5: captura microfone em pipeline separada se capture_microphone=true.
/// Feature 7: usa Whisper local se use_local_whisper=true.
/// Feature 8: aplica template do tipo de reunião no resumo.
#[tauri::command]
pub async fn start_capture(
    app: AppHandle,
    state: State<'_, AppState>,
    meeting_type: Option<MeetingType>,
) -> Result<(), String> {
    if state.capture_state.is_capturing() {
        return Err("Captura já está em andamento".to_string());
    }

    let settings = storage::load_settings()
        .map_err(|e| format!("Erro ao carregar configurações: {e}"))?;

    // Determina o provider de transcrição.
    // O campo transcription_provider tem precedência; use_local_whisper só entra
    // quando o provider não é "openai" nem "groq" (compatibilidade com configs antigas).
    let provider = if settings.transcription_provider == "local"
        || (settings.transcription_provider != "openai"
            && settings.transcription_provider != "groq"
            && settings.use_local_whisper
            && !settings.local_whisper_exe.is_empty())
    {
        "local"
    } else {
        settings.transcription_provider.as_str()
    };

    // Valida API key do provider selecionado
    match provider {
        "openai" if settings.openai_api_key.is_empty() => {
            return Err("Chave da API OpenAI não configurada.".to_string());
        }
        "groq" if settings.groq_api_key.is_empty() => {
            return Err("Chave da API Groq não configurada.".to_string());
        }
        "local" if settings.local_whisper_exe.is_empty() => {
            return Err("Executável whisper-cli não configurado.".to_string());
        }
        _ => {}
    }

    let use_local = provider == "local";

    // Inicializa reunião com o tipo selecionado
    let mut meeting = Meeting::new();
    meeting.meeting_type = meeting_type.or(Some(settings.default_meeting_type.clone()));

    *state.current_meeting.lock().unwrap() = Some(meeting);
    *state.transcript.lock().unwrap() = String::new();
    *state.capture_start.lock().unwrap() = Some(Instant::now());

    state
        .capture_state
        .is_capturing
        .store(true, std::sync::atomic::Ordering::SeqCst);
    // Reseta mic muted e paused para nova sessão
    state.capture_state.set_mic_muted(false);
    state.capture_state.set_paused(false);

    let (chunk_tx, chunk_rx) = mpsc::channel::<AudioChunk>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    *state.stop_tx.lock().unwrap() = Some(stop_tx);

    // Inicia captura de áudio (Feature 1: threshold, Feature 5: mic com config separado)
    let capture_arc        = Arc::clone(&state.capture_state);
    let capture_arc_worker = Arc::clone(&state.capture_state);
    let system_config = audio::SystemConfig {
        chunk_duration_secs: settings.chunk_duration_secs,
        silence_threshold: settings.silence_threshold,
        auto_gain: settings.system_auto_gain,
        gain_max: settings.system_gain_max,
    };
    let mic_config = audio::MicConfig {
        enabled: settings.capture_microphone,
        device_id: settings.selected_microphone.clone(),
        chunk_duration_secs: settings.mic_chunk_duration_secs,
        silence_threshold: settings.mic_silence_threshold,
        auto_gain: settings.mic_auto_gain,
        gain_max: settings.mic_gain_max,
    };
    audio::start_capture(
        capture_arc,
        chunk_tx,
        system_config,
        mic_config,
    )
    .map_err(|e| format!("Erro ao iniciar captura: {e}"))?;

    // Clona dados necessários para o worker
    let provider_str     = provider.to_string();
    let api_key          = settings.openai_api_key.clone();
    let groq_key         = settings.groq_api_key.clone();
    let language         = settings.transcription_language.clone();
    let whisper_exe      = settings.local_whisper_exe.clone();
    let whisper_model    = settings.local_whisper_model.clone();
    let whisper_prompt   = settings.whisper_prompt.clone();
    let app_clone        = app.clone();

    // Worker de transcrição
    // Ao receber sinal de stop, NÃO para imediatamente: drena todos os chunks
    // pendentes na fila para não perder áudio (especialmente importante com Whisper local).
    //
    // Fluxo de draining:
    //   1. Worker recebe stop signal (stop_rx) ou canal desconecta (chunk_tx dropped)
    //   2. Aguarda canal desconectar (= thread de áudio terminou e fez flush final)
    //   3. Coleta TODOS os chunks restantes no canal
    //   4. Processa sequencialmente com indicador de progresso
    //   5. Re-salva a reunião com a transcrição completa
    tokio::spawn(async move {
        log::info!("Worker de transcrição iniciado (provider={})", provider_str);

        /// Helper: transcreve um chunk e acumula no transcript global.
        /// Retorna true se obteve texto não-vazio.
        #[allow(clippy::too_many_arguments)]
        async fn process_chunk(
            chunk: AudioChunk,
            provider: &str,
            whisper_exe: &str,
            whisper_model: &str,
            language: &str,
            api_key: &str,
            groq_key: &str,
            whisper_prompt: &str,
            app: &AppHandle,
        ) -> bool {
            let _ = app.emit("transcription-processing", true);

            // Local precisa de WAV mono 16kHz; OpenAI/Groq aceitam qualquer formato
            let needs_whisper_format = provider == "local";

            let wav_bytes = if needs_whisper_format {
                match chunk.to_wav_bytes_whisper() {
                    Ok(b) => b,
                    Err(e) => {
                        log::error!("Erro ao converter WAV: {e}");
                        let _ = app.emit("transcription-processing", false);
                        return false;
                    }
                }
            } else {
                match chunk.to_wav_bytes() {
                    Ok(b) => b,
                    Err(e) => {
                        log::error!("Erro ao codificar WAV: {e}");
                        let _ = app.emit("transcription-processing", false);
                        return false;
                    }
                }
            };

            let prompt_opt = if whisper_prompt.is_empty() { None } else { Some(whisper_prompt) };

            let result = match provider {
                "groq" => {
                    transcription::transcribe_groq(wav_bytes, groq_key, Some(language), prompt_opt).await
                }
                "local" => {
                    transcription::transcribe_local(wav_bytes, whisper_exe, whisper_model, language).await
                }
                _ => {
                    // "openai" ou qualquer outro → OpenAI Whisper
                    transcription::transcribe_audio(wav_bytes, api_key, Some(language), prompt_opt).await
                }
            };

            let got_text = match result {
                Ok(text) if !text.is_empty() => {
                    let app_state = app.state::<AppState>();
                    let mut transcript = app_state.transcript.lock().unwrap();
                    if !transcript.is_empty() {
                        transcript.push(' ');
                    }
                    // Prefixa com a fonte do áudio (deduplica se igual ao último)
                    let prefix = match chunk.source {
                        AudioSource::System => "[Reunião]",
                        AudioSource::Microphone => "[Você]",
                    };

                    let last_tag = {
                        let pos_reuniao = transcript.rfind("[Reunião]");
                        let pos_voce = transcript.rfind("[Você]");
                        match (pos_reuniao, pos_voce) {
                            (Some(r), Some(v)) => {
                                if r > v { Some("[Reunião]") } else { Some("[Você]") }
                            }
                            (Some(_), None) => Some("[Reunião]"),
                            (None, Some(_)) => Some("[Você]"),
                            (None, None) => None,
                        }
                    };

                    if last_tag != Some(prefix) {
                        transcript.push_str(prefix);
                    }
                    transcript.push(' ');
                    transcript.push_str(&crate::text_processing::normalize_numbers(&text));
                    let full = transcript.clone();
                    drop(transcript);
                    let _ = app.emit("transcription-update", full);
                    true
                }
                Ok(_) => {
                    log::debug!("Chunk transcrito como vazio (source={:?})", chunk.source);
                    false
                }
                Err(e) => {
                    log::error!("Erro na transcrição: {e}");
                    let _ = app.emit("transcription-error", e.to_string());
                    false
                }
            };

            let _ = app.emit("transcription-processing", false);
            got_text
        }

        // ── Fase 1: Processamento normal (durante gravação ativa) ────────
        // Processa chunks conforme chegam, checando stop signal a cada iteração.
        loop {
            // Verifica sinal de stop (sem bloquear)
            if stop_rx.try_recv().is_ok() {
                log::info!("Sinal de stop recebido — aguardando thread de áudio finalizar...");
                break;
            }

            match chunk_rx.recv_timeout(std::time::Duration::from_millis(200)) {
                Ok(chunk) => {
                    // Descarta chunk sem transcrever quando pausado
                    if capture_arc_worker.is_paused() {
                        continue;
                    }
                    process_chunk(
                        chunk, &provider_str,
                        &whisper_exe, &whisper_model, &language, &api_key,
                        &groq_key,
                        &whisper_prompt, &app_clone,
                    ).await;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    // Canal fechou (thread de áudio terminou) — pular direto ao drain
                    log::info!("Canal desconectado — thread de áudio já finalizou");
                    break;
                }
            }
        }

        // ── Fase 2: Esperar thread de áudio terminar (flush do buffer final) ─
        // A thread de áudio precisa de tempo para fazer o flush do pcm_buffer
        // restante. Aguardamos o canal desconectar (chunk_tx dropped = thread saiu).
        // Usamos recv_timeout com limite para não travar infinitamente.
        let mut pre_drain: Vec<AudioChunk> = Vec::new();
        loop {
            match chunk_rx.recv_timeout(std::time::Duration::from_secs(5)) {
                Ok(chunk) => {
                    // Chunk recebido enquanto esperava a thread de áudio encerrar
                    pre_drain.push(chunk);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    log::warn!("Timeout esperando thread de áudio — possível travamento");
                    break;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    // Thread de áudio encerrou — canal fechado. Drena resíduos.
                    while let Ok(c) = chunk_rx.try_recv() {
                        pre_drain.push(c);
                    }
                    log::info!("Thread de áudio finalizada — {} chunks coletados no drain", pre_drain.len());
                    break;
                }
            }
        }

        // ── Fase 3: Processar chunks pendentes (draining) ────────────────
        if !pre_drain.is_empty() {
            let total = pre_drain.len();
            let _ = app_clone.emit("transcription-draining", serde_json::json!({
                "pending": total,
                "total": total
            }));
            log::info!("Draining: processando {} chunks pendentes...", total);

            for (i, drain_chunk) in pre_drain.into_iter().enumerate() {
                process_chunk(
                    drain_chunk, &provider_str,
                    &whisper_exe, &whisper_model, &language, &api_key,
                    &groq_key,
                    &whisper_prompt, &app_clone,
                ).await;

                let remaining = total - (i + 1);
                let _ = app_clone.emit("transcription-draining", serde_json::json!({
                    "pending": remaining,
                    "total": total
                }));
                log::info!("Drain: {}/{} processados", i + 1, total);
            }
        }

        // ── Fase 4: Finalização ──────────────────────────────────────────
        // Sinaliza que o draining terminou
        let _ = app_clone.emit("transcription-draining", serde_json::json!({
            "pending": 0,
            "total": 0
        }));

        // Re-salva a reunião com a transcrição completa (incluindo chunks drenados)
        let app_state = app_clone.state::<AppState>();
        if let Some(meeting_id) = app_state.draining_meeting_id.lock().unwrap().take() {
            let final_transcript = app_state.transcript.lock().unwrap().clone();
            if let Ok(mut meeting) = storage::load_meeting(&meeting_id) {
                if meeting.transcript.len() < final_transcript.len() {
                    meeting.transcript = final_transcript;
                    if let Err(e) = storage::save_meeting(&meeting) {
                        log::error!("Erro ao re-salvar reunião após draining: {e}");
                    } else {
                        log::info!("Reunião {meeting_id} atualizada com transcrição completa ({} chars)",
                            meeting.transcript.len());
                        // Notifica o frontend que a reunião foi atualizada com transcript completo.
                        // Isso permite que o HistoryPage recarregue os dados se estiver aberto.
                        let _ = app_clone.emit("meeting-updated", serde_json::json!({
                            "meeting_id": meeting_id,
                            "transcript_length": meeting.transcript.len()
                        }));
                    }
                }
            }
        }

        log::info!("Worker de transcrição encerrado");
    });

    // Task de nível de áudio periódico
    let app_level = app.clone();
    let cap_level = Arc::clone(&state.capture_state);
    tokio::spawn(async move {
        while cap_level.is_capturing() {
            let level = *cap_level.current_level.lock().unwrap();
            let mic   = *cap_level.mic_level.lock().unwrap();
            let _ = app_level.emit("audio-level", level);
            let _ = app_level.emit("mic-level", mic);
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    });

    log::info!("Captura iniciada");
    Ok(())
}

/// Para a captura e salva a reunião. Retorna o ID da reunião.
/// Feature 15: se auto_summary=true nas configurações, dispara geração de resumo em background.
#[tauri::command]
pub async fn stop_capture(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if !state.capture_state.is_capturing() {
        return Err("Nenhuma captura em andamento".to_string());
    }

    state
        .capture_state
        .is_capturing
        .store(false, std::sync::atomic::Ordering::SeqCst);

    if let Some(tx) = state.stop_tx.lock().unwrap().take() {
        let _ = tx.send(());
    }

    let mut meeting = state
        .current_meeting
        .lock()
        .unwrap()
        .take()
        .unwrap_or_default();

    meeting.transcript = state.transcript.lock().unwrap().clone();
    meeting.ended_at = Some(chrono::Utc::now());
    meeting.duration_secs = state
        .capture_start
        .lock()
        .unwrap()
        .map(|s| s.elapsed().as_secs())
        .unwrap_or(0);

    if meeting.transcript.trim().is_empty() {
        return Err("Nenhuma fala foi capturada.".to_string());
    }

    let id = meeting.id.clone();
    storage::save_meeting(&meeting).map_err(|e| format!("Erro ao salvar reunião: {e}"))?;
    *state.capture_start.lock().unwrap() = None;

    // Armazena o ID da reunião para o worker re-salvar após draining
    *state.draining_meeting_id.lock().unwrap() = Some(id.clone());

    // Feature 15: auto-resumo em background
    let settings = storage::load_settings().unwrap_or_default();
    if settings.auto_summary && !meeting.transcript.trim().is_empty() {
        let (api_key, endpoint_str) = summary_credentials(&settings);
        if !api_key.is_empty() {
            let transcript     = meeting.transcript.clone();
            let model          = settings.summary_model.clone();
            let meeting_type   = meeting.meeting_type.clone().unwrap_or_default();
            let meeting_id     = id.clone();
            let app_auto       = app.clone();
            let endpoint_owned = endpoint_str.to_string();

            tokio::spawn(async move {
                log::info!("Auto-resumo iniciado para reunião {meeting_id}");
                let _ = app_auto.emit("auto-summary-loading", &meeting_id);

                match ai::generate_summary(&transcript, &api_key, &model, &meeting_type, &endpoint_owned).await {
                    Ok(summary) => {
                        if let Ok(mut m) = storage::load_meeting(&meeting_id) {
                            m.summary = Some(summary.clone());
                            let _ = storage::save_meeting(&m);
                        }
                        let _ = app_auto.emit(
                            "auto-summary-done",
                            serde_json::json!({ "meeting_id": meeting_id, "summary": summary }),
                        );
                    }
                    Err(e) => {
                        log::error!("Auto-resumo falhou: {e}");
                        let _ = app_auto.emit("auto-summary-error", e.to_string());
                    }
                }
            });
        }
    }

    log::info!("Reunião {id} salva");
    Ok(id)
}

#[tauri::command]
pub async fn get_capture_status(state: State<'_, AppState>) -> Result<CaptureStatus, String> {
    Ok(CaptureStatus {
        is_capturing: state.capture_state.is_capturing(),
        audio_level: *state.capture_state.current_level.lock().unwrap(),
        mic_level: *state.capture_state.mic_level.lock().unwrap(),
        mic_muted: state.capture_state.is_mic_muted(),
        is_paused: state.capture_state.is_paused(),
        transcript_length: state.transcript.lock().unwrap().len(),
        duration_secs: state
            .capture_start
            .lock()
            .unwrap()
            .map(|s| s.elapsed().as_secs())
            .unwrap_or(0),
    })
}

/// Muta ou desmuta o microfone durante a gravação.
/// Retorna o novo estado (true = mutado).
#[tauri::command]
pub async fn toggle_mic_mute(state: State<'_, AppState>) -> Result<bool, String> {
    let current = state.capture_state.is_mic_muted();
    let new_val = !current;
    state.capture_state.set_mic_muted(new_val);
    log::info!("Microfone {}", if new_val { "mutado" } else { "desmutado" });
    Ok(new_val)
}

/// Pausa a transcrição (áudio continua sendo capturado, chunks são descartados).
/// Retorna o novo estado (true = pausado).
#[tauri::command]
pub async fn toggle_pause_capture(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<bool, String> {
    let new_val = !state.capture_state.is_paused();
    state.capture_state.set_paused(new_val);
    log::info!("Captura {}", if new_val { "pausada" } else { "retomada" });
    let _ = app.emit("capture-paused", new_val);
    Ok(new_val)
}

/// Abre a janela flutuante de compliance (GRAVANDO badge + controles).
#[tauri::command]
pub async fn open_compliance_window(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("compliance") {
        let _ = existing.show();
        return Ok(());
    }

    let url = if cfg!(debug_assertions) {
        tauri::WebviewUrl::External("http://localhost:1420/#compliance".parse().unwrap())
    } else {
        tauri::WebviewUrl::App("index.html#compliance".into())
    };

    tauri::WebviewWindowBuilder::new(&app, "compliance", url)
        .title("JGP Meeting — Gravando")
        .inner_size(310.0, 72.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .position(20.0, 20.0)
        .build()
        .map_err(|e| format!("Erro ao abrir janela de compliance: {e}"))?;

    Ok(())
}

/// Fecha a janela flutuante de compliance.
#[tauri::command]
pub async fn close_compliance_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("compliance") {
        let _ = win.close();
    }
    Ok(())
}

#[tauri::command]
pub async fn get_current_transcript(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.transcript.lock().unwrap().clone())
}

// ─── Comandos: Resumo IA ──────────────────────────────────────────────────────

/// Gera um resumo usando o template do tipo de reunião (Feature 8).
#[tauri::command]
pub async fn generate_summary(
    transcript: String,
    api_key: String,
    model: Option<String>,
    meeting_type: Option<MeetingType>,
    base_url: Option<String>,
) -> Result<MeetingSummary, String> {
    if transcript.trim().is_empty() {
        return Err("Transcrição vazia".to_string());
    }
    let model = model.unwrap_or_else(|| ai::default_model().to_string());
    let mt = meeting_type.unwrap_or_default();
    let endpoint = base_url.as_deref().unwrap_or(ai::OPENAI_ENDPOINT);
    ai::generate_summary(&transcript, &api_key, &model, &mt, endpoint)
        .await
        .map_err(|e| format!("Erro ao gerar resumo: {e}"))
}

/// Gera e salva o resumo de uma reunião do histórico.
#[tauri::command]
pub async fn generate_and_save_summary(
    meeting_id: String,
    api_key: String,
    model: Option<String>,
    base_url: Option<String>,
) -> Result<MeetingSummary, String> {
    let mut meeting =
        storage::load_meeting(&meeting_id).map_err(|e| format!("Reunião não encontrada: {e}"))?;

    let model = model.unwrap_or_else(|| ai::default_model().to_string());
    let mt = meeting.meeting_type.clone().unwrap_or_default();
    let endpoint = base_url.as_deref().unwrap_or(ai::OPENAI_ENDPOINT);

    let summary = ai::generate_summary(&meeting.transcript, &api_key, &model, &mt, endpoint)
        .await
        .map_err(|e| format!("Erro ao gerar resumo: {e}"))?;

    meeting.summary = Some(summary.clone());
    storage::save_meeting(&meeting).map_err(|e| format!("Erro ao salvar: {e}"))?;
    Ok(summary)
}

// ─── Feature 9: E-mail de Follow-up ──────────────────────────────────────────

/// Gera e salva um e-mail de follow-up para a reunião.
#[tauri::command]
pub async fn generate_followup_email(
    meeting_id: String,
    api_key: String,
    model: Option<String>,
    base_url: Option<String>,
) -> Result<String, String> {
    let mut meeting =
        storage::load_meeting(&meeting_id).map_err(|e| format!("Reunião não encontrada: {e}"))?;

    let summary = meeting
        .summary
        .clone()
        .ok_or("Gere o resumo da reunião antes do e-mail de follow-up")?;

    let model = model.unwrap_or_else(|| ai::default_model().to_string());
    let endpoint = base_url.as_deref().unwrap_or(ai::OPENAI_ENDPOINT);

    let email = ai::generate_followup_email(&meeting.transcript, &summary, &api_key, &model, endpoint)
        .await
        .map_err(|e| format!("Erro ao gerar e-mail: {e}"))?;

    // Salva o e-mail no resumo da reunião
    if let Some(ref mut s) = meeting.summary {
        s.followup_email = Some(email.clone());
    }
    storage::save_meeting(&meeting).map_err(|e| format!("Erro ao salvar: {e}"))?;

    Ok(email)
}

// ─── Feature 10: Diarização ───────────────────────────────────────────────────

/// Identifica os falantes na transcrição e salva os segmentos na reunião.
#[tauri::command]
pub async fn diarize_transcript(
    meeting_id: String,
    api_key: String,
    model: Option<String>,
    base_url: Option<String>,
) -> Result<Vec<SpeakerSegment>, String> {
    let mut meeting =
        storage::load_meeting(&meeting_id).map_err(|e| format!("Reunião não encontrada: {e}"))?;

    if meeting.transcript.trim().is_empty() {
        return Err("Transcrição vazia — não é possível diarizar".to_string());
    }

    let model = model.unwrap_or_else(|| ai::default_model().to_string());
    let endpoint = base_url.as_deref().unwrap_or(ai::OPENAI_ENDPOINT);

    let segments = ai::diarize_transcript(&meeting.transcript, &api_key, &model, endpoint)
        .await
        .map_err(|e| format!("Erro na diarização: {e}"))?;

    meeting.speakers = Some(segments.clone());
    storage::save_meeting(&meeting).map_err(|e| format!("Erro ao salvar: {e}"))?;

    Ok(segments)
}

// ─── Feature 4: Export ────────────────────────────────────────────────────────

/// Exporta uma reunião no formato especificado. Retorna o caminho do arquivo criado.
/// `format`: "txt" ou "md"
#[tauri::command]
pub async fn export_meeting(
    meeting_id: String,
    format: String,
) -> Result<String, String> {
    let meeting =
        storage::load_meeting(&meeting_id).map_err(|e| format!("Reunião não encontrada: {e}"))?;

    match format.as_str() {
        "txt" => export::export_txt(&meeting).map_err(|e| format!("Erro ao exportar TXT: {e}")),
        "md"  => export::export_md(&meeting).map_err(|e| format!("Erro ao exportar MD: {e}")),
        _ => Err(format!("Formato não suportado: {format}")),
    }
}

/// Abre a pasta de exportações no explorador de arquivos.
#[tauri::command]
pub async fn open_export_folder() -> Result<(), String> {
    export::open_export_folder().map_err(|e| format!("Erro ao abrir pasta: {e}"))
}

// ─── Feature 8: Tipo de reunião ───────────────────────────────────────────────

/// Atualiza o tipo de reunião de uma reunião salva.
#[tauri::command]
pub async fn set_meeting_type(
    meeting_id: String,
    meeting_type: MeetingType,
) -> Result<(), String> {
    let mut meeting =
        storage::load_meeting(&meeting_id).map_err(|e| format!("Reunião não encontrada: {e}"))?;
    meeting.meeting_type = Some(meeting_type);
    storage::save_meeting(&meeting).map_err(|e| format!("Erro ao salvar: {e}"))
}

// ─── Renomear + editar transcrição ───────────────────────────────────────────

/// Atualiza o título e/ou transcrição de uma reunião salva.
/// Campos `None` não são alterados.
#[tauri::command]
pub async fn update_meeting_meta(
    meeting_id: String,
    title: Option<String>,
    transcript: Option<String>,
) -> Result<Meeting, String> {
    let mut meeting =
        storage::load_meeting(&meeting_id).map_err(|e| format!("Reunião não encontrada: {e}"))?;

    if let Some(t) = title {
        let trimmed = t.trim().to_string();
        if !trimmed.is_empty() {
            meeting.title = trimmed;
        }
    }
    if let Some(tx) = transcript {
        meeting.transcript = tx;
    }

    storage::save_meeting(&meeting).map_err(|e| format!("Erro ao salvar: {e}"))?;
    Ok(meeting)
}

// ─── Integração JGRC ─────────────────────────────────────────────────────────

/// Item de um dropdown parseado do HTML do JGRC (event_type, responsible, etc.)
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JgrcSelectOption {
    pub id: String,
    pub name: String,
}

/// Dados do formulário /events/new do JGRC, parseados do HTML.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JgrcFormData {
    pub csrf_token: String,
    pub event_types: Vec<JgrcSelectOption>,
    pub responsibles: Vec<JgrcSelectOption>,
}

/// Faz login no JGRC com email/senha (POST /sessions) e retorna os dados
/// necessários para criar um evento (GET /events/new → dropdowns + CSRF).
///
/// Fluxo:
/// 1. GET /log_in → obtém CSRF token do form de login
/// 2. POST /sessions com email + password + authenticity_token
/// 3. GET /events/new → parseia dropdowns de event_types + responsibles + CSRF
#[tauri::command]
pub async fn jgrc_get_form_data() -> Result<JgrcFormData, String> {
    let settings =
        storage::load_settings().map_err(|e| format!("Erro ao carregar configurações: {e}"))?;

    if settings.jgrc_url.is_empty() {
        return Err("URL do JGRC não configurada.".to_string());
    }
    if settings.jgrc_email.is_empty() || settings.jgrc_password.is_empty() {
        return Err("E-mail e senha do JGRC não configurados.".to_string());
    }

    let base_url = settings.jgrc_url.trim_end_matches('/');

    // Cliente com cookie jar para manter a sessão
    let client = reqwest::Client::builder()
        .cookie_store(true)
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Erro HTTP: {e}"))?;

    // ── Step 1: GET /log_in → CSRF do formulário de login ─────────────────────
    let login_page = client
        .get(&format!("{base_url}/log_in"))
        .send()
        .await
        .map_err(|e| format!("Erro ao conectar no JGRC: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Erro ao ler login page: {e}"))?;

    let login_csrf = extract_csrf_token(&login_page)
        .ok_or("Não foi possível obter CSRF do JGRC. Verifique a URL.")?;

    // ── Step 2: POST /sessions → faz login ────────────────────────────────────
    let mut login_form = std::collections::HashMap::new();
    login_form.insert("email", settings.jgrc_email.as_str());
    login_form.insert("password", settings.jgrc_password.as_str());
    login_form.insert("authenticity_token", login_csrf.as_str());

    let login_resp = client
        .post(&format!("{base_url}/sessions"))
        .header("Accept", "text/html")
        .form(&login_form)
        .send()
        .await
        .map_err(|e| format!("Erro ao fazer login: {e}"))?;

    let login_status = login_resp.status();
    let login_body = login_resp.text().await.unwrap_or_default();

    // Se redirecionou para /sessions/token_validate → precisa de 2FA (TOTP)
    if login_body.contains("token_validate") || login_body.contains("Token de verificação") {
        return Err("Login requer autenticação de dois fatores (TOTP). Funcionalidade ainda não suportada.".to_string());
    }

    // Se ainda mostra formulário de login → credenciais erradas
    if login_body.contains("name=\"password\"") && login_body.contains("name=\"email\"") {
        return Err("E-mail ou senha inválidos.".to_string());
    }

    if !login_status.is_success() && !login_status.is_redirection() {
        return Err(format!("Login falhou (HTTP {})", login_status));
    }

    // ── Step 3: GET /events/new → parseia dropdowns + CSRF ────────────────────
    let events_html = client
        .get(&format!("{base_url}/events/new"))
        .header("Accept", "text/html")
        .send()
        .await
        .map_err(|e| format!("Erro ao acessar formulário de eventos: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Erro ao ler formulário: {e}"))?;

    // Se redirecionou para login → sessão não foi criada
    if events_html.contains("name=\"password\"") && events_html.contains("name=\"email\"") {
        return Err("Sessão JGRC não foi criada. Verifique as credenciais.".to_string());
    }

    let csrf_token = extract_csrf_token(&events_html)
        .ok_or("CSRF token não encontrado no formulário de eventos.")?;

    let event_types = extract_select_options(&events_html, "event_event_type_id");
    let responsibles = extract_select_options(&events_html, "event_responsible_id");

    log::info!(
        "JGRC form data: {} tipos de evento, {} responsáveis",
        event_types.len(),
        responsibles.len()
    );

    Ok(JgrcFormData {
        csrf_token,
        event_types,
        responsibles,
    })
}

/// Dados do usuário logado no JGRC
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JgrcUser {
    pub id: i64,
    pub name: String,
    pub email: String,
}

/// Cliente (company) com contagem de eventos
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JgrcManager {
    pub id: String,
    pub name: String,
    pub qtd_events: i64,
}

/// Dados completos para a tela de exportação
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JgrcExportData {
    pub user: JgrcUser,
    pub event_types: Vec<JgrcSelectOption>,
    pub responsibles: Vec<JgrcSelectOption>,
    pub internal_attendees: Vec<JgrcSelectOption>,
    pub managers: Vec<JgrcManager>,
    pub cities: Vec<JgrcSelectOption>,
}

/// Busca dados do formulário de evento via API JSON do JGRC.
/// Requer sessão autenticada (cookie salvo).
/// Retorna: user info + event_types + responsibles
#[tauri::command]
pub async fn jgrc_get_export_data() -> Result<JgrcExportData, String> {
    let settings =
        storage::load_settings().map_err(|e| format!("Erro ao carregar configurações: {e}"))?;

    let base_url = if settings.jgrc_url.is_empty() {
        JGRC_DEFAULT_URL.to_string()
    } else {
        settings.jgrc_url.clone()
    };
    let base_url = base_url.trim_end_matches('/');

    if settings.jgrc_session_cookie.is_empty() {
        return Err("Não conectado ao JGRC. Faça login na aba Integração JGRC.".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Erro HTTP: {e}"))?;

    let resp = client
        .get(&format!("{base_url}/api/event_form_data"))
        .header("Cookie", format!("_jgrc_session={}", settings.jgrc_session_cookie))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Erro ao conectar ao JGRC: {e}"))?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED || resp.status().is_redirection() {
        return Err("Sessão JGRC expirada. Reconecte na aba Integração JGRC.".to_string());
    }

    if !resp.status().is_success() {
        return Err(format!("JGRC retornou erro {}", resp.status()));
    }

    let json: serde_json::Value = resp.json().await
        .map_err(|e| format!("Erro ao ler resposta JSON: {e}"))?;

    // Parse user
    let user = JgrcUser {
        id: json["user"]["id"].as_i64().unwrap_or(0),
        name: json["user"]["name"].as_str().unwrap_or("").to_string(),
        email: json["user"]["email"].as_str().unwrap_or("").to_string(),
    };

    // Parse event_types
    let event_types: Vec<JgrcSelectOption> = json["event_types"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|v| JgrcSelectOption {
                    id: v["id"].as_i64().map(|n| n.to_string()).unwrap_or_default(),
                    name: v["name"].as_str().unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default();

    // Parse responsibles
    let responsibles: Vec<JgrcSelectOption> = json["responsibles"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|v| JgrcSelectOption {
                    id: v["id"].as_i64().map(|n| n.to_string()).unwrap_or_default(),
                    name: v["name"].as_str().unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default();

    // Parse internal_attendees (Participantes JGP)
    let internal_attendees: Vec<JgrcSelectOption> = json["internal_attendees"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|v| JgrcSelectOption {
                    id: v["id"].as_i64().map(|n| n.to_string()).unwrap_or_default(),
                    name: v["name"].as_str().unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default();

    // Parse managers (Cliente - Qtd Eventos)
    let managers: Vec<JgrcManager> = json["managers"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|v| JgrcManager {
                    id: v["id"].as_i64().map(|n| n.to_string()).unwrap_or_default(),
                    name: v["name"].as_str().unwrap_or("").to_string(),
                    qtd_events: v["qtd_events"].as_i64().unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default();

    // Parse cities
    let cities: Vec<JgrcSelectOption> = json["cities"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|v| JgrcSelectOption {
                    id: v["id"].as_i64().map(|n| n.to_string()).unwrap_or_default(),
                    name: v["name"].as_str().unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default();

    log::info!("JGRC export data: user={}, {} event_types, {} responsibles, {} attendees, {} managers",
        user.name, event_types.len(), responsibles.len(), internal_attendees.len(), managers.len());

    Ok(JgrcExportData {
        user,
        event_types,
        responsibles,
        internal_attendees,
        managers,
        cities,
    })
}

/// Exporta uma reunião para o JGRC criando um novo evento.
///
/// Usa o endpoint `/api/create_event` do JGRC que:
///   - Pula verificação CSRF (skip_before_action :verify_authenticity_token)
///   - Autentica via cookie de sessão
///   - Retorna JSON diretamente
#[tauri::command]
pub async fn export_to_jgrc(
    meeting_id: String,
    event_type_id: Option<String>,
    responsible_id: Option<String>,
    subject: Option<String>,
    actions: Option<String>,
    manager_id: Option<String>,
    attendees: Option<String>,
    internal_attendee_ids: Option<Vec<String>>,
    city_id: Option<String>,
) -> Result<String, String> {
    let meeting =
        storage::load_meeting(&meeting_id).map_err(|e| format!("Reunião não encontrada: {e}"))?;

    let settings =
        storage::load_settings().map_err(|e| format!("Erro ao carregar configurações: {e}"))?;

    let jgrc_url = if settings.jgrc_url.is_empty() {
        JGRC_DEFAULT_URL.to_string()
    } else {
        settings.jgrc_url.clone()
    };
    let base_url = jgrc_url.trim_end_matches('/');

    if settings.jgrc_session_cookie.is_empty() {
        return Err("Não conectado ao JGRC. Faça login na aba Integração JGRC.".to_string());
    }

    let content = build_jgrc_content(&meeting);
    let event_date = meeting.started_at.format("%Y-%m-%d").to_string();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Erro HTTP: {e}"))?;

    // ── Monta o form para POST /api/create_event ─────────────────────────────
    // Usa Vec de tuples para suportar array params (internal_attendee_ids[])
    let mut form: Vec<(String, String)> = Vec::new();
    let event_subject = subject.filter(|s| !s.is_empty()).unwrap_or(meeting.title.clone());
    form.push(("event[subject]".into(), event_subject));
    form.push(("event[content]".into(), content));
    form.push(("event[event_date]".into(), event_date));

    if let Some(ref eti) = event_type_id {
        if !eti.is_empty() {
            form.push(("event[event_type_id]".into(), eti.clone()));
        }
    }
    if let Some(ref rid) = responsible_id {
        if !rid.is_empty() {
            form.push(("event[responsible_id]".into(), rid.clone()));
        }
    }
    if let Some(ref act) = actions {
        if !act.is_empty() {
            form.push(("event[actions]".into(), act.clone()));
        }
    }
    if let Some(ref mid) = manager_id {
        if !mid.is_empty() {
            form.push(("event[manager_id]".into(), mid.clone()));
        }
    }
    if let Some(ref att) = attendees {
        if !att.is_empty() {
            form.push(("event[attendees]".into(), att.clone()));
        }
    }
    if let Some(ref cid) = city_id {
        if !cid.is_empty() {
            form.push(("event[city_id]".into(), cid.clone()));
        }
    }
    if let Some(ref ids) = internal_attendee_ids {
        for id in ids.iter() {
            if !id.is_empty() {
                form.push(("event[internal_attendee_ids][]".into(), id.clone()));
            }
        }
    }

    // ── POST /api/create_event ───────────────────────────────────────────────
    let response = client
        .post(&format!("{base_url}/api/create_event"))
        .header("Cookie", format!("_jgrc_session={}", settings.jgrc_session_cookie))
        .header("Accept", "application/json")
        .form(&form)
        .send().await
        .map_err(|e| format!("Erro ao criar evento: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Sessão JGRC expirada. Reconecte na aba Integração JGRC.".to_string());
    }

    if !status.is_success() {
        // Tenta extrair mensagem de erro amigável do JSON
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
            if let Some(errors) = json["errors"].as_array() {
                let msg = errors.iter()
                    .filter_map(|e| e.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                return Err(format!("Erro ao criar evento: {msg}"));
            }
            if let Some(err) = json["error"].as_str() {
                return Err(format!("Erro: {err}"));
            }
        }
        return Err(format!("JGRC retornou erro {status}: {body}"));
    }

    let event_id = if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
        json["id"].as_i64().map(|id| id.to_string())
            .or_else(|| json["id"].as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| "criado".to_string())
    } else {
        "criado".to_string()
    };

    let mut meeting_mut = meeting;
    meeting_mut.jgrc_event_id = Some(event_id.clone());
    storage::save_meeting(&meeting_mut).map_err(|e| format!("Erro ao salvar: {e}"))?;

    log::info!("Reunião '{}' exportada para JGRC (event_id={})", meeting_mut.title, event_id);
    Ok(event_id)
}

/// Monta o conteúdo HTML para o campo `content` do JGRC a partir dos dados da reunião.
fn build_jgrc_content(meeting: &Meeting) -> String {
    let mut parts: Vec<String> = Vec::new();

    if let Some(ref summary) = meeting.summary {
        parts.push(format!(
            "<p><strong>Resumo:</strong><br/>{}</p>",
            summary.summary.replace('\n', "<br/>")
        ));

    }

    if !meeting.transcript.is_empty() {
        parts.push(format!(
            "<p><strong>Transcrição:</strong><br/>{}</p>",
            meeting.transcript.replace('\n', "<br/>")
        ));
    }

    parts.join("\n")
}

/// Extrai o valor do CSRF token da tag `<meta name="csrf-token" content="...">`.
fn extract_csrf_token(html: &str) -> Option<String> {
    let marker = r#"name="csrf-token" content=""#;
    let start = html.find(marker)? + marker.len();
    let end = html[start..].find('"')? + start;
    let token = html[start..end].to_string();
    if token.is_empty() { None } else { Some(token) }
}

/// Parseia opções de um `<select id="...">` do HTML Rails.
/// Extrai todos os `<option value="ID">NOME</option>` dentro do select.
fn extract_select_options(html: &str, select_id: &str) -> Vec<JgrcSelectOption> {
    let mut options = Vec::new();

    // Encontra o bloco <select id="select_id">...</select>
    let open_marker = format!(r#"id="{}""#, select_id);
    let start = match html.find(&open_marker) {
        Some(pos) => pos,
        None => return options,
    };
    let select_html = &html[start..];
    let end = match select_html.find("</select>") {
        Some(pos) => pos,
        None => return options,
    };
    let block = &select_html[..end];

    // Extrai cada <option value="...">...</option>
    let mut cursor = 0;
    while cursor < block.len() {
        let opt_marker = r#"<option value=""#;
        let opt_start = match block[cursor..].find(opt_marker) {
            Some(pos) => cursor + pos + opt_marker.len(),
            None => break,
        };
        let val_end = match block[opt_start..].find('"') {
            Some(pos) => opt_start + pos,
            None => break,
        };
        let value = block[opt_start..val_end].to_string();

        // Pula opções vazias (placeholder "Selecione...")
        if value.is_empty() {
            cursor = val_end + 1;
            continue;
        }

        // Texto entre > e </option>
        let text_start = match block[val_end..].find('>') {
            Some(pos) => val_end + pos + 1,
            None => break,
        };
        let text_end = match block[text_start..].find("</option>") {
            Some(pos) => text_start + pos,
            None => break,
        };
        let name = block[text_start..text_end].trim().to_string();

        if !name.is_empty() {
            options.push(JgrcSelectOption { id: value, name });
        }

        cursor = text_end + 9; // skip </option>
    }

    options
}

// ─── JGRC: Login via WebView ──────────────────────────────────────────────────

/// URL fixa do JGRC
const JGRC_DEFAULT_URL: &str = "https://jgrc.jgp.com.br";

/// Abre uma janela WebView para o usuário fazer login no JGRC.
/// Após o login, detecta a navegação para fora de /log_in e /sessions,
/// tenta extrair o cookie `_jgrc_session` via JavaScript e retorna.
#[tauri::command]
pub async fn jgrc_open_login(url: String, app: AppHandle) -> Result<String, String> {
    let base_url = if url.is_empty() {
        JGRC_DEFAULT_URL.to_string()
    } else {
        url.trim_end_matches('/').to_string()
    };
    let login_url = format!("{base_url}/log_in");

    // Canal mpsc para receber mensagens do on_navigation
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(10);
    let tx_nav = tx.clone();
    let tx_cookie = tx.clone();

    let base_for_nav = base_url.clone();

    // Se já existe uma janela de login aberta, fecha antes de abrir nova
    if let Some(existing) = app.get_webview_window("jgrc-login") {
        let _ = existing.close();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }

    // Cria janela WebView para login com handler de navegação
    let webview_window = tauri::WebviewWindowBuilder::new(
        &app,
        "jgrc-login",
        tauri::WebviewUrl::External(login_url.parse().map_err(|e| format!("URL inválida: {e}"))?),
    )
    .title("Login JGRC")
    .inner_size(900.0, 700.0)
    .center()
    .resizable(true)
    .on_navigation(move |nav_url: &tauri::Url| {
        let url_str = nav_url.as_str();
        log::info!("JGRC WebView navegou para: {url_str}");

        // Intercepta URL de callback com o cookie
        if url_str.starts_with("http://jgrc-cookie-callback/") {
            let cookie_val = url_str
                .strip_prefix("http://jgrc-cookie-callback/")
                .unwrap_or("")
                .to_string();
            let _ = tx_cookie.try_send(format!("cookie:{cookie_val}"));
            return false; // bloqueia a navegação real
        }

        // Detecta sucesso do login (saiu da página de login/sessions)
        let is_login_page = url_str.contains("/log_in")
            || url_str.contains("/sessions")
            || url_str.contains("/token_validate");

        if !is_login_page && url_str.starts_with(&base_for_nav) {
            let _ = tx_nav.try_send("login_success".to_string());
        }
        true
    })
    .build()
    .map_err(|e| format!("Erro ao criar janela de login: {e}"))?;

    let window_ref = webview_window.clone();
    let window_timeout = webview_window.clone();

    // Espera login + extração do cookie com timeout de 5 minutos
    let result = tokio::select! {
        cookie = async {
            // 1) Espera o sinal de login_success
            loop {
                match rx.recv().await {
                    Some(msg) if msg == "login_success" => break,
                    Some(_) => continue,
                    None => return "error:channel_closed".to_string(),
                }
            }

            // 2) Delay para cookies serem setados
            tokio::time::sleep(std::time::Duration::from_millis(800)).await;

            // 3) Injeta JS para extrair cookie e navegar para URL de callback
            let cookie_js = r#"
                (function() {
                    var cookies = document.cookie.split(';');
                    var session = '';
                    for (var i = 0; i < cookies.length; i++) {
                        var c = cookies[i].trim();
                        if (c.startsWith('_jgrc_session=')) {
                            session = c.substring('_jgrc_session='.length);
                            break;
                        }
                    }
                    window.location.href = 'http://jgrc-cookie-callback/' + encodeURIComponent(session || '__empty__');
                })();
            "#;

            if let Err(e) = window_ref.eval(cookie_js) {
                log::error!("Erro ao executar JS de extração de cookie: {e}");
                return "error:eval_failed".to_string();
            }

            // 4) Espera callback com o cookie (timeout 5s)
            match tokio::time::timeout(
                std::time::Duration::from_secs(5),
                async {
                    loop {
                        match rx.recv().await {
                            Some(msg) if msg.starts_with("cookie:") => {
                                return msg.strip_prefix("cookie:").unwrap_or("").to_string();
                            }
                            Some(_) => continue,
                            None => return String::new(),
                        }
                    }
                }
            ).await {
                Ok(cookie) => cookie,
                Err(_) => "__empty__".to_string(),
            }
        } => cookie,
        _ = tokio::time::sleep(std::time::Duration::from_secs(300)) => {
            let _ = window_timeout.close();
            return Err("Timeout: login não concluído em 5 minutos.".to_string());
        }
    };

    // Fecha a janela de login
    let _ = webview_window.close();

    // Processa o resultado
    if result.starts_with("error:") {
        return Err(format!("Erro no login JGRC: {result}"));
    }

    // Salva o cookie (ou marcador de autenticação) nas configurações
    let mut settings = storage::load_settings().map_err(|e| format!("Erro: {e}"))?;
    settings.jgrc_url = base_url;

    if !result.is_empty() && result != "__empty__" && result != "%5F%5Fempty%5F%5F" {
        // Cookie extraído com sucesso (cookie não é HttpOnly)
        let decoded = percent_decode_simple(&result);
        settings.jgrc_session_cookie = decoded.clone();
        storage::save_settings(&settings).map_err(|e| format!("Erro ao salvar: {e}"))?;
        log::info!("Cookie JGRC capturado com sucesso");
        Ok(decoded)
    } else {
        // Cookie é HttpOnly — marca como autenticado
        settings.jgrc_session_cookie = "authenticated".to_string();
        storage::save_settings(&settings).map_err(|e| format!("Erro ao salvar: {e}"))?;
        log::info!("Login JGRC concluído (cookie HttpOnly, marcado como autenticado)");
        Ok("authenticated".to_string())
    }
}

/// Decodificação simples de percent-encoding (para cookies na URL de callback)
fn percent_decode_simple(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.chars();
    while let Some(c) = chars.next() {
        if c == '%' {
            let hex: String = chars.by_ref().take(2).collect();
            if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                result.push(byte as char);
            } else {
                result.push('%');
                result.push_str(&hex);
            }
        } else {
            result.push(c);
        }
    }
    result
}

/// Verifica se o cookie de sessão do JGRC ainda é válido.
/// Faz um GET na home do JGRC e verifica se não redireciona para login.
#[tauri::command]
pub async fn jgrc_check_session(url: String, cookie: String) -> Result<bool, String> {
    if url.is_empty() || cookie.is_empty() {
        return Ok(false);
    }

    let base_url = url.trim_end_matches('/');

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none()) // Não seguir redirects
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Erro HTTP: {e}"))?;

    let resp = client
        .get(&format!("{base_url}/events"))
        .header("Cookie", format!("_jgrc_session={cookie}"))
        .send()
        .await
        .map_err(|e| format!("Erro ao verificar sessão: {e}"))?;

    let status = resp.status();

    // Se retornou 200, a sessão é válida
    // Se retornou 302 (redirect para login), a sessão expirou
    Ok(status.is_success())
}

// ─── Feature 12: Detecção de apps ────────────────────────────────────────────

/// Retorna a lista de apps de reunião detectados em execução no sistema.
#[tauri::command]
pub async fn check_meeting_apps() -> Result<Vec<detection::DetectedApp>, String> {
    Ok(detection::detect_meeting_apps())
}

// ─── Comandos: Histórico ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_meetings() -> Result<Vec<Meeting>, String> {
    storage::list_meetings().map_err(|e| format!("Erro ao listar reuniões: {e}"))
}

#[tauri::command]
pub async fn get_meeting(id: String) -> Result<Meeting, String> {
    storage::load_meeting(&id).map_err(|e| format!("Reunião não encontrada: {e}"))
}

#[tauri::command]
pub async fn delete_meeting(id: String) -> Result<(), String> {
    storage::delete_meeting(&id).map_err(|e| format!("Erro ao remover reunião: {e}"))
}

// ─── Comandos: Configurações ──────────────────────────────────────────────────

#[tauri::command]
pub async fn get_settings() -> Result<AppSettings, String> {
    storage::load_settings().map_err(|e| format!("Erro ao carregar configurações: {e}"))
}

#[tauri::command]
pub async fn save_settings(settings: AppSettings) -> Result<(), String> {
    storage::save_settings(&settings).map_err(|e| format!("Erro ao salvar configurações: {e}"))
}

// ─── Feature 13: Atalho global ────────────────────────────────────────────────

/// Registra (ou atualiza) os atalhos globais.
/// Remove todos os atalhos existentes antes de registrar os novos.
///
/// - `shortcut`: atalho para toggle gravação (emite `toggle-recording`)
/// - `mute_shortcut`: atalho para mutar/desmutar mic (emite `toggle-mic-mute`)
#[tauri::command]
pub async fn register_global_shortcut(
    app: AppHandle,
    shortcut: String,
    mute_shortcut: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    app.global_shortcut()
        .unregister_all()
        .map_err(|e| e.to_string())?;

    // Atalho de gravação
    if !shortcut.is_empty() {
        let app_clone = app.clone();
        app.global_shortcut()
            .on_shortcut(shortcut.as_str(), move |_app, _s, event| {
                if event.state() == ShortcutState::Pressed {
                    let _ = app_clone.emit("toggle-recording", ());
                }
            })
            .map_err(|e| format!("Erro ao registrar atalho '{}': {}", shortcut, e))?;
    }

    // Atalho de mute mic
    if let Some(ref mute) = mute_shortcut {
        if !mute.is_empty() {
            let app_clone = app.clone();
            app.global_shortcut()
                .on_shortcut(mute.as_str(), move |_app, _s, event| {
                    if event.state() == ShortcutState::Pressed {
                        let _ = app_clone.emit("toggle-mic-mute", ());
                    }
                })
                .map_err(|e| format!("Erro ao registrar atalho mute '{}': {}", mute, e))?;
        }
    }

    Ok(())
}

// ─── Feature 29: Perguntas à transcrição ─────────────────────────────────────

/// Responde a uma pergunta com base no conteúdo da transcrição de uma reunião.
#[tauri::command]
pub async fn ask_about_transcript(
    meeting_id: String,
    question: String,
    api_key: String,
    model: Option<String>,
    base_url: Option<String>,
) -> Result<String, String> {
    let meeting =
        storage::load_meeting(&meeting_id).map_err(|e| format!("Reunião não encontrada: {e}"))?;

    if meeting.transcript.trim().is_empty() {
        return Err("Transcrição vazia — não é possível responder perguntas".to_string());
    }

    let model = model.unwrap_or_else(|| ai::default_model().to_string());
    let endpoint = base_url.as_deref().unwrap_or(ai::OPENAI_ENDPOINT);

    ai::ask_about_transcript(&question, &meeting.transcript, &api_key, &model, endpoint)
        .await
        .map_err(|e| format!("Erro ao responder pergunta: {e}"))
}

// ─── Download de modelo Whisper ───────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DownloadProgress {
    pub model: String,
    pub downloaded: u64,
    pub total: u64,
}

/// Baixa um modelo ggml do Whisper.cpp a partir do Hugging Face.
/// Emite eventos: "whisper-download-progress" (DownloadProgress) e "whisper-download-done" (caminho).
/// Modelos suportados: tiny, tiny.en, base, base.en, small, small.en, medium, large-v3 etc.
#[tauri::command]
pub async fn download_whisper_model(
    app: AppHandle,
    model: String,
) -> Result<String, String> {
    let models_dir = storage::models_dir()
        .map_err(|e| format!("Erro ao obter diretório de modelos: {e}"))?;

    let filename = format!("ggml-{model}.bin");
    let dest_path = models_dir.join(&filename);

    if dest_path.exists() {
        let path_str = dest_path.to_string_lossy().to_string();
        let _ = app.emit("whisper-download-done", &path_str);
        return Ok(path_str);
    }

    let url = format!(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{model}.bin"
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3600))
        .build()
        .map_err(|e| format!("Erro ao criar cliente HTTP: {e}"))?;

    let mut response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Erro de rede ao baixar modelo: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Modelo '{}' não encontrado (HTTP {})", model, response.status()));
    }

    let total = response.content_length().unwrap_or(0);
    let _ = app.emit("whisper-download-progress", DownloadProgress {
        model: model.clone(),
        downloaded: 0,
        total,
    });

    let mut file = std::fs::File::create(&dest_path)
        .map_err(|e| format!("Erro ao criar arquivo: {e}"))?;

    let mut downloaded: u64 = 0;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Erro ao baixar chunk: {e}"))?
    {
        use std::io::Write;
        file.write_all(&chunk)
            .map_err(|e| format!("Erro ao escrever arquivo: {e}"))?;
        downloaded += chunk.len() as u64;
        let _ = app.emit("whisper-download-progress", DownloadProgress {
            model: model.clone(),
            downloaded,
            total,
        });
    }

    let path_str = dest_path.to_string_lossy().to_string();
    let _ = app.emit("whisper-download-done", &path_str);
    log::info!("Modelo Whisper '{model}' baixado em {path_str}");

    // Atualiza local_whisper_model nas settings com o caminho completo do modelo baixado
    if let Ok(mut settings) = storage::load_settings() {
        settings.local_whisper_model = path_str.clone();
        if let Err(e) = storage::save_settings(&settings) {
            log::warn!("Não foi possível atualizar local_whisper_model nas settings: {e}");
        } else {
            log::info!("local_whisper_model atualizado para: {path_str}");
        }
    }

    Ok(path_str)
}

/// Retorna a lista de dispositivos de captura de áudio (microfones) disponíveis no sistema.
/// Inclui "Microfone padrão do sistema" como primeiro item (id vazio).
#[tauri::command]
pub async fn list_microphones() -> Result<Vec<audio::AudioDevice>, String> {
    audio::list_capture_devices().map_err(|e| format!("Erro ao listar microfones: {e}"))
}

/// Retorna a lista de modelos Whisper já baixados no diretório de modelos.
#[tauri::command]
pub async fn list_downloaded_whisper_models() -> Result<Vec<String>, String> {
    let models_dir = storage::models_dir()
        .map_err(|e| format!("Erro: {e}"))?;

    let models = std::fs::read_dir(&models_dir)
        .map_err(|e| format!("Erro ao ler diretório: {e}"))?
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let name = path.file_name()?.to_str()?.to_string();
            if name.starts_with("ggml-") && name.ends_with(".bin") {
                Some(name.trim_start_matches("ggml-").trim_end_matches(".bin").to_string())
            } else {
                None
            }
        })
        .collect();

    Ok(models)
}
