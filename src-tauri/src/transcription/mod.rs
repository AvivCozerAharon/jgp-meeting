/// transcription/mod.rs
/// Serviço de transcrição de áudio.
/// Suporta múltiplos providers:
///   - OpenAI Whisper API
///   - Groq Whisper (API compatível com OpenAI, modelo whisper-large-v3-turbo)
///   - Whisper local via whisper.cpp subprocess (Feature 7)
use anyhow::{Context, Result};
use reqwest::multipart;
use serde::Deserialize;

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

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .context("Falha ao criar cliente HTTP")?;

    let mut form = multipart::Form::new()
        .text("model", model.to_string())
        .text("response_format", "text")
        .part(
            "file",
            multipart::Part::bytes(wav_bytes)
                .file_name("audio.wav")
                .mime_str("audio/wav")
                .context("Mime type inválido")?,
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
        .context("Falha ao chamar API Whisper")?;

    let status = response.status();

    if status.is_success() {
        let text = response.text().await.context("Falha ao ler resposta")?;
        Ok(text.trim().to_string())
    } else {
        let body = response.text().await.unwrap_or_default();
        if let Ok(err) = serde_json::from_str::<OpenAIError>(&body) {
            Err(anyhow::anyhow!("Whisper ({}): {}", status, err.error.message))
        } else {
            Err(anyhow::anyhow!("Whisper ({}): {}", status, body))
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

// ─── Feature 7: Whisper local via whisper.cpp ─────────────────────────────────

/// Transcreve áudio usando um executável whisper.cpp local.
pub async fn transcribe_local(
    wav_bytes: Vec<u8>,
    whisper_exe: &str,
    model_path: &str,
    language: &str,
) -> Result<String> {
    if wav_bytes.len() < 1024 {
        return Ok(String::new());
    }

    if whisper_exe.is_empty() {
        return Err(anyhow::anyhow!(
            "Caminho do executável whisper.cpp não configurado"
        ));
    }

    if whisper_exe.to_lowercase().ends_with(".bin") {
        return Err(anyhow::anyhow!(
            "O campo 'Executável whisper-cli' aponta para um arquivo .bin (modelo).\n\
             Configure o caminho para o whisper-cli.exe, não para o modelo.\n\
             Baixe em: https://github.com/ggerganov/whisper.cpp/releases"
        ));
    }

    let wav_path = std::env::temp_dir().join(format!(
        "jgp-whisper-{}.wav",
        uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or("tmp")
    ));
    std::fs::write(&wav_path, &wav_bytes)
        .context("Falha ao escrever WAV temporário")?;

    let txt_path = wav_path.with_extension("wav.txt");

    let exe_dir = std::path::Path::new(whisper_exe)
        .parent()
        .unwrap_or(std::path::Path::new("."));

    let model_arg = if std::path::Path::new(model_path).is_absolute()
        || std::path::Path::new(model_path).exists()
    {
        model_path.to_string()
    } else {
        let app_model = crate::storage::models_dir()
            .ok()
            .map(|d| d.join(format!("ggml-{}.bin", model_path)))
            .filter(|p| p.exists());

        if let Some(path) = app_model {
            path.to_string_lossy().to_string()
        } else {
            exe_dir
                .join("models")
                .join(format!("ggml-{}.bin", model_path))
                .to_string_lossy()
                .to_string()
        }
    };

    log::info!(
        "Whisper local: exe={} model={} wav={}",
        whisper_exe,
        model_arg,
        wav_path.display()
    );

    let wav_str = wav_path.to_string_lossy().to_string();
    let mut args = vec!["-m", &model_arg, "-f", &wav_str];
    if !language.is_empty() && language != "auto" {
        args.extend_from_slice(&["-l", language]);
    }

    let output = tokio::process::Command::new(whisper_exe)
        .args(&args)
        .output()
        .await
        .context(format!("Falha ao executar whisper-cli: {whisper_exe}"))?;

    let stderr_str = String::from_utf8_lossy(&output.stderr);
    if !stderr_str.is_empty() {
        log::debug!("Whisper stderr ({} bytes): {}", stderr_str.len(),
            &stderr_str.chars().take(500).collect::<String>());
    }

    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let _ = std::fs::remove_file(&wav_path);
        return Err(anyhow::anyhow!(
            "whisper-cli saiu com código {:?}\nstdout: {}\nstderr: {}",
            output.status.code(),
            stdout.trim(),
            stderr_str.trim()
        ));
    }

    let raw = if txt_path.exists() {
        std::fs::read_to_string(&txt_path).unwrap_or_default()
    } else {
        String::from_utf8_lossy(&output.stdout).to_string()
    };

    log::debug!("Whisper stdout bruto ({} bytes): {:?}", raw.len(), &raw.chars().take(300).collect::<String>());

    let text: String = raw
        .lines()
        .filter_map(|l| {
            let trimmed = l.trim();
            if trimmed.is_empty() {
                return None;
            }
            if trimmed.starts_with('[') {
                if let Some(close) = trimmed.rfind(']') {
                    let after = trimmed[close + 1..].trim();
                    if !after.is_empty() {
                        return Some(after.to_string());
                    }
                }
                return None;
            }
            if trimmed.contains("whisper_") || trimmed.starts_with("main:") || trimmed.starts_with("system_info") {
                return None;
            }
            Some(trimmed.to_string())
        })
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();

    let _ = std::fs::remove_file(&txt_path);
    let _ = std::fs::remove_file(&wav_path);

    log::info!("Whisper local: {} chars transcritos", text.len());
    Ok(text)
}
