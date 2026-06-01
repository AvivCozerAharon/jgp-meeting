# Melhorias na transcrição — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aplicar 3 melhorias no pipeline de transcrição — (1) `SmartChunker` no microfone, (2) `verbose_json` com filtros probabilísticos e lista de hallucinations configurável, (3) resample do WAV para 16kHz mono i16 antes de enviar à API.

**Architecture:** Mudanças contidas em `src-tauri/src/audio/mod.rs` (thread do mic), `src-tauri/src/transcription/mod.rs` (response parsing) e `src-tauri/src/commands.rs` (worker de transcrição). Novo campo em `AppSettings` com `#[serde(default)]` para migração transparente. Sem mudança de UI nesta fase.

**Tech Stack:** Rust + Tauri (backend), serde_json para verbose_json, hound para WAV, Rubato para resample (já em uso).

**Spec:** `docs/superpowers/specs/2026-05-31-melhorias-transcricao-design.md`

---

## File Structure

**Modify:**
- `src-tauri/src/storage/mod.rs` — adiciona `hallucination_patterns` em `AppSettings` + default
- `src-tauri/src/transcription/mod.rs` — troca para `verbose_json`, novo struct `TranscriptionResult`, mantém wrappers `String`
- `src-tauri/src/commands.rs` — `process_chunk` usa resultado verbose + gates probabilísticos + lista configurável; thread do mic usa `SmartChunker`; `to_wav_bytes_whisper()` no envio à API
- `src-tauri/src/audio/mod.rs` — thread do mic refatorada para usar `SmartChunker` com config dedicada

**No new files.** Tudo é alteração em código existente.

---

## Task 1: Adicionar `hallucination_patterns` em `AppSettings`

Migra a lista hardcoded de `commands.rs:61-89` para um campo configurável em `AppSettings`, com a lista atual como default via `#[serde(default)]`.

**Files:**
- Modify: `src-tauri/src/storage/mod.rs`

- [ ] **Step 1: Adicionar o campo `hallucination_patterns` ao struct `AppSettings`**

Edite `src-tauri/src/storage/mod.rs`. Localize o bloco de `whisper_glossary` (linhas ~244-247) e adicione **logo depois**:

```rust
    /// Padrões (substring, case-insensitive) que indicam hallucination do Whisper.
    /// Se qualquer padrão aparecer no texto transcrito, o segmento é descartado.
    /// Default inclui padrões comuns em PT-BR e EN (ex: "se inscreva", "thanks for watching").
    #[serde(default = "default_hallucination_patterns")]
    pub hallucination_patterns: Vec<String>,
```

- [ ] **Step 2: Adicionar a função `default_hallucination_patterns`**

Edite `src-tauri/src/storage/mod.rs`. Após `fn default_language() -> String { ... }` (linha ~343), adicione:

```rust
fn default_hallucination_patterns() -> Vec<String> {
    vec![
        "inscrever no canal".into(),
        "ativar as notificac".into(),
        "se inscreva".into(),
        "obrigado por assistir".into(),
        "thanks for watching".into(),
        "subscribe to the channel".into(),
        "don't forget to subscribe".into(),
        "like and subscribe".into(),
        "smash the like button".into(),
        "leave a comment".into(),
        "click the link".into(),
        "check out the description".into(),
        "follow me on".into(),
        "background music".into(),
        "no copyright".into(),
        "royalty free".into(),
        "(applause)".into(),
        "(laughter)".into(),
        "(music)".into(),
        "sponsored by".into(),
        "vou me despedir".into(),
        "ate o proximo video".into(),
        "nos vemos no proximo".into(),
        "obrigado pela atencao".into(),
        "muito obrigado a todos".into(),
        "esse video foi".into(),
        "esse e o meu canal".into(),
    ]
}
```

- [ ] **Step 3: Popular o campo no `with_defaults`**

Edite `src-tauri/src/storage/mod.rs`, dentro de `AppSettings::with_defaults()` (linha ~352). Localize a linha de `whisper_glossary: "...".to_string(),` (linha ~383) e adicione **logo depois**:

```rust
            hallucination_patterns: default_hallucination_patterns(),
```

- [ ] **Step 4: Compilar para validar**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compila sem erros (warnings ok).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/storage/mod.rs
git commit -m "feat(storage): adiciona hallucination_patterns configurável em AppSettings"
```

---

## Task 2: Refatorar transcrição para `verbose_json`

Troca `response_format=text` por `verbose_json`, adiciona `temperature=0`, expõe `TranscriptionResult` com `no_speech_prob` e `avg_logprob`. Os atalhos `transcribe_audio` / `transcribe_groq` continuam retornando `Result<String>` (test commands usam assim), e ganhamos versões `_verbose` que retornam o struct completo.

**Files:**
- Modify: `src-tauri/src/transcription/mod.rs`

- [ ] **Step 1: Adicionar test que valida o parsing de `verbose_json`**

Edite `src-tauri/src/transcription/mod.rs`. **No final do arquivo**, adicione:

```rust
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
```

- [ ] **Step 2: Rodar os tests novos — devem falhar (tipos não existem ainda)**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p jgp-meeting --lib transcription`
Expected: erros de compilação ("cannot find type `WhisperVerboseResponse`", etc.)

- [ ] **Step 3: Adicionar tipos `WhisperVerboseResponse`, `WhisperSegment`, `TranscriptionResult`**

Edite `src-tauri/src/transcription/mod.rs`. Localize a seção `// ─── Tipos internos ───` (linha ~14) e **substitua** todo o bloco de tipos até antes de `// ─── API Whisper` por:

```rust
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
```

- [ ] **Step 4: Rodar tests — devem passar**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p jgp-meeting --lib transcription`
Expected: os 2 tests novos passam (junto com os de `retry.rs` que já existem).

- [ ] **Step 5: Atualizar `transcribe_whisper_single` para `verbose_json` + temperatura 0**

Edite `src-tauri/src/transcription/mod.rs`. **Substitua** o corpo de `transcribe_whisper_single` (linhas ~75-133) por:

```rust
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
```

- [ ] **Step 6: Atualizar a assinatura do retry helper**

Edite `src-tauri/src/transcription/retry.rs`. Localize `pub async fn retry_transcription` (linha ~170). **Substitua** o retorno `anyhow::Result<String>` por `anyhow::Result<T>` genérico:

```rust
pub async fn retry_transcription<T, F>(
    config: RetryConfig,
    mut operation: F,
) -> anyhow::Result<T>
where
    F: FnMut() -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, TranscriptionError>> + Send>> + Send,
{
    let mut backoff = ExponentialBackoff::new(config);
    loop {
        match operation().await {
            Ok(value) => return Ok(value),
            Err(TranscriptionError::Permanent(msg)) => {
                return Err(anyhow::anyhow!("{}", msg));
            }
            Err(TranscriptionError::Retryable(msg)) => {
                if let Some(delay) = backoff.next_delay() {
                    log::warn!(
                        "Retryable transcription error (attempt {}): {}, retrying in {:?}",
                        backoff.attempt(),
                        msg,
                        delay
                    );
                    tokio::time::sleep(delay).await;
                } else {
                    return Err(anyhow::anyhow!(
                        "Transcription failed after {} retries: {}",
                        backoff.attempt(),
                        msg
                    ));
                }
            }
        }
    }
}
```

Note: o test `test_retry_transcription_permanent_no_retry` e `test_retry_transcription_retryable_retries` em `retry.rs:280-310` continuam válidos pois o `T` infere como `String` ali.

- [ ] **Step 7: Atualizar `transcribe_whisper_compatible` para retornar `TranscriptionResult`**

Edite `src-tauri/src/transcription/mod.rs`. **Substitua** o corpo de `transcribe_whisper_compatible` (linhas ~35-73) por:

```rust
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
```

- [ ] **Step 8: Atualizar atalhos `transcribe_audio` e `transcribe_groq`**

Edite `src-tauri/src/transcription/mod.rs`. **Substitua** ambas as funções (linhas ~136-171) por:

```rust
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
```

- [ ] **Step 9: Rodar a suíte completa de tests do módulo de transcrição**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p jgp-meeting --lib transcription`
Expected: todos os tests passam (parsing + retry).

- [ ] **Step 10: Compilar o crate inteiro para garantir consumidores não quebraram**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compila. Os consumidores em `commands.rs` continuam usando `transcribe_audio`/`transcribe_groq` que ainda retornam `Result<String>` — sem mudança forçada nesta task.

- [ ] **Step 11: Commit**

```bash
git add src-tauri/src/transcription/
git commit -m "feat(transcription): migra para verbose_json com TranscriptionResult"
```

---

## Task 3: Worker usa filtros probabilísticos + lista configurável + `to_wav_bytes_whisper`

Migra `process_chunk` para a nova API verbose, aplica gates probabilísticos, troca a lista hardcoded por `settings.hallucination_patterns`, e troca o formato do WAV enviado à API.

**Files:**
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: Remover `is_whisper_hallucination` (lista hardcoded vai pra settings)**

Edite `src-tauri/src/commands.rs`. **Apague** completamente a função `is_whisper_hallucination` (linhas ~51-101). A função `is_known_filler` (linhas ~40-49) **permanece**.

- [ ] **Step 2: Adicionar helper de checagem por padrões configuráveis**

Edite `src-tauri/src/commands.rs`. No lugar de `is_whisper_hallucination` removida (logo após `is_known_filler`), insira:

```rust
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
```

- [ ] **Step 3: Atualizar `process_chunk` para usar verbose + gates + lista configurável**

Edite `src-tauri/src/commands.rs`, dentro da função `process_chunk` aninhada em `start_capture`. Localize o bloco de chamada à API e processamento do resultado (linhas ~346-464). **Substitua** o bloco:

```rust
            let result = match provider {
                "groq" => {
                    transcription::transcribe_groq(wav_bytes, groq_key, Some(language), prompt_opt).await
                }
                _ => {
                    transcription::transcribe_audio(wav_bytes, api_key, Some(language), prompt_opt).await
                }
            };

            let got_text = match result {
                Ok(text) if !text.is_empty() => {
                    if is_whisper_hallucination(&text, &chunk.source) {
                        log::debug!("Hallucination descartado: {:?}", &text[..text.len().min(60)]);
                        false
                    } else {
                    let is_filler = chunk.source == AudioSource::Microphone && {
                        let trimmed = text.trim();
                        let len = trimmed.chars().count();
                        len < 5 || is_known_filler(trimmed)
                    };
```

Por:

```rust
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
```

Também ajuste o branch `Ok(_)` logo abaixo do `is_filler`/dedup (procure `Ok(_) => {` próximo da linha ~455). **Substitua**:

```rust
                Ok(_) => {
                    log::debug!("Chunk transcrito como vazio (source={:?})", chunk.source);
                    false
                }
```

Por:

```rust
                Ok(_) => {
                    log::debug!("Chunk transcrito como vazio (source={:?})", chunk.source);
                    false
                }
```

(Sem mudança — apenas confirme que o padrão de matching `Ok(tr) if !tr.text.is_empty()` cobre o caso "vazio" caindo aqui.)

- [ ] **Step 4: Trocar `to_wav_bytes` por `to_wav_bytes_whisper` no envio à API**

Edite `src-tauri/src/commands.rs`, linha **301**. **Substitua**:

```rust
            let wav_bytes = match chunk.to_wav_bytes() {
```

Por:

```rust
            let wav_bytes = match chunk.to_wav_bytes_whisper() {
```

- [ ] **Step 5: Compilar o crate**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compila sem erros. Pode haver warnings sobre `is_known_filler` ainda ser usado (é).

- [ ] **Step 6: Rodar a suíte de tests do backend**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: todos os tests passam.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(transcription): gates probabilísticos + lista de hallucinations configurável + WAV 16kHz mono"
```

---

## Task 4: Microfone usa `SmartChunker`

Substitui o loop de chunks fixos do microfone por uma instância de `SmartChunker` com configuração otimizada para mic (latência menor, pausas mais curtas).

**Files:**
- Modify: `src-tauri/src/audio/mod.rs`

- [ ] **Step 1: Adicionar test que valida config do mic produz chunks ≤ 10s**

Edite `src-tauri/src/audio/chunker.rs`. No bloco `#[cfg(test)] mod tests { ... }`, **adicione** após os tests existentes (antes do `}` final do módulo):

```rust
    #[test]
    fn test_mic_config_max_duration_is_10s() {
        // Mic config (hardcoded em audio/mod.rs): max_chunk_secs = 10.0
        let mut chunker = SmartChunker::new(
            ChunkerConfig {
                min_chunk_secs: 1.5,
                max_chunk_secs: 10.0,
                silence_break_secs: 0.5,
                vad_sensitivity: 0.55,
            },
            16000,
            1,
        );

        // Empurra 12s de áudio contínuo de fala (senoide) — deve forçar chunk em 10s.
        let mut speech = Vec::new();
        for i in 0..(16000 * 12) {
            let t = i as f32 / 16000.0;
            speech.push((440.0 * t * 2.0 * std::f32::consts::PI).sin() * 0.5);
        }

        // Empurra em blocos de 1600 samples (100ms) para simular streaming.
        let mut produced_chunk: Option<SpeechChunk> = None;
        for block in speech.chunks(1600) {
            if let Some(chunk) = chunker.push(block) {
                produced_chunk = Some(chunk);
                break;
            }
        }

        let chunk = produced_chunk.expect("Deveria produzir chunk ao atingir 10s");
        assert!(
            chunk.duration_secs <= 10.5, // pequena tolerância de 1 bloco
            "Chunk de mic deve respeitar max=10s, mas teve {:.2}s",
            chunk.duration_secs
        );
    }
```

- [ ] **Step 2: Rodar o test — deve passar (testa apenas a config, não o uso em mod.rs)**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib audio::chunker`
Expected: PASS.

- [ ] **Step 3: Refatorar a thread do microfone para usar `SmartChunker`**

Edite `src-tauri/src/audio/mod.rs`. Localize o loop de captura do microfone na thread iniciada em ~`thread::spawn(move || unsafe {` (linha ~378), dentro do bloco que começa em "── Loop de captura do microfone (pipeline independente) ──" (linha ~493).

**Substitua** todo o trecho a partir do comentário `// ── Loop de captura do microfone (pipeline independente) ──` (linha ~493) até **antes** do comentário `// ── Flush final do microfone ──` (linha ~585) por:

```rust
            // ── Loop de captura do microfone (pipeline independente) ──────────
            // Usa SmartChunker para cortar em pausas naturais (mesma estratégia
            // do loopback do sistema). Defaults otimizados para microfone:
            // chunks menores → feedback mais rápido para o usuário.
            let mic_chunker_config = chunker::ChunkerConfig {
                min_chunk_secs: 1.5,
                max_chunk_secs: 10.0,
                silence_break_secs: 0.5,
                vad_sensitivity: 0.55,
            };
            let mut mic_chunker = chunker::SmartChunker::new(mic_chunker_config, mic_sr, mic_ch);

            log::info!(
                "Mic config: chunker(min=1.5s, max=10s, break=0.5s, vad=0.55), silence={:.4}, agc={}, gain_max={:.1}",
                mic_silence,
                mic_agc,
                mic_gain_max
            );

            while state_mic.is_capturing() {
                let pkt = match capture_client.GetNextPacketSize() {
                    Ok(n) => n,
                    Err(_) => {
                        thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                };
                if pkt == 0 {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                }

                let mut p_data: *mut u8 = std::ptr::null_mut();
                let mut num_frames: u32 = 0;
                let mut flags: u32 = 0;

                if capture_client
                    .GetBuffer(&mut p_data, &mut num_frames, &mut flags, None, None)
                    .is_ok()
                {
                    let is_silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;

                    if !is_silent && !p_data.is_null() && num_frames > 0 {
                        let raw =
                            std::slice::from_raw_parts(p_data, num_frames as usize * mic_align);
                        let samples = bytes_to_f32(raw, mic_bps);
                        let rms = compute_rms(&samples);
                        {
                            let mut lvl = state_mic.mic_level.lock();
                            *lvl = (*lvl * 0.7 + rms * 0.3).min(1.0);
                        }

                        // Envia ao chunker — produz chunk em pausas naturais ou no max.
                        if let Some(speech_chunk) = mic_chunker.push(&samples) {
                            if state_mic.is_mic_muted() {
                                // Descarta silenciosamente quando mic está muted.
                            } else {
                                let mut chunk_data = speech_chunk.samples;

                                // Silence gate por RMS (segunda camada, complementar ao VAD).
                                let chunk_rms = compute_rms(&chunk_data);
                                if chunk_rms < mic_silence {
                                    log::debug!(
                                        "Mic: chunk silencioso (RMS={:.4} < {:.4}), descartado",
                                        chunk_rms,
                                        mic_silence
                                    );
                                } else {
                                    // AGC aplicado DEPOIS do silence check (só em áudio com fala).
                                    if mic_agc {
                                        apply_auto_gain(&mut chunk_data, mic_gain_max);
                                    }

                                    log::debug!("Mic: chunk enviado (RMS={:.4}, dur={:.2}s)", chunk_rms, speech_chunk.duration_secs);
                                    let chunk = AudioChunk {
                                        samples: chunk_data,
                                        sample_rate: mic_sr,
                                        channels: mic_ch,
                                        duration_secs: speech_chunk.duration_secs,
                                        source: AudioSource::Microphone,
                                    };
                                    if mic_tx.send(chunk).is_err() {
                                        log::warn!("Mic: canal fechado, encerrando captura");
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    // Frames com AUDCLNT_BUFFERFLAGS_SILENT: NÃO empurra zeros ao chunker.

                    let _ = capture_client.ReleaseBuffer(num_frames);
                }
            }

```

- [ ] **Step 4: Atualizar o flush final do microfone para usar `SmartChunker::flush`**

Edite `src-tauri/src/audio/mod.rs`. Localize o bloco `// ── Flush final do microfone ──` (após o loop acabado de substituir). **Substitua** todo o bloco que começa em `// ── Flush final do microfone ─────────────────────────────────────` e termina em `let _ = audio_client.Stop(); log::info!("Microfone encerrado");` por:

```rust
            // ── Flush final do microfone ─────────────────────────────────────
            // Drena o que sobrou no SmartChunker (pode haver chunks pendentes
            // que não atingiram pausa natural antes do stop).
            while let Some(speech_chunk) = mic_chunker.flush() {
                let mut chunk_data = speech_chunk.samples;
                let actual_duration = speech_chunk.duration_secs;

                if actual_duration < 0.3 {
                    continue;
                }

                let rms = compute_rms(&chunk_data);
                if rms < mic_silence {
                    log::debug!("Mic flush descartado (silencioso, RMS={:.4})", rms);
                    continue;
                }

                if mic_agc {
                    apply_auto_gain(&mut chunk_data, mic_gain_max);
                }

                log::info!(
                    "Mic flush final: enviando {:.2}s de áudio restante ({} amostras)",
                    actual_duration,
                    chunk_data.len()
                );
                let chunk = AudioChunk {
                    samples: chunk_data,
                    sample_rate: mic_sr,
                    channels: mic_ch,
                    duration_secs: actual_duration,
                    source: AudioSource::Microphone,
                };
                let _ = mic_tx.send(chunk);
            }

            let _ = audio_client.Stop();
            log::info!("Microfone encerrado");
```

- [ ] **Step 5: Compilar e rodar tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: tudo passa. O test novo `test_mic_config_max_duration_is_10s` valida o comportamento esperado.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/audio/mod.rs src-tauri/src/audio/chunker.rs
git commit -m "feat(audio): microfone usa SmartChunker com defaults dedicados"
```

---

## Task 5: Validação manual de fim-a-fim

Antes de marcar a feature como completa, fazer uma sessão de gravação real para validar comportamento conjunto.

**Files:** nenhuma alteração — verificação manual.

- [ ] **Step 1: Build do app em release**

Run: `cd src-tauri && cargo build --release`
Expected: build sem erros.

- [ ] **Step 2: Rodar o app**

Run: `cd .. && npm run tauri dev`
Expected: app inicia normalmente.

- [ ] **Step 3: Cenários de validação**

Grave uma reunião de ~60s com seu microfone, intercalando:

1. **Fala normal continua** (~15s) — esperado: chunks de mic chegando a cada ~1.5-3s (pausas naturais entre frases), não 5s fixos.
2. **Pausa de 1s** seguida de **frase curta** ("Obrigado, Pedro") — esperado: a frase curta aparece na transcrição (antes, seria descartada pela regra `< 4 palavras = hallucination`).
3. **Áudio de YouTube/podcast no sistema** (~15s) — esperado: transcrição do loopback funciona normal.
4. **Forçar 1 hallucination** falando "se inscreva no canal" claramente — esperado: descartada (lista configurável carregada da settings).

- [ ] **Step 4: Inspecionar logs**

Verifique no console do app:
- `Mic: chunk enviado (RMS=..., dur=X.XXs)` — `dur` deve variar (não fixo).
- `Low-quality descartado (no_speech_prob=..., avg_logprob=...)` ou `Hallucination pattern descartado` quando aplicável.
- Nenhum erro de parsing de `verbose_json`.

- [ ] **Step 5: Validar redução de payload (opcional, via DevTools/network monitor)**

Se possível, inspecione o tamanho de um POST para `/audio/transcriptions`. Esperado: ~10× menor que antes (16kHz mono i16 vs 48kHz mono float32).

- [ ] **Step 6: Se tudo ok, fechar a feature**

Sem mais commits — a feature está pronta. Se houver ajustes finos (ex: thresholds de `no_speech_prob`/`avg_logprob` muito agressivos ou permissivos demais), criar issue/task separada.

---

## Self-Review

Spec coverage:
- ✅ #1 (mic SmartChunker) — Task 4.
- ✅ #2 (verbose_json, gates probabilísticos, lista configurável) — Tasks 1, 2, 3.
- ✅ #3 (to_wav_bytes_whisper) — Task 3 Step 4.
- ✅ Compatibilidade (serde default, sem mudança em UI/schema) — Task 1.
- ✅ Testes unitários novos: `parses_verbose_json_response`, `parses_verbose_json_without_segments`, `test_mic_config_max_duration_is_10s`.
- ✅ Validação manual — Task 5.

Sem placeholders. Tipos consistentes (`TranscriptionResult`, `WhisperVerboseResponse`, `WhisperSegment` referenciados igual em todas as tasks).
