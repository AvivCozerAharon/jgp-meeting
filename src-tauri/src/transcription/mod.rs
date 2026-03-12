/// transcription/mod.rs
/// Serviço de transcrição de áudio.
/// Suporta dois modos:
///   - API Whisper (OpenAI) — padrão
///   - Whisper local via whisper.cpp subprocess — Feature 7
use anyhow::{Context, Result};
use reqwest::multipart;
use serde::Deserialize;

// ─── Tipos internos ───────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct WhisperResponse {
    text: String,
}

#[derive(Debug, Deserialize)]
struct OpenAIError {
    error: OpenAIErrorDetail,
}

#[derive(Debug, Deserialize)]
struct OpenAIErrorDetail {
    message: String,
}

// ─── API Whisper (OpenAI) ─────────────────────────────────────────────────────

/// Envia bytes WAV para a API Whisper e retorna o texto transcrito.
pub async fn transcribe_audio(
    wav_bytes: Vec<u8>,
    api_key: &str,
    language: Option<&str>,
) -> Result<String> {
    if wav_bytes.len() < 1024 {
        return Ok(String::new());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .context("Falha ao criar cliente HTTP")?;

    let mut form = multipart::Form::new()
        .text("model", "whisper-1")
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

    let response = client
        .post("https://api.openai.com/v1/audio/transcriptions")
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

// ─── Feature 7: Whisper local via whisper.cpp ─────────────────────────────────

/// Transcreve áudio usando um executável whisper.cpp local.
///
/// # Requisitos
/// - `whisper_exe`: caminho para `whisper-cli.exe` (whisper.cpp releases no GitHub)
/// - `model_path`: caminho ou nome do modelo ggml (ex: "base", "small", ou path completo)
/// - O executável precisa estar acessível no caminho informado
///
/// # Comportamento
/// Salva o WAV em um arquivo temporário, executa o whisper.cpp como subprocess,
/// lê a saída e remove os temporários.
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

    // Detecta configuração errada: usuário apontou para um .bin (modelo) em vez do exe
    if whisper_exe.to_lowercase().ends_with(".bin") {
        return Err(anyhow::anyhow!(
            "O campo 'Executável whisper-cli' aponta para um arquivo .bin (modelo).\n\
             Configure o caminho para o whisper-cli.exe, não para o modelo.\n\
             Baixe em: https://github.com/ggerganov/whisper.cpp/releases"
        ));
    }

    // Cria arquivo WAV temporário.
    // IMPORTANTE: No Windows, NamedTempFile mantém o file handle aberto, impedindo
    // o whisper-cli.exe de ler o arquivo. Usamos std::fs::write que fecha o handle
    // imediatamente após a escrita.
    let wav_path = std::env::temp_dir().join(format!(
        "jgp-whisper-{}.wav",
        uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or("tmp")
    ));
    std::fs::write(&wav_path, &wav_bytes)
        .context("Falha ao escrever WAV temporário")?;

    let txt_path = wav_path.with_extension("wav.txt");

    // Resolve o caminho do modelo:
    //   - Se for nome curto (ex: "base", "small"), procura no diretório do executável
    //   - Se for path completo, usa diretamente
    let exe_dir = std::path::Path::new(whisper_exe)
        .parent()
        .unwrap_or(std::path::Path::new("."));

    let model_arg = if std::path::Path::new(model_path).is_absolute()
        || std::path::Path::new(model_path).exists()
    {
        model_path.to_string()
    } else {
        // 1) Verifica no diretório de modelos baixados pelo app (AppData/models/)
        let app_model = crate::storage::models_dir()
            .ok()
            .map(|d| d.join(format!("ggml-{}.bin", model_path)))
            .filter(|p| p.exists());

        if let Some(path) = app_model {
            path.to_string_lossy().to_string()
        } else {
            // 2) Fallback: procura em models/ relativo ao diretório do exe
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

    // Executa whisper.cpp como subprocess.
    // Usa apenas flags universais (-m, -f, -l) para máxima compatibilidade entre builds.
    // Saída principal: stdout (texto transcrito).
    // Arquivo .wav.txt é gerado automaticamente em algumas builds com -otxt; tentamos ler
    // tanto o arquivo quanto o stdout para cobrir todos os casos.
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

    // Log do stderr (diagnóstico do whisper: modelo carregado, processamento, etc.)
    let stderr_str = String::from_utf8_lossy(&output.stderr);
    if !stderr_str.is_empty() {
        log::debug!("Whisper stderr ({} bytes): {}", stderr_str.len(),
            &stderr_str.chars().take(500).collect::<String>());
    }

    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Remove o WAV temporário antes de retornar erro
        let _ = std::fs::remove_file(&wav_path);
        return Err(anyhow::anyhow!(
            "whisper-cli saiu com código {:?}\nstdout: {}\nstderr: {}",
            output.status.code(),
            stdout.trim(),
            stderr_str.trim()
        ));
    }

    // Lê resultado: prefere arquivo .wav.txt (criado por alguns builds),
    // caso contrário usa stdout diretamente.
    let raw = if txt_path.exists() {
        std::fs::read_to_string(&txt_path).unwrap_or_default()
    } else {
        String::from_utf8_lossy(&output.stdout).to_string()
    };

    // Log do stdout bruto (apenas em debug) para diagnóstico de formato de saída
    log::debug!("Whisper stdout bruto ({} bytes): {:?}", raw.len(), &raw.chars().take(300).collect::<String>());

    // O whisper.cpp emite o texto em dois formatos dependendo do build:
    //   Formato A: "[00:00:00.000 --> 00:00:02.560]   texto aqui"  (texto na mesma linha do timestamp)
    //   Formato B: "[00:00:00.000 --> 00:00:02.560]\n texto aqui"  (texto na linha seguinte)
    //
    // Estratégia:
    //   - Linhas com '[': extrai o texto APÓS o ']' (Formato A)
    //   - Linhas sem '[': mantém se não forem metadados do whisper.cpp
    let text: String = raw
        .lines()
        .filter_map(|l| {
            let trimmed = l.trim();
            if trimmed.is_empty() {
                return None;
            }
            if trimmed.starts_with('[') {
                // Formato A: extrai o texto após o último ']'
                if let Some(close) = trimmed.rfind(']') {
                    let after = trimmed[close + 1..].trim();
                    if !after.is_empty() {
                        return Some(after.to_string());
                    }
                }
                // Linha só com timestamp (Formato B) — descarta, próxima linha terá o texto
                return None;
            }
            // Filtra linhas de diagnóstico emitidas pelo próprio whisper.cpp
            if trimmed.contains("whisper_") || trimmed.starts_with("main:") || trimmed.starts_with("system_info") {
                return None;
            }
            // Linha de texto puro (Formato B ou texto plano do .wav.txt)
            Some(trimmed.to_string())
        })
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();

    // Remove arquivos temporários
    let _ = std::fs::remove_file(&txt_path);
    let _ = std::fs::remove_file(&wav_path);

    log::info!("Whisper local: {} chars transcritos", text.len());
    Ok(text)
}

// ─── Utilitário ───────────────────────────────────────────────────────────────

pub fn validate_api_key(api_key: &str) -> bool {
    !api_key.is_empty() && api_key.starts_with("sk-") && api_key.len() > 20
}
