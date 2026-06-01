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

/// Segmento individual retornado pela API Whisper em `verbose_json`.
#[derive(Debug, Clone, Deserialize)]
pub struct WhisperSegment {
    #[serde(default)]
    pub start: f32,
    #[serde(default)]
    pub end: f32,
    pub text: String,
    #[serde(default)]
    pub no_speech_prob: f32,
    #[serde(default)]
    pub avg_logprob: f32,
}

/// Resposta crua do Whisper em formato `verbose_json` (estrutura de deserialização).
#[derive(Debug, Deserialize)]
pub struct WhisperVerboseResponse {
    pub text: String,
    #[serde(default)]
    pub segments: Vec<WhisperSegment>,
}

/// Resultado processado de uma transcrição, com sinais de qualidade agregados.
#[derive(Debug, Clone)]
pub struct TranscriptionResult {
    pub text: String,
    /// Máximo `no_speech_prob` entre os segments (pior caso de "não há fala").
    pub no_speech_prob: f32,
    /// Mínimo `avg_logprob` entre os segments (pior caso de "confiança baixa").
    pub avg_logprob: f32,
    pub segments: Vec<WhisperSegment>,
}

impl TranscriptionResult {
    /// Constrói o resultado agregado a partir da resposta verbose do Whisper.
    /// Quando `segments` está vazio, `no_speech_prob` e `avg_logprob` ficam em 0.0
    /// (efetivamente permissivo — não descarta nada por probabilidade).
    pub fn from_verbose(resp: WhisperVerboseResponse) -> Self {
        let no_speech_prob = resp.segments.iter()
            .map(|s| s.no_speech_prob)
            .fold(0.0f32, f32::max);
        let avg_logprob = if resp.segments.is_empty() {
            0.0
        } else {
            resp.segments.iter()
                .map(|s| s.avg_logprob)
                .fold(f32::INFINITY, f32::min)
        };
        let avg_logprob = if avg_logprob.is_finite() { avg_logprob } else { 0.0 };
        Self {
            text: resp.text.trim().to_string(),
            no_speech_prob,
            avg_logprob,
            segments: resp.segments,
        }
    }
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
) -> Result<TranscriptionResult> {
    if wav_bytes.len() < 1024 {
        return Ok(TranscriptionResult {
            text: String::new(),
            no_speech_prob: 0.0,
            avg_logprob: 0.0,
            segments: Vec::new(),
        });
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
) -> Result<TranscriptionResult, retry::TranscriptionError> {
    let client = http_client::get_long_client();

    let mut form = multipart::Form::new()
        .text("model", model.to_string())
        .text("response_format", "verbose_json")
        .text("temperature", "0")
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
        let body = response.text().await.map_err(|e| {
            retry::TranscriptionError::Retryable(format!("Falha ao ler resposta: {e}"))
        })?;
        let parsed: WhisperVerboseResponse = serde_json::from_str(&body)
            .map_err(|e| retry::TranscriptionError::Permanent(
                format!("Resposta verbose_json inválida: {e} — body: {}", &body[..body.len().min(200)])
            ))?;
        Ok(TranscriptionResult::from_verbose(parsed))
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

/// Atalho para OpenAI Whisper — retorna apenas o texto (test commands legados).
pub async fn transcribe_audio(
    wav_bytes: Vec<u8>,
    api_key: &str,
    language: Option<&str>,
    prompt: Option<&str>,
) -> Result<String> {
    transcribe_audio_verbose(wav_bytes, api_key, language, prompt)
        .await
        .map(|r| r.text)
}

/// Versão verbose para OpenAI Whisper — retorna `TranscriptionResult` com probabilidades.
pub async fn transcribe_audio_verbose(
    wav_bytes: Vec<u8>,
    api_key: &str,
    language: Option<&str>,
    prompt: Option<&str>,
) -> Result<TranscriptionResult> {
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

/// Transcreve áudio via Groq — retorna apenas o texto (test commands legados).
pub async fn transcribe_groq(
    wav_bytes: Vec<u8>,
    api_key: &str,
    language: Option<&str>,
    prompt: Option<&str>,
) -> Result<String> {
    transcribe_groq_verbose(wav_bytes, api_key, language, prompt)
        .await
        .map(|r| r.text)
}

/// Versão verbose para Groq — retorna `TranscriptionResult` com probabilidades.
pub async fn transcribe_groq_verbose(
    wav_bytes: Vec<u8>,
    api_key: &str,
    language: Option<&str>,
    prompt: Option<&str>,
) -> Result<TranscriptionResult> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_verbose_json_response() {
        let body = r#"{
            "text": "olá mundo",
            "segments": [
                { "start": 0.0, "end": 1.0, "text": "olá", "no_speech_prob": 0.05, "avg_logprob": -0.3 },
                { "start": 1.0, "end": 2.0, "text": " mundo", "no_speech_prob": 0.10, "avg_logprob": -0.5 }
            ]
        }"#;
        let parsed: WhisperVerboseResponse = serde_json::from_str(body).unwrap();
        let result = TranscriptionResult::from_verbose(parsed);
        assert_eq!(result.text, "olá mundo");
        assert!((result.no_speech_prob - 0.10).abs() < 1e-6, "deve usar máximo entre segments");
        assert!((result.avg_logprob - (-0.5)).abs() < 1e-6, "deve usar mínimo entre segments");
        assert_eq!(result.segments.len(), 2);
    }

    #[test]
    fn parses_verbose_json_without_segments() {
        // Groq pode omitir segments em respostas curtas.
        let body = r#"{ "text": "oi" }"#;
        let parsed: WhisperVerboseResponse = serde_json::from_str(body).unwrap();
        let result = TranscriptionResult::from_verbose(parsed);
        assert_eq!(result.text, "oi");
        assert_eq!(result.no_speech_prob, 0.0);
        assert_eq!(result.avg_logprob, 0.0);
    }
}

