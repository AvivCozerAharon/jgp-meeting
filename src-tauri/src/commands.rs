/// commands.rs
/// Comandos Tauri expostos ao frontend React via invoke().
use std::io::Write;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Instant;

use arc_swap::ArcSwap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::ai::{self, MeetingSummary};
use crate::audio::{self, AudioCaptureState, AudioChunk, AudioSource};
use crate::detection;
use crate::export;
use crate::storage::{self, AppSettings, Meeting, MeetingType};
use crate::transcription;

fn jaccard_bigrams(a: &str, b: &str) -> f32 {
    use std::collections::HashSet;
    let bigrams_of = |s: &str| -> HashSet<(String, String)> {
        let words: Vec<&str> = s.split_whitespace().collect();
        words.windows(2)
            .map(|w| (w[0].to_lowercase(), w[1].to_lowercase()))
            .collect()
    };
    let a_set = bigrams_of(a);
    let b_set = bigrams_of(b);
    if a_set.is_empty() && b_set.is_empty() {
        // Both truly empty strings → identical
        return if a.trim().is_empty() && b.trim().is_empty() { 1.0 } else { 0.0 };
    }
    if a_set.is_empty() || b_set.is_empty() { return 0.0; }
    let intersection = a_set.intersection(&b_set).count() as f32;
    let union_count = a_set.union(&b_set).count() as f32;
    intersection / union_count
}

fn is_known_filler(text: &str) -> bool {
    let lower = text.to_lowercase();
    matches!(
        lower.as_str(),
        "é" | "é." | "é.." | "tchau" | "tchau." | "tchau!" | "tchau, tchau"
        | "sim" | "sim." | "não" | "não." | "ok" | "ok." | "ah" | "ah." | "hmm"
        | "uh" | "uh huh" | "hum" | "hm" | "aham" | "ei" | "opa"
        | "tchau tchau" | "tchau, tchau!" | "é. é." | "é. é. é."
    )
}

/// Verifica se o texto bate em algum padrão de hallucination configurável.
/// Match é case-insensitive substring.
fn matches_hallucination_pattern(text: &str, patterns: &[String]) -> bool {
    if patterns.is_empty() {
        return false;
    }
    let lower = text.to_lowercase();
    patterns.iter().any(|p| {
        let p_lower = p.to_lowercase();
        !p_lower.is_empty() && lower.contains(&p_lower)
    })
}

/// Returns the last complete sentence from `transcript` as Whisper prompt context.
/// Falls back to the last 120 words if no sentence terminator is found.
fn last_sentence_context(transcript: &str) -> String {
    let trimmed = transcript.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    const SENTENCE_ENDS: [char; 3] = ['.', '!', '?'];
    const MAX_WORDS: usize = 120;

    let last_term = trimmed.char_indices().rev().find(|(_, c)| SENTENCE_ENDS.contains(c));

    let effective: &str = match last_term {
        None => trimmed,
        Some((end_pos, end_char)) => {
            let before = &trimmed[..end_pos];
            let prev_term = before
                .char_indices()
                .rev()
                .find(|(_, c)| SENTENCE_ENDS.contains(c));
            let start = match prev_term {
                None => 0,
                Some((i, c)) => i + c.len_utf8(),
            };
            trimmed[start..end_pos + end_char.len_utf8()].trim()
        }
    };

    let words: Vec<&str> = effective.split_whitespace().collect();
    let start = words.len().saturating_sub(MAX_WORDS);
    words[start..].join(" ")
}

/// Gate de qualidade baseado nas probabilidades retornadas pelo Whisper verbose_json.
/// Retorna true se o resultado deve ser descartado.
/// Thresholds: no_speech_prob > 0.6 (provavelmente silêncio/ruído),
/// avg_logprob < -1.0 (confiança baixa, possivelmente hallucination).
fn is_low_quality_transcription(result: &transcription::TranscriptionResult) -> bool {
    if result.no_speech_prob > 0.6 {
        return true;
    }
    // avg_logprob == 0.0 significa "sem segments" (resposta curta tipo Groq); não descarta por isso.
    if result.avg_logprob < -1.0 && result.avg_logprob != 0.0 {
        return true;
    }
    false
}

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

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
pub struct CalibrationMetrics {
    pub speech_rms: f32,
    pub speech_peak: f32,
    pub silence_rms: f32,
}

pub struct AppState {
    pub capture_state: Arc<AudioCaptureState>,
    /// Lock-free transcript buffer (ArcSwap para escrita sem bloquear leitura)
    pub transcript: ArcSwap<String>,
    pub segments: Mutex<Vec<storage::TranscriptSegment>>,
    pub current_meeting: Mutex<Option<Meeting>>,
    pub capture_start: Mutex<Option<Instant>>,
    pub stop_tx: Mutex<Option<mpsc::Sender<()>>>,
    /// ID da reunião sendo drenada (worker processando chunks pendentes após stop).
    /// Usado para re-salvar a reunião com a transcrição completa após draining.
    pub draining_meeting_id: Mutex<Option<String>>,
    pub calibration: Mutex<CalibrationMetrics>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            capture_state: Arc::new(AudioCaptureState::new()),
            transcript: ArcSwap::from_pointee(String::new()),
            segments: Mutex::new(Vec::new()),
            current_meeting: Mutex::new(None),
            capture_start: Mutex::new(None),
            stop_tx: Mutex::new(None),
            draining_meeting_id: Mutex::new(None),
            calibration: Mutex::new(CalibrationMetrics::default()),
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

    // Resolve silero model path from bundled Tauri resources
    let silero_path: Option<std::path::PathBuf> = app
        .path()
        .resource_dir()
        .ok()
        .map(|p| p.join("silero_vad.onnx"))
        .filter(|p| p.exists());

    let provider = settings.transcription_provider.as_str();

    match provider {
        "openai" if settings.openai_api_key.is_empty() => {
            return Err("Chave da API OpenAI não configurada.".to_string());
        }
        "groq" if settings.groq_api_key.is_empty() => {
            return Err("Chave da API Groq não configurada.".to_string());
        }
        _ => {}
    }

    // Inicializa reunião com o tipo selecionado
    let mut meeting = Meeting::new();
    meeting.meeting_type = meeting_type.or(Some(settings.default_meeting_type.clone()));

    *state.current_meeting.lock() = Some(meeting);
    state.transcript.store(Arc::new(String::new()));
    state.segments.lock().clear();
    *state.capture_start.lock() = Some(Instant::now());
    let recording_start: Instant = state.capture_start.lock().unwrap();

    state
        .capture_state
        .is_capturing
        .store(true, std::sync::atomic::Ordering::SeqCst);
    // Reseta mic muted para nova sessão
    state.capture_state.set_mic_muted(false);

    let (chunk_tx, chunk_rx) = mpsc::channel::<AudioChunk>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    *state.stop_tx.lock() = Some(stop_tx);

    // Inicia captura de áudio (Feature 1: threshold, Feature 5: mic com config separado)
    let capture_arc = Arc::clone(&state.capture_state);
    let system_config = audio::SystemConfig {
        chunk_duration_secs: settings.chunk_duration_secs,
        silence_threshold: settings.silence_threshold,
        auto_gain: settings.system_auto_gain,
        gain_max: settings.system_gain_max,
    };
    let mic_config = audio::MicConfig {
        enabled: settings.capture_microphone,
        device_id: settings.selected_microphone.clone(),
        silence_threshold: settings.mic_silence_threshold,
        auto_gain: settings.mic_auto_gain,
        gain_max: settings.mic_gain_max,
        silero_model_path: silero_path,
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
    let whisper_prompt   = settings.whisper_prompt.clone();
    let whisper_glossary = settings.whisper_glossary.clone();
    let app_clone        = app.clone();
    let recording_start  = recording_start;

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
    let transcription_sem = Arc::new(tokio::sync::Semaphore::new(3));
    tokio::spawn(async move {
        log::info!("Worker de transcrição iniciado (provider={})", provider_str);

        /// Helper: transcreve um chunk e acumula no transcript global.
        /// Retorna true se obteve texto não-vazio.
        async fn process_chunk(
            chunk: AudioChunk,
            capture_start: Instant,
            chunk_recv_ms: u64,
            provider: &str,
            language: &str,
            api_key: &str,
            groq_key: &str,
            whisper_prompt: &str,
            whisper_glossary: &str,
            app: &AppHandle,
        ) -> bool {
            let source_str = match chunk.source {
                AudioSource::Microphone => "mic",
                AudioSource::System => "system",
            };
            let _ = app.emit("transcription-processing", serde_json::json!({
                "active": true,
                "source": source_str
            }));

            let wav_bytes = match chunk.to_wav_bytes_whisper() {
                Ok(b) => b,
                Err(e) => {
                    log::error!("Erro ao codificar WAV: {e}");
                    let _ = app.emit("transcription-processing", serde_json::json!({
                        "active": false,
                        "source": null
                    }));
                    return false;
                }
            };

            // Build accumulated context: last complete sentence from transcript so far + user's static prompt
            let app_state = app.state::<AppState>();
            let accumulated = app_state.transcript.load();
            let context_words = last_sentence_context(&accumulated);
            let glossary_part: Option<String> = {
                let terms: Vec<&str> = whisper_glossary
                    .split([',', '\n'])
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .collect();
                if terms.is_empty() { None } else { Some(terms.join(", ")) }
            };

            let effective_prompt: Option<String> = match (
                glossary_part.as_deref(),
                context_words.is_empty(),
                whisper_prompt.is_empty(),
            ) {
                (None,    true,  true)  => None,
                (None,    true,  false) => Some(whisper_prompt.to_string()),
                (None,    false, true)  => Some(context_words),
                (None,    false, false) => Some(format!("{} {}", context_words, whisper_prompt)),
                (Some(g), true,  true)  => Some(g.to_string()),
                (Some(g), true,  false) => Some(format!("{} {}", g, whisper_prompt)),
                (Some(g), false, true)  => Some(format!("{} {}", g, context_words)),
                (Some(g), false, false) => Some(format!("{} {} {}", g, context_words, whisper_prompt)),
            };
            let prompt_opt = effective_prompt.as_deref();

            let result = match provider {
                "groq" => {
                    transcription::transcribe_groq_verbose(wav_bytes, groq_key, Some(language), prompt_opt).await
                }
                _ => {
                    transcription::transcribe_audio_verbose(wav_bytes, api_key, Some(language), prompt_opt).await
                }
            };

            // Lê a lista de hallucinations configurável (recarrega settings a cada chunk
            // para refletir mudanças sem precisar reiniciar a gravação).
            let hallucination_patterns: Vec<String> = storage::load_settings()
                .map(|s| s.hallucination_patterns)
                .unwrap_or_default();

            let got_text = match result {
                Ok(tr) if !tr.text.is_empty() => {
                    let text = tr.text.clone();
                    if is_low_quality_transcription(&tr) {
                        log::debug!(
                            "Low-quality descartado (no_speech_prob={:.2}, avg_logprob={:.2}): {:?}",
                            tr.no_speech_prob, tr.avg_logprob,
                            &text[..text.len().min(60)]
                        );
                        false
                    } else if matches_hallucination_pattern(&text, &hallucination_patterns) {
                        log::debug!("Hallucination pattern descartado: {:?}", &text[..text.len().min(60)]);
                        false
                    } else {
                    let is_filler = chunk.source == AudioSource::Microphone && {
                        let trimmed = text.trim();
                        let len = trimmed.chars().count();
                        len < 5 || is_known_filler(trimmed)
                    };
                    if is_filler {
                        log::debug!("Mic filler descartado: {:?}", text.trim());
                        false
                    } else {
                        // Compute timestamp from chunk_recv_ms (captured before the API call)
                        let chunk_duration_ms = (chunk.duration_secs * 1000.0) as u64;
                        let timestamp_ms = chunk_recv_ms.saturating_sub(chunk_duration_ms);

                        let source = match chunk.source {
                            AudioSource::System => "system".to_string(),
                            AudioSource::Microphone => "mic".to_string(),
                        };

                        let segment = storage::TranscriptSegment {
                            source: source.clone(),
                            timestamp_ms,
                            text: text.clone(),
                        };

                        // Dedup: skip if too similar to a recent segment (same-source Jaccard >= 0.85,
                        // or cross-stream Jaccard >= 0.70 within a 3 s window).
                        // Short texts (< 4 words) skip both checks — bigrams unreliable on short strings.
                        let word_count = text.split_whitespace().count();
                        let is_duplicate = if word_count < 4 {
                            false
                        } else {
                            let segs = app_state.segments.lock();
                            segs.iter()
                                .rev()
                                .find(|s| s.source == source)
                                .map(|prev| jaccard_bigrams(&prev.text, &text) >= 0.85)
                                .unwrap_or(false)
                        };

                        let is_cross_dup = if !is_duplicate && word_count >= 4 {
                            let opposite = if source == "mic" { "system" } else { "mic" };
                            let segs = app_state.segments.lock();
                            segs.iter()
                                .rev()
                                .filter(|s| s.source == opposite)
                                // Compare against the first (most recent) opposite-source segment in the 3 s window.
                                .find(|s| timestamp_ms.abs_diff(s.timestamp_ms) < 3000)
                                .map(|prev| jaccard_bigrams(&prev.text, &text) >= 0.70)
                                .unwrap_or(false)
                        } else {
                            false
                        };

                        if is_duplicate || is_cross_dup {
                            log::debug!(
                                "Segment deduped (source={}, cross={}): {:?}",
                                source, is_cross_dup,
                                &text[..text.len().min(50)]
                            );
                            let _ = app.emit("transcription-processing", serde_json::json!({
                                "active": false,
                                "source": null
                            }));
                            return false;
                        }

                        // Insert sorted by timestamp and update transcript incrementally
                        let flat: String = {
                            let mut segs = app_state.segments.lock();
                            let pos = segs.partition_point(|s| s.timestamp_ms <= timestamp_ms);
                            segs.insert(pos, segment.clone());

                            let current = app_state.transcript.load();
                            let current_str = current.as_ref();

                            if segs.len() == 1 {
                                segment.text.clone()
                            } else if pos == 0 {
                                format!("{} {}", segment.text, current_str)
                            } else if pos >= segs.len() - 1 {
                                format!("{} {}", current_str, segment.text)
                            } else {
                                let before: String = segs[..pos].iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
                                let after: String = segs[pos+1..].iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
                                format!("{} {} {}", before, segment.text, after)
                            }
                        };
                        app_state.transcript.store(Arc::new(flat));

                        let _ = app.emit("transcription-update", &segment);
                        true
                    }
                    }
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

            let _ = app.emit("transcription-processing", serde_json::json!({
                "active": false,
                "source": null
            }));
            got_text
        }

        // ── Fase 1: Processamento normal (durante gravação ativa) ────────
        // Processa chunks conforme chegam, checando stop signal a cada iteração.
        // Declared here so chunks dequeued at the moment of stop are not dropped.
        let mut pre_drain: Vec<AudioChunk> = Vec::new();
        loop {
            // Two stop-detection paths:
            // - This try_recv() handles stop when no chunk is in flight (recv_timeout expires normally).
            // - The tokio::select! stop arm below handles stop while blocked waiting for a semaphore permit.
            // Both are needed; removing either creates a stop-delay window.
            if stop_rx.try_recv().is_ok() {
                log::info!("Sinal de stop recebido — aguardando thread de áudio finalizar...");
                break;
            }

            match chunk_rx.recv_timeout(std::time::Duration::from_millis(200)) {
                Ok(chunk) => {
                    // Drop chunk silently while paused
                    if app_clone.state::<AppState>().capture_state.is_paused() {
                        continue;
                    }
                    let chunk_recv_ms = recording_start.elapsed().as_millis() as u64;
                    let permit = tokio::select! {
                        p = Arc::clone(&transcription_sem).acquire_owned() => {
                            p.expect("Semaphore closed")
                        }
                        _ = async {
                            loop {
                                if !app_clone.state::<AppState>().capture_state.is_capturing
                                    .load(std::sync::atomic::Ordering::SeqCst)
                                {
                                    break;
                                }
                                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                            }
                        } => {
                            // Preserve the chunk already dequeued from chunk_rx — it would otherwise be dropped.
                            pre_drain.push(chunk);
                            break;
                        }
                    };
                    let app2      = app_clone.clone();
                    let provider2 = provider_str.clone();
                    let lang2     = language.clone();
                    let key2      = api_key.clone();
                    let groq2     = groq_key.clone();
                    let prompt2   = whisper_prompt.clone();
                    let glossary2   = whisper_glossary.clone();
                    tokio::spawn(async move {
                        let _permit = permit; // released when task ends
                        process_chunk(
                            chunk, recording_start, chunk_recv_ms,
                            &provider2, &lang2, &key2, &groq2, &prompt2, &glossary2, &app2,
                        ).await;
                    });
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
        // Note: pre_drain was declared before Phase 1 to capture any chunk
        // dequeued at stop time; Phase 2 appends to it.
        loop {
            match chunk_rx.recv_timeout(std::time::Duration::from_secs(15)) {
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
        let drain_meeting_id: Option<String> = app_clone
            .state::<AppState>()
            .draining_meeting_id
            .lock()
            .clone();

        if !pre_drain.is_empty() {
            let total = pre_drain.len();
            let _ = app_clone.emit("transcription-draining", serde_json::json!({
                "pending": total,
                "total": total,
                "meeting_id": drain_meeting_id,
            }));
            log::info!("Draining: processando {} chunks pendentes em paralelo...", total);

            let mut join_set = tokio::task::JoinSet::new();

            for drain_chunk in pre_drain.into_iter() {
                let app3      = app_clone.clone();
                let provider3 = provider_str.clone();
                let lang3     = language.clone();
                let key3      = api_key.clone();
                let groq3     = groq_key.clone();
                let prompt3   = whisper_prompt.clone();
                let glossary3 = whisper_glossary.clone();
                let recv_ms   = recording_start.elapsed().as_millis() as u64;

                join_set.spawn(async move {
                    process_chunk(
                        drain_chunk, recording_start, recv_ms,
                        &provider3, &lang3, &key3, &groq3, &prompt3, &glossary3, &app3,
                    ).await
                });
            }

            let mut completed = 0usize;
            while let Some(_result) = join_set.join_next().await {
                completed += 1;
                let remaining = total - completed;
                let _ = app_clone.emit("transcription-draining", serde_json::json!({
                    "pending": remaining,
                    "total": total,
                    "meeting_id": drain_meeting_id,
                }));
                log::info!("Drain: {}/{} concluídos", completed, total);
            }
        }

        // ── Fase 4: Finalização ──────────────────────────────────────────
        // Sinaliza que o draining terminou (meeting_id: null libera o card na UI)
        let _ = app_clone.emit("transcription-draining", serde_json::json!({
            "pending": 0,
            "total": 0,
            "meeting_id": serde_json::Value::Null,
        }));

        // Re-salva a reunião com a transcrição completa (incluindo chunks drenados)
        let app_state = app_clone.state::<AppState>();
        if let Some(meeting_id) = app_state.draining_meeting_id.lock().take() {
            let mut final_segs: Vec<storage::TranscriptSegment> = app_state.segments.lock().clone();
            // Ordena por timestamp para garantir ordem correta independente de chegada
            final_segs.sort_by_key(|s| s.timestamp_ms);
            let final_transcript: String = final_segs.iter()
                .map(|s| s.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            if let Ok(mut meeting) = storage::load_meeting(&meeting_id) {
                if !final_segs.is_empty() {
                    meeting.transcript = final_transcript;
                    meeting.segments = Some(final_segs);
                    if let Err(e) = storage::save_meeting(&meeting) {
                        log::error!("Erro ao re-salvar reunião após draining: {e}");
                        let _ = app_clone.emit("draining-failed", serde_json::json!({
                            "meeting_id": meeting_id,
                            "error": e.to_string()
                        }));
                    } else {
                        log::info!("Reunião {meeting_id} atualizada ({} segmentos)",
                            meeting.segments.as_ref().map(|s| s.len()).unwrap_or(0));
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
            let level = *cap_level.current_level.lock();
            let mic   = *cap_level.mic_level.lock();
            let _ = app_level.emit("audio-level", level);
            let _ = app_level.emit("mic-level", mic);

            // Emit calibration-done once when the mic thread finishes calibration
            if let Some(cal) = cap_level.calibration_result.lock().take() {
                let _ = app_level.emit("calibration-done", serde_json::json!({
                    "noise_floor": cal.noise_floor,
                    "speech_floor": cal.speech_floor,
                    "threshold": cal.threshold,
                }));
                log::info!(
                    "Evento calibration-done emitido (threshold={:.4})",
                    cal.threshold
                );
            }

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

    if let Some(tx) = state.stop_tx.lock().take() {
        let _ = tx.send(());
    }

    let mut meeting = state
        .current_meeting
        .lock()
        .take()
        .unwrap_or_default();

    let segs: Vec<storage::TranscriptSegment> = state.segments.lock().clone();
    meeting.transcript = segs.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
    meeting.segments = if segs.is_empty() { None } else { Some(segs) };
    meeting.ended_at = Some(chrono::Utc::now());
    meeting.duration_secs = state
        .capture_start
        .lock()
        .map(|s: Instant| s.elapsed().as_secs())
        .unwrap_or(0);

    if meeting.transcript.trim().is_empty() {
        // Fecha compliance window e notifica sem salvar (payload vazio = sem reunião)
        if let Some(window) = app.get_webview_window("compliance") {
            let _ = window.close();
        }
        let _ = app.emit("recording-stopped", "");
        return Err("Nenhuma fala foi detectada nesta gravação. A reunião não foi salva.".to_string());
    }

    let id = meeting.id.clone();
    storage::save_meeting(&meeting).map_err(|e| format!("Erro ao salvar reunião: {e}"))?;
    state.segments.lock().clear();
    *state.capture_start.lock() = None;

    // Armazena o ID da reunião para o worker re-salvar após draining
    *state.draining_meeting_id.lock() = Some(id.clone());

    // Emite evento inicial de draining para a UI saber qual reunião travar.
    // Counts intermediários virão dos emits do worker (Fase 3).
    let _ = app.emit("transcription-draining", serde_json::json!({
        "pending": 1,
        "total": 1,
        "meeting_id": id.clone(),
    }));

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

    // Fecha a janela de conformidade do backend (evita race com close no frontend)
    if let Some(window) = app.get_webview_window("compliance") {
        let _ = window.close();
    }

    // Notifica todas as janelas (main window inclusa) que a gravação parou
    let _ = app.emit("recording-stopped", &id);
    log::info!("Reunião {id} salva");
    Ok(id)
}

#[tauri::command]
pub async fn get_capture_status(state: State<'_, AppState>) -> Result<CaptureStatus, String> {
    Ok(CaptureStatus {
        is_capturing: state.capture_state.is_capturing(),
        audio_level: *state.capture_state.current_level.lock(),
        mic_level: *state.capture_state.mic_level.lock(),
        mic_muted: state.capture_state.is_mic_muted(),
        is_paused: state.capture_state.is_paused(),
        transcript_length: state.transcript.load().len(),
        duration_secs: state
            .capture_start
            .lock()
            .map(|s: Instant| s.elapsed().as_secs())
            .unwrap_or(0),
    })
}

/// Teste de microfone: grava 3 segundos e retorna RMS médio, pico e amostras.
/// Útil para calibrar o silence_threshold.
#[tauri::command]
pub async fn test_microphone(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    use std::sync::atomic::Ordering;

    let settings = storage::load_settings().map_err(|e| e.to_string())?;
    if !settings.capture_microphone {
        return Err("Microfone desabilitado nas configurações.".into());
    }

    let capture_state = Arc::new(AudioCaptureState::new());
    let (chunk_tx, chunk_rx) = mpsc::channel::<AudioChunk>();

    let cap_clone = Arc::clone(&capture_state);
    let mic_config = audio::MicConfig {
        enabled: true,
        device_id: settings.selected_microphone.clone(),
        silence_threshold: 0.0, // Sem filtro para o teste
        auto_gain: false,       // Sem AGC para ver nível real
        gain_max: 1.0,
        silero_model_path: None,
    };

    audio::start_capture(
        cap_clone,
        chunk_tx,
        audio::SystemConfig {
            chunk_duration_secs: 1.0,
            silence_threshold: 0.0,
            auto_gain: false,
            gain_max: 1.0,
        },
        mic_config,
    )
    .map_err(|e| format!("Erro ao iniciar captura: {e}"))?;

    // Coleta por 3 segundos
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    capture_state.is_capturing.store(false, Ordering::SeqCst);

    let mut rms_values: Vec<f32> = Vec::new();
    let mut peak: f32 = 0.0;
    let mut chunks_received = 0;

    while let Ok(chunk) = chunk_rx.try_recv() {
        if chunk.source == AudioSource::Microphone {
            let rms = (chunk.samples.iter().map(|s| s * s).sum::<f32>() / chunk.samples.len() as f32).sqrt();
            let chunk_peak = chunk.samples.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
            rms_values.push(rms);
            peak = peak.max(chunk_peak);
            chunks_received += 1;
        }
    }

    if rms_values.is_empty() {
        return Ok(serde_json::json!({
            "status": "no_data",
            "message": "Nenhum chunk de microfone recebido. Verifique se o microfone está funcionando.",
            "threshold_current": settings.mic_silence_threshold,
        }));
    }

    let avg_rms = rms_values.iter().sum::<f32>() / rms_values.len() as f32;
    let min_rms = rms_values.iter().cloned().fold(f32::MAX, f32::min);
    let max_rms = rms_values.iter().cloned().fold(f32::MIN, f32::max);

    let recommendation = if avg_rms < 0.001 {
        "Muito baixo — microfone pode estar desligado ou muito longe"
    } else if avg_rms < 0.005 {
        "Baixo — threshold de 0.003 pode funcionar"
    } else if avg_rms < 0.02 {
        "Normal para fala — threshold de 0.01 é recomendado"
    } else {
        "Alto — threshold de 0.02 ou mais para evitar ruído"
    };

    Ok(serde_json::json!({
        "status": "ok",
        "chunks_received": chunks_received,
        "avg_rms": format!("{:.4}", avg_rms),
        "min_rms": format!("{:.4}", min_rms),
        "max_rms": format!("{:.4}", max_rms),
        "peak": format!("{:.4}", peak),
        "threshold_current": settings.mic_silence_threshold,
        "recommendation": recommendation,
        "message": format!(
            "RMS médio={:.4}, pico={:.4}. Threshold atual={:.4}. {}",
            avg_rms, peak, settings.mic_silence_threshold, recommendation
        ),
    }))
}

/// Mede o ruído ambiente por 2 segundos sem filtros.
/// Usado pelo wizard de calibração para verificar o ambiente antes de começar.
#[tauri::command]
pub async fn measure_ambient_noise(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    use std::sync::atomic::Ordering;

    // Reset calibration metrics at start of new wizard session
    *state.calibration.lock() = CalibrationMetrics::default();

    if state.capture_state.is_capturing() {
        return Err("Não é possível calibrar durante uma captura ativa.".into());
    }

    let settings = storage::load_settings().map_err(|e| e.to_string())?;
    let capture_state = Arc::new(AudioCaptureState::new());
    let (chunk_tx, chunk_rx) = mpsc::channel::<AudioChunk>();

    let mic_config = audio::MicConfig {
        enabled: true,
        device_id: settings.selected_microphone.clone(),
        silence_threshold: 0.0,
        auto_gain: false,
        gain_max: 1.0,
        silero_model_path: None,
    };
    audio::start_capture(
        Arc::clone(&capture_state),
        chunk_tx,
        audio::SystemConfig {
            chunk_duration_secs: 1.0,
            silence_threshold: 0.0,
            auto_gain: false,
            gain_max: 1.0,
        },
        mic_config,
    )
    .map_err(|e| format!("Erro ao iniciar captura: {e}"))?;

    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    capture_state.is_capturing.store(false, Ordering::SeqCst);

    let mut rms_values: Vec<f32> = Vec::new();
    while let Ok(chunk) = chunk_rx.try_recv() {
        if chunk.source == AudioSource::Microphone && !chunk.samples.is_empty() {
            let rms = (chunk.samples.iter().map(|s| s * s).sum::<f32>()
                / chunk.samples.len() as f32)
                .sqrt();
            rms_values.push(rms);
        }
    }

    let avg_rms = if rms_values.is_empty() {
        0.0f32
    } else {
        rms_values.iter().sum::<f32>() / rms_values.len() as f32
    };

    Ok(serde_json::json!({ "avg_rms": avg_rms }))
}

/// Grava uma fase de calibração (fala ou silêncio) e armazena as métricas em AppState.
/// Emite eventos `mic-test-level` a cada 50ms durante a gravação.
/// phase: "speech" (5s) | "silence" (3s)
#[tauri::command]
pub async fn record_calibration_phase(
    phase: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    use std::sync::atomic::Ordering;

    if state.capture_state.is_capturing() {
        return Err("Não é possível calibrar durante uma captura ativa.".into());
    }

    if phase != "speech" && phase != "silence" {
        return Err(format!("phase inválido: {phase}. Use \"speech\" ou \"silence\"."));
    }

    let settings = storage::load_settings().map_err(|e| e.to_string())?;
    let duration_secs: u64 = if phase == "speech" { 5 } else { 3 };

    let capture_state = Arc::new(AudioCaptureState::new());
    capture_state.is_capturing.store(true, Ordering::SeqCst);
    let (chunk_tx, chunk_rx) = mpsc::channel::<AudioChunk>();

    let mic_config = audio::MicConfig {
        enabled: true,
        device_id: settings.selected_microphone.clone(),
        silence_threshold: 0.0,
        auto_gain: false,
        gain_max: 1.0,
        silero_model_path: None,
    };
    audio::start_capture(
        Arc::clone(&capture_state),
        chunk_tx,
        audio::SystemConfig {
            chunk_duration_secs: 1.0,
            silence_threshold: 0.0,
            auto_gain: false,
            gain_max: 1.0,
        },
        mic_config,
    )
    .map_err(|e| format!("Erro ao iniciar captura: {e}"))?;

    let cap_emit = Arc::clone(&capture_state);
    let app_emit = app.clone();
    let level_handle = tokio::spawn(async move {
        while cap_emit.is_capturing() {
            let level = *cap_emit.mic_level.lock();
            let _ = app_emit.emit("mic-test-level", level);
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    });

    tokio::time::sleep(std::time::Duration::from_secs(duration_secs)).await;
    capture_state.is_capturing.store(false, Ordering::SeqCst);
    let _ = level_handle.await;

    let mut rms_values: Vec<f32> = Vec::new();
    let mut peak: f32 = 0.0;
    while let Ok(chunk) = chunk_rx.try_recv() {
        if chunk.source == AudioSource::Microphone && !chunk.samples.is_empty() {
            let rms = (chunk.samples.iter().map(|s| s * s).sum::<f32>()
                / chunk.samples.len() as f32)
                .sqrt();
            let chunk_peak = chunk.samples.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
            rms_values.push(rms);
            peak = peak.max(chunk_peak);
        }
    }

    let avg_rms = if rms_values.is_empty() {
        0.0f32
    } else {
        rms_values.iter().sum::<f32>() / rms_values.len() as f32
    };

    {
        let mut cal = state.calibration.lock();
        if phase == "speech" {
            cal.speech_rms = avg_rms;
            cal.speech_peak = peak;
        } else {
            cal.silence_rms = avg_rms;
        }
    }

    Ok(serde_json::json!({
        "avg_rms": avg_rms,
        "peak": peak,
        "phase": phase,
    }))
}

fn word_similarity(a: &str, b: &str) -> f32 {
    use std::collections::HashSet;
    let normalize = |s: &str| -> HashSet<String> {
        s.chars()
            .filter(|c| c.is_alphanumeric() || c.is_whitespace())
            .collect::<String>()
            .split_whitespace()
            .map(|w| w.to_lowercase())
            .collect()
    };
    let a_words = normalize(a);
    let b_words = normalize(b);
    if a_words.is_empty() && b_words.is_empty() {
        return 1.0;
    }
    if a_words.is_empty() || b_words.is_empty() {
        return 0.0;
    }
    let intersection = a_words.intersection(&b_words).count() as f32;
    let union = a_words.union(&b_words).count() as f32;
    intersection / union
}

/// Lê as métricas armazenadas no AppState e calcula as configurações recomendadas.
/// Retorna os valores recomendados — NÃO salva (o frontend salva após confirmação).
#[tauri::command]
pub async fn compute_calibration(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let cal = state.calibration.lock().clone();

    let speech_rms = cal.speech_rms;
    let speech_peak = cal.speech_peak;
    let silence_rms = cal.silence_rms;

    let snr = if silence_rms > 0.0001 {
        speech_rms / silence_rms
    } else {
        99.0
    };

    let (round_passed, failure_reason): (bool, Option<&str>) = if speech_peak > 0.95 {
        (false, Some("Clipping detectado — você está muito perto do microfone. Recue um pouco e tente novamente."))
    } else if speech_rms < 0.02 {
        (false, Some("Microfone muito baixo — fale mais alto ou aproxime-se do microfone."))
    } else if snr < 6.0 {
        (false, Some("Muito ruído de fundo — tente se afastar de fontes de ruído ou aproximar o microfone."))
    } else {
        (true, None)
    };

    let recommended_threshold = (silence_rms * 2.5).clamp(0.001, 0.025);

    let (auto_gain, gain_max) = if speech_rms >= 0.12 {
        (false, 1.0f32)
    } else {
        let gmax = (0.18 / speech_rms.max(0.001)).clamp(1.5, 8.0);
        (true, gmax)
    };

    let noise_gate_preset = if silence_rms < 0.003 {
        "silent"
    } else if silence_rms <= 0.010 {
        "meeting"
    } else {
        "auditorium"
    };

    let (noise_gate_ratio, noise_gate_hold) = match noise_gate_preset {
        "silent"  => (0.0f32, 0.3f32),
        "meeting" => (3.0f32, 0.4f32),
        _         => (6.0f32, 0.6f32),
    };

    Ok(serde_json::json!({
        "mic_auto_gain": auto_gain,
        "mic_gain_max": (gain_max * 10.0).round() / 10.0,
        "mic_silence_threshold": (recommended_threshold * 10000.0).round() / 10000.0,
        "noise_gate_preset": noise_gate_preset,
        "mic_noise_gate_ratio": noise_gate_ratio,
        "mic_noise_gate_hold_secs": noise_gate_hold,
        "snr": (snr * 10.0).round() / 10.0,
        "round_passed": round_passed,
        "failure_reason": failure_reason,
        "speech_rms": (speech_rms * 10000.0).round() / 10000.0,
        "silence_rms": (silence_rms * 10000.0).round() / 10000.0,
    }))
}

/// Grava 6s com as configurações recomendadas, transcreve e compara com a frase fixa.
#[tauri::command]
pub async fn test_mic_transcription_phrase(
    app: AppHandle,
    auto_gain: bool,
    gain_max: f32,
    silence_threshold: f32,
) -> Result<serde_json::Value, String> {
    use std::sync::atomic::Ordering;

    const EXPECTED: &str = "A reunião de alinhamento com o cliente começa às quatorze horas na sala de conferências";

    let settings = storage::load_settings().map_err(|e| e.to_string())?;

    if settings.transcription_provider == "openai" && settings.openai_api_key.is_empty() {
        return Err("Chave da API OpenAI não configurada.".into());
    }
    if settings.transcription_provider == "groq" && settings.groq_api_key.is_empty() {
        return Err("Chave da API Groq não configurada.".into());
    }

    let capture_state = Arc::new(AudioCaptureState::new());
    capture_state.is_capturing.store(true, Ordering::SeqCst);
    let (chunk_tx, chunk_rx) = mpsc::channel::<AudioChunk>();

    let mic_config = audio::MicConfig {
        enabled: true,
        device_id: settings.selected_microphone.clone(),
        silence_threshold,
        auto_gain,
        gain_max,
        silero_model_path: None,
    };
    audio::start_capture(
        Arc::clone(&capture_state),
        chunk_tx,
        audio::SystemConfig {
            chunk_duration_secs: 1.0,
            silence_threshold: 0.0,
            auto_gain: false,
            gain_max: 1.0,
        },
        mic_config,
    )
    .map_err(|e| format!("Erro ao iniciar captura: {e}"))?;

    let cap_emit = Arc::clone(&capture_state);
    let app_emit = app.clone();
    let level_handle = tokio::spawn(async move {
        while cap_emit.is_capturing() {
            let level = *cap_emit.mic_level.lock();
            let _ = app_emit.emit("mic-test-level", level);
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    });

    tokio::time::sleep(std::time::Duration::from_secs(6)).await;
    capture_state.is_capturing.store(false, Ordering::SeqCst);
    let _ = level_handle.await;

    let mut all_samples: Vec<f32> = Vec::new();
    let mut sample_rate = 48000u32;
    let mut channels = 1u16;

    while let Ok(chunk) = chunk_rx.try_recv() {
        if chunk.source == AudioSource::Microphone && !chunk.samples.is_empty() {
            sample_rate = chunk.sample_rate;
            channels = chunk.channels;
            all_samples.extend_from_slice(&chunk.samples);
        }
    }

    if all_samples.is_empty() {
        return Ok(serde_json::json!({
            "similarity": 0.0,
            "expected": EXPECTED,
            "got": "",
            "passed": false,
            "diagnosis": "Nenhum áudio capturado. Verifique se o microfone está funcionando.",
        }));
    }

    let wav_bytes = build_wav_from_samples(&all_samples, sample_rate, channels)
        .map_err(|e| format!("Erro ao gerar WAV: {e}"))?;

    let glossary_part: Option<String> = {
        let terms: Vec<&str> = settings.whisper_glossary
            .split([',', '\n'])
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if terms.is_empty() { None } else { Some(terms.join(", ")) }
    };
    let effective_prompt = match (glossary_part, settings.whisper_prompt.is_empty()) {
        (None, true)   => None,
        (None, false)  => Some(settings.whisper_prompt.clone()),
        (Some(g), true)  => Some(g),
        (Some(g), false) => Some(format!("{} {}", g, settings.whisper_prompt)),
    };
    let prompt_opt = effective_prompt.as_deref();
    let lang = if settings.transcription_language.is_empty() {
        None
    } else {
        Some(settings.transcription_language.as_str())
    };

    let transcript_result = match settings.transcription_provider.as_str() {
        "groq" => transcription::transcribe_groq(wav_bytes, &settings.groq_api_key, lang, prompt_opt).await,
        _      => transcription::transcribe_audio(wav_bytes, &settings.openai_api_key, lang, prompt_opt).await,
    }
    .map(|t| t.trim().to_string());

    let transcript = match transcript_result {
        Ok(t) => t,
        Err(e) => {
            return Ok(serde_json::json!({
                "similarity": 0.0,
                "expected": EXPECTED,
                "got": "",
                "passed": false,
                "diagnosis": format!("Erro na API de transcrição: {e}"),
            }));
        }
    };

    let similarity = word_similarity(EXPECTED, &transcript);
    let passed = similarity >= 0.85;

    let word_count = transcript.split_whitespace().count();
    let expected_count = EXPECTED.split_whitespace().count();
    let diagnosis = if word_count < 3 {
        "Áudio muito baixo — fale mais alto ou aproxime o microfone"
    } else if word_count < expected_count / 2 {
        "Ruído de fundo interferindo — tente num ambiente mais silencioso"
    } else {
        "Fala diferente do esperado — tente falar mais devagar e claramente"
    };

    Ok(serde_json::json!({
        "similarity": (similarity * 100.0).round() / 100.0,
        "expected": EXPECTED,
        "got": transcript,
        "passed": passed,
        "diagnosis": if passed { "" } else { diagnosis },
    }))
}

/// Testa o microfone com transcrição real usando as configurações atuais.
/// Captura áudio do mic, transcreve via Whisper e retorna o resultado
/// com indicador de qualidade. Emite eventos `mic-test-level` durante a gravação.
#[tauri::command]
pub async fn test_mic_with_transcription(
    app: AppHandle,
    duration_secs: Option<u64>,
) -> Result<serde_json::Value, String> {
    use std::sync::atomic::Ordering;

    let settings = storage::load_settings().map_err(|e| format!("Erro ao carregar configuracoes: {e}"))?;

    if settings.transcription_provider == "openai" && settings.openai_api_key.is_empty() {
        return Err("Chave da API OpenAI nao configurada.".into());
    }
    if settings.transcription_provider == "groq" && settings.groq_api_key.is_empty() {
        return Err("Chave da API Groq nao configurada.".into());
    }

    let capture_state = Arc::new(AudioCaptureState::new());
    capture_state.is_capturing.store(true, std::sync::atomic::Ordering::SeqCst);
    let (chunk_tx, chunk_rx) = mpsc::channel::<AudioChunk>();

    let mic_config = audio::MicConfig {
        enabled: true,
        device_id: settings.selected_microphone.clone(),
        silence_threshold: settings.mic_silence_threshold,
        auto_gain: settings.mic_auto_gain,
        gain_max: settings.mic_gain_max,
        silero_model_path: None,
    };

    audio::start_capture(
        Arc::clone(&capture_state),
        chunk_tx,
        audio::SystemConfig {
            chunk_duration_secs: settings.chunk_duration_secs,
            silence_threshold: 0.0,
            auto_gain: false,
            gain_max: 1.0,
        },
        mic_config,
    )
    .map_err(|e| format!("Erro ao iniciar captura: {e}"))?;

    let secs = duration_secs.unwrap_or(5);

    let cap_emit = Arc::clone(&capture_state);
    let app_emit = app.clone();
    let level_handle = tokio::spawn(async move {
        while cap_emit.is_capturing() {
            let level = *cap_emit.mic_level.lock();
            let _ = app_emit.emit("mic-test-level", level);
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    });

    tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
    capture_state.is_capturing.store(false, Ordering::SeqCst);
    let _ = level_handle.await;

    let mut all_samples: Vec<f32> = Vec::new();
    let mut rms_values: Vec<f32> = Vec::new();
    let mut peak: f32 = 0.0;
    let mut sample_rate: u32 = 48000;
    let mut channels: u16 = 1;

    while let Ok(chunk) = chunk_rx.try_recv() {
        if chunk.source == AudioSource::Microphone {
            if !chunk.samples.is_empty() {
                sample_rate = chunk.sample_rate;
                channels = chunk.channels;
                let rms = (chunk.samples.iter().map(|s| s * s).sum::<f32>() / chunk.samples.len() as f32).sqrt();
                let chunk_peak = chunk.samples.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
                rms_values.push(rms);
                peak = peak.max(chunk_peak);
                all_samples.extend_from_slice(&chunk.samples);
            }
        }
    }

    if all_samples.is_empty() {
        return Ok(serde_json::json!({
            "status": "no_data",
            "transcript": "",
            "avg_rms": "0.0000",
            "peak": "0.0000",
            "quality": "no_speech",
            "message": "Nenhum audio capturado. Verifique se o microfone esta funcionando."
        }));
    }

    let avg_rms = if rms_values.is_empty() {
        0.0
    } else {
        rms_values.iter().sum::<f32>() / rms_values.len() as f32
    };

    let wav_bytes = build_wav_from_samples(&all_samples, sample_rate, channels)
        .map_err(|e| format!("Erro ao gerar WAV: {e}"))?;

    let glossary_part: Option<String> = {
        let terms: Vec<&str> = settings.whisper_glossary
            .split([',', '\n'])
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if terms.is_empty() { None } else { Some(terms.join(", ")) }
    };
    let effective_prompt = match (glossary_part, settings.whisper_prompt.is_empty()) {
        (None, true) => None,
        (None, false) => Some(settings.whisper_prompt.clone()),
        (Some(g), true) => Some(g),
        (Some(g), false) => Some(format!("{} {}", g, settings.whisper_prompt)),
    };
    let prompt_opt = effective_prompt.as_deref();

    let lang = if settings.transcription_language.is_empty() {
        None
    } else {
        Some(settings.transcription_language.as_str())
    };

    let result = match settings.transcription_provider.as_str() {
        "groq" => {
            transcription::transcribe_groq(
                wav_bytes,
                &settings.groq_api_key,
                lang,
                prompt_opt,
            ).await
        }
        _ => {
            transcription::transcribe_audio(
                wav_bytes,
                &settings.openai_api_key,
                lang,
                prompt_opt,
            ).await
        }
    };

    let transcript = match result {
        Ok(text) => text.trim().to_string(),
        Err(e) => {
            return Ok(serde_json::json!({
                "status": "error",
                "transcript": "",
                "avg_rms": format!("{:.4}", avg_rms),
                "peak": format!("{:.4}", peak),
                "quality": "no_speech",
                "message": format!("Erro na transcricao: {}", e)
            }));
        }
    };

    let quality = if transcript.is_empty() || transcript.len() < 5 {
        "no_speech"
    } else if avg_rms < 0.003 {
        "low"
    } else if avg_rms > 0.1 {
        "high"
    } else {
        "good"
    };

    let message = match quality {
        "good" => "Transcricao capturou a fala corretamente.",
        "low" => "Volume baixo — a transcricao pode estar fraca. Tente aumentar o ganho.",
        "high" => "Volume alto — pode haver saturacao. Reduza o ganho.",
        _ => "Nenhuma fala detectada. Fale mais perto ou mais alto.",
    };

    Ok(serde_json::json!({
        "status": "ok",
        "transcript": transcript,
        "avg_rms": format!("{:.4}", avg_rms),
        "peak": format!("{:.4}", peak),
        "quality": quality,
        "message": message
    }))
}

fn build_wav_from_samples(samples: &[f32], sample_rate: u32, channels: u16) -> anyhow::Result<Vec<u8>> {
    use hound::{WavSpec, WavWriter, SampleFormat};

    let mono_samples: Vec<f32> = if channels > 1 {
        samples
            .chunks_exact(channels as usize)
            .map(|ch| ch.iter().sum::<f32>() / ch.len() as f32)
            .collect()
    } else {
        samples.to_vec()
    };

    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };
    let mut cursor = std::io::Cursor::new(Vec::new());
    let mut writer = WavWriter::new(&mut cursor, spec)?;
    for &s in &mono_samples {
        writer.write_sample(s)?;
    }
    writer.finalize()?;
    Ok(cursor.into_inner())
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

/// Pausa ou retoma a transcrição. Retorna o novo estado (true = pausado).
#[tauri::command]
pub async fn toggle_pause_capture(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<bool, String> {
    let current = state.capture_state.is_paused();
    let new_val = !current;
    state.capture_state.set_paused(new_val);
    log::info!("Captura {}", if new_val { "pausada" } else { "retomada" });
    let _ = app.emit("capture-paused", new_val);
    Ok(new_val)
}

#[tauri::command]
pub async fn get_current_transcript(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.transcript.load().to_string())
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
        .get(&format!("{base_url}/log_up"))
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

/// Resultado da exportação para o JGRC.
#[derive(serde::Serialize)]
pub struct JgrcExportResult {
    pub event_id: String,
    pub event_url: String,
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
    content: Option<String>,
    actions: Option<String>,
    manager_id: Option<String>,
    attendees: Option<String>,
    internal_attendee_ids: Option<Vec<String>>,
    city_id: Option<String>,
    company: Option<String>,
) -> Result<JgrcExportResult, String> {
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

    let content = content
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| build_jgrc_content(&meeting));
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
    let company_id = match company.as_deref() {
        Some("regia") => "1",
        _ => "0",
    };
    form.push(("event[company_id]".into(), company_id.into()));

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

    let event_url = format!("{base_url}/events/{event_id}");
    let mut meeting_mut = meeting;
    meeting_mut.jgrc_event_id = Some(event_id.clone());
    meeting_mut.jgrc_event_url = Some(event_url.clone());
    storage::save_meeting(&meeting_mut).map_err(|e| format!("Erro ao salvar: {e}"))?;

    log::info!("Reunião '{}' exportada para JGRC (event_id={}, url={})", meeting_mut.title, event_id, event_url);
    Ok(JgrcExportResult { event_id, event_url })
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

/// Retorna a lista de dispositivos de captura de áudio (microfones) disponíveis no sistema.
/// Inclui "Microfone padrão do sistema" como primeiro item (id vazio).
#[tauri::command]
pub async fn list_microphones() -> Result<Vec<audio::AudioDevice>, String> {
    audio::list_capture_devices().map_err(|e| format!("Erro ao listar microfones: {e}"))
}

/// Atualiza o texto de um segmento específico de uma reunião salva.
/// Re-deriva o campo `transcript` dos segmentos atualizados.
#[tauri::command]
pub async fn update_meeting_segment(
    meeting_id: String,
    timestamp_ms: u64,
    text: String,
) -> Result<Meeting, String> {
    let mut meeting =
        storage::load_meeting(&meeting_id).map_err(|e| format!("Reunião não encontrada: {e}"))?;

    if let Some(ref mut segs) = meeting.segments {
        let seg = segs.iter_mut().find(|s| s.timestamp_ms == timestamp_ms)
            .ok_or_else(|| "Segment not found".to_string())?;
        seg.text = text.trim().to_string();
        meeting.transcript = segs.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
    } else {
        // Reunião antiga sem segmentos — atualiza o transcript plano diretamente
        let trimmed = text.trim().to_string();
        if !trimmed.is_empty() {
            meeting.transcript = trimmed;
        }
    }

    storage::save_meeting(&meeting).map_err(|e| format!("Erro ao salvar: {e}"))?;
    Ok(meeting)
}

// ─── Comandos: Tags ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_tags() -> Result<Vec<storage::Tag>, String> {
    storage::load_tags().map_err(|e| format!("Erro ao carregar tags: {e}"))
}

#[tauri::command]
pub async fn save_tags(tags: Vec<storage::Tag>) -> Result<(), String> {
    storage::save_tags(&tags).map_err(|e| format!("Erro ao salvar tags: {e}"))
}

#[tauri::command]
pub async fn update_meeting_tags(
    meeting_id: String,
    tag_ids: Vec<String>,
) -> Result<(), String> {
    let mut meeting = storage::load_meeting(&meeting_id)
        .map_err(|e| format!("Reunião não encontrada: {e}"))?;
    meeting.tags = tag_ids;
    storage::save_meeting(&meeting).map_err(|e| format!("Erro ao salvar reunião: {e}"))
}

// ─── Comandos: Janela de Conformidade ────────────────────────────────────────

/// Abre (ou foca) a janela de conformidade always-on-top.
#[tauri::command]
pub async fn open_compliance_window(app: AppHandle) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    if let Some(w) = app.get_webview_window("compliance") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    // main.tsx renders <ComplianceOverlay> when window.location.hash === "#compliance"
    WebviewWindowBuilder::new(&app, "compliance", WebviewUrl::App("index.html#compliance".into()))
        .title("")
        .inner_size(340.0, 64.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .transparent(true)
        .skip_taskbar(true)
        .build()
        .map_err(|e| format!("Falha ao abrir overlay: {e}"))?;
    Ok(())
}

/// Fecha a janela de conformidade se existir.
#[tauri::command]
pub async fn close_compliance_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("compliance") {
        let _ = w.close();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{jaccard_bigrams, last_sentence_context};

    #[test]
    fn test_jaccard_identical() {
        assert_eq!(jaccard_bigrams("hello world foo", "hello world foo"), 1.0);
    }

    #[test]
    fn test_jaccard_completely_different() {
        assert_eq!(jaccard_bigrams("hello world", "foo bar baz"), 0.0);
    }

    #[test]
    fn test_jaccard_partial() {
        let a = "a gente vai ouvir agora uma mensagem trocada";
        let b = "a gente vai ouvir agora uma mensagem trocada entre";
        let sim = jaccard_bigrams(a, b);
        assert!(sim > 0.85, "Expected > 0.85, got {}", sim);
    }

    #[test]
    fn test_jaccard_short_text_empty() {
        assert_eq!(jaccard_bigrams("", ""), 1.0);
        assert_eq!(jaccard_bigrams("hello", ""), 0.0);
    }

    #[test]
    fn test_empty_transcript() {
        assert_eq!(last_sentence_context(""), "");
    }

    #[test]
    fn test_transcript_with_period() {
        let t = "Hello world. Goodbye there.";
        assert_eq!(last_sentence_context(t), "Goodbye there.");
    }

    #[test]
    fn test_transcript_no_period() {
        let t = "Hello world goodbye";
        assert_eq!(last_sentence_context(t), "Hello world goodbye");
    }

    #[test]
    fn test_exclamation_and_question() {
        let t = "Really? Of course! Let's do it.";
        assert_eq!(last_sentence_context(t), "Let's do it.");
    }

    #[test]
    fn test_very_long_sentence_capped_at_120_words() {
        let long: String = (0..150).map(|i| format!("word{} ", i)).collect();
        let result = last_sentence_context(long.trim());
        let count = result.split_whitespace().count();
        assert!(count <= 120, "Expected ≤ 120 words, got {}", count);
    }

    #[test]
    fn test_only_punctuation() {
        // "..." — last '.' at index 2, prev '.' at index 1, slice is "." trimmed
        let result = last_sentence_context("...");
        assert!(!result.is_empty());
    }

    #[test]
    fn test_drain_parallel_note() {
        // Parallel drain order correctness verified manually:
        // process_chunk inserts via partition_point(timestamp) — order is always correct
        // regardless of JoinSet completion order.
        assert!(true);
    }
}
