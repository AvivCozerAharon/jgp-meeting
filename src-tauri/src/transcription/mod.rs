/// transcription/mod.rs
/// Serviço de transcrição de áudio.
/// Suporta múltiplos providers:
///   - OpenAI Whisper API
///   - Groq Whisper (API compatível com OpenAI, modelo whisper-large-v3-turbo)
pub mod retry;

use anyhow::Result;
use reqwest::multipart;
use serde::Deserialize;

use crate::http_client;

// ─── Tipos internos ───────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct OpenAIError {
    error: OpenAIErrorDetail,
}

#[derive(Debug, Deserialize)]
struct OpenAIErrorDetail {
    message: String,
}

// ─── API Whisper (OpenAI / Groq — compatível) ──────────────────────────────

/// Envia bytes WAV para uma API compatível com Whisper (OpenAI ou Groq).
/// Usa connection pooling e retry automático com backoff exponencial.
///
/// # Parâmetros
/// - `endpoint_url`: URL completa da API (ex: `https://api.openai.com/v1/audio/transcriptions`)
/// - `model`: nome do modelo (ex: `whisper-1`, `whisper-large-v3-turbo`)
/// - `prompt`: texto de contexto opcional para guiar o modelo Whisper.
pub async fn transcribe_whisper_compatible(
    wav_bytes: Vec<u8>,
    api_key: &str,
    endpoint_url: &str,
    model: &str,
    language: Option<&str>,
    prompt: Option<&str>,
) -> Result<String> {
    if wav_bytes.len() < 1024 {
        return Ok(String::new());
    }

    let config = retry::RetryConfig {
        max_retries: 3,
        initial_delay_ms: 200,
        max_delay_ms: 5000,
        multiplier: 2.0,
    };

    retry::retry_transcription(config, || {
        let wav_bytes = wav_bytes.clone();
        let api_key = api_key.to_string();
        let endpoint_url = endpoint_url.to_string();
        let model = model.to_string();
        let language = language.map(|s| s.to_string());
        let prompt = prompt.map(|s| s.to_string());

        Box::pin(async move {
            transcribe_whisper_single(
                wav_bytes,
                &api_key,
                &endpoint_url,
                &model,
                language.as_deref(),
                prompt.as_deref(),
            ).await
        })
    }).await
}

async fn transcribe_whisper_single(
    wav_bytes: Vec<u8>,
    api_key: &str,
    endpoint_url: &str,
    model: &str,
    language: Option<&str>,
    prompt: Option<&str>,
) -> Result<String, retry::TranscriptionError> {
    let client = http_client::get_long_client();

    let mut form = multipart::Form::new()
        .text("model", model.to_string())
        .text("response_format", "text")
        .part(
            "file",
            multipart::Part::bytes(wav_bytes)
                .file_name("audio.wav")
                .mime_str("audio/wav")
                .map_err(|e| retry::TranscriptionError::Permanent(format!("Mime type inválido: {e}")))?,
        );

    if let Some(lang) = language {
        if !lang.is_empty() {
            form = form.text("language", lang.to_string());
        }
    }

    if let Some(p) = prompt {
        if !p.is_empty() {
            form = form.text("prompt", p.to_string());
        }
    }

    let response = client
        .post(endpoint_url)
        .header("Authorization", format!("Bearer {api_key}"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| retry::TranscriptionError::Retryable(format!("Falha ao chamar API Whisper: {e}")))?;

    let status = response.status();

    if status.is_success() {
        let text = response.text().await.map_err(|e| {
            retry::TranscriptionError::Retryable(format!("Falha ao ler resposta: {e}"))
        })?;
        Ok(text.trim().to_string())
    } else {
        let body = response.text().await.unwrap_or_default();
        let msg = format!("Whisper ({}): {}", status, body);
        let code = status.as_u16();
        if code == 429 || code >= 500 {
            Err(retry::TranscriptionError::Retryable(msg))
        } else {
            Err(retry::TranscriptionError::Permanent(msg))
        }
    }
}

/// Atalho para OpenAI Whisper (mantém compatibilidade com código existente)
pub async fn transcribe_audio(
    wav_bytes: Vec<u8>,
    api_key: &str,
    language: Option<&str>,
    prompt: Option<&str>,
) -> Result<String> {
    transcribe_whisper_compatible(
        wav_bytes,
        api_key,
        "https://api.openai.com/v1/audio/transcriptions",
        "whisper-1",
        language,
        prompt,
    )
    .await
}

// ─── Groq Whisper ────────────────────────────────────────────────────────────

/// Transcreve áudio usando a API Groq (Whisper large-v3-turbo, rápida e gratuita).
pub async fn transcribe_groq(
    wav_bytes: Vec<u8>,
    api_key: &str,
    language: Option<&str>,
    prompt: Option<&str>,
) -> Result<String> {
    transcribe_whisper_compatible(
        wav_bytes,
        api_key,
        "https://api.groq.com/openai/v1/audio/transcriptions",
        "whisper-large-v3-turbo",
        language,
        prompt,
    )
    .await
}

