# Melhorias na transcrição — Fase 1

**Data:** 2026-05-31
**Escopo:** 3 melhorias contidas no pipeline de transcrição (mic chunker, verbose_json, resample pré-envio)

## Motivação

Revisão do pipeline atual revelou três pontos de melhoria com alto impacto e baixo risco:

1. O microfone usa chunks de duração fixa enquanto o áudio do sistema usa `SmartChunker` (VAD com detecção de pausas naturais). Isso degrada a qualidade da transcrição do áudio mais relevante (a voz do usuário), que é cortado no meio de frases.
2. A API Whisper é chamada com `response_format=text`, descartando sinais de qualidade úteis (`no_speech_prob`, `avg_logprob`). A detecção de hallucinations hoje depende de uma lista hardcoded em PT/EN que está em código, não nas settings.
3. O áudio é enviado à API no sample rate nativo do dispositivo (~48kHz stereo→mono float32). O Whisper reamostra internamente para 16kHz mono — o payload extra é desperdício de upload e custo de banda.

## Design

### 1. SmartChunker no microfone

Atualmente em `src-tauri/src/audio/mod.rs`, a thread do microfone (linhas ~494-583) acumula um buffer fixo de `mic_chunk_target` samples e dispara um chunk quando enche. Substituir essa lógica por uma instância de `SmartChunker` com configuração dedicada ao microfone:

```rust
let mic_chunker_config = chunker::ChunkerConfig {
    min_chunk_secs: 1.5,
    max_chunk_secs: 10.0,
    silence_break_secs: 0.5,
    vad_sensitivity: 0.55,
};
```

Justificativa dos defaults (diferentes do sistema, que usa 2.0/15.0/0.7/0.5):
- `min/max` menores → menor latência de feedback (você quer ver suas palavras rápido).
- `silence_break` menor → fala direta tem pausas mais curtas que diálogos do sistema.
- `vad_sensitivity` ligeiramente maior → mic captura mais ruído ambiente.

Os defaults são **hardcoded** nesta fase (não expostos em settings). Se futuramente houver demanda, viram configuráveis.

Comportamento preservado:
- Check de `is_mic_muted` antes de enviar chunk.
- AGC aplicado **depois** do silence gate (só em áudio com fala real).
- Gate de RMS via `mic_silence_threshold` continua válido como segunda camada.
- Flush final no encerramento da thread.

### 2. `verbose_json` + filtros probabilísticos + lista configurável

**`src-tauri/src/transcription/mod.rs`:**

- Trocar `response_format=text` por `response_format=verbose_json` em `transcribe_whisper_single`.
- Adicionar `temperature=0` (reduz alucinações sem custo).
- Definir novo struct de retorno:

```rust
#[derive(Debug, Clone, Deserialize)]
pub struct WhisperSegment {
    pub start: f32,
    pub end: f32,
    pub text: String,
    pub no_speech_prob: f32,
    pub avg_logprob: f32,
}

#[derive(Debug, Clone)]
pub struct TranscriptionResult {
    pub text: String,
    pub no_speech_prob: f32,      // máximo entre segments
    pub avg_logprob: f32,         // mínimo entre segments
    pub segments: Vec<WhisperSegment>,
}
```

- `transcribe_audio`, `transcribe_groq`, `transcribe_whisper_compatible` retornam `Result<TranscriptionResult>` em vez de `Result<String>`.
- Quando a API retornar campos ausentes (Groq pode omitir alguns), tratamos como `0.0` para prob e `0.0` para logprob (efetivamente permissivo).

**`src-tauri/src/commands.rs` — `process_chunk`:**

Substituir o uso de `is_whisper_hallucination()` por uma pipeline de filtros, nesta ordem:

1. **Quality gate probabilístico:**
   - Se `result.no_speech_prob > 0.6` → descarta.
   - Se `result.avg_logprob < -1.0` → descarta.
2. **Pattern gate configurável:**
   - Lê `settings.hallucination_patterns: Vec<String>` (carregado uma vez por chunk via `app_state`).
   - Se qualquer pattern (case-insensitive substring) bate no texto → descarta.
3. **Filler gate (mantido):**
   - `is_known_filler()` continua aplicado a chunks de microfone curtos (< 5 chars).
   - **Remove** a regra atual de "mic com < 4 palavras é hallucination" — substituída pelos gates probabilísticos acima.
4. **Dedup (mantido):** Jaccard bigrams como hoje.

**`src-tauri/src/storage/`:**

Adicionar campo em `AppSettings`:

```rust
#[serde(default = "default_hallucination_patterns")]
pub hallucination_patterns: Vec<String>,

fn default_hallucination_patterns() -> Vec<String> {
    vec![
        "inscrever no canal".into(),
        "ativar as notificac".into(),
        "se inscreva".into(),
        "obrigado por assistir".into(),
        "thanks for watching".into(),
        // ... (lista completa migrada de commands.rs:61-89)
    ]
}
```

Migration: como o campo tem `#[serde(default)]`, settings antigas no disco recebem a lista default automaticamente ao serem deserializadas. Sem migration explícita.

A função `is_whisper_hallucination()` em `commands.rs:51-101` é removida (sua lógica vira pattern matching contra `settings.hallucination_patterns` + os gates probabilísticos). O check de "unique_words ratio < 0.5" (loop de palavra) também é removido — `avg_logprob` cobre esse caso melhor.

**UI:** sem mudança nesta fase. Quando quiser expor, é uma textarea como o `whisper_glossary` atual.

### 3. Resample para 16kHz mono i16 antes do envio

Em `src-tauri/src/commands.rs`, substituir `chunk.to_wav_bytes()` por `chunk.to_wav_bytes_whisper()` em todos os pontos onde o WAV é montado para envio à API:

- `process_chunk` (linha ~301)
- `transcribe_mic_test_audio` (linha ~815)
- Outros test commands (~906, ~986, ~1172, ~1321)

A função `to_wav_bytes_whisper()` já existe (`audio/mod.rs:100-120`), já é testada, e usa o resampler Rubato de alta qualidade. Nenhuma outra mudança necessária.

`to_wav_bytes()` permanece no código (pode ser útil para debug/export de áudio no formato nativo).

## Testes

**Unitários (novos):**

- `chunker.rs`: adicionar test que valida `max_chunk_secs=10.0` para config do mic (chunks de mic nunca passam de 10s).
- `transcription/mod.rs`: test de parsing de resposta `verbose_json` mockada, extraindo `no_speech_prob` e `avg_logprob` corretamente. Test de tolerância a campos ausentes (Groq).

**Unitários (atualizar):**

- Tests existentes em `chunker.rs` e `vad.rs` continuam válidos (sem mudança de interface).
- Tests em `transcription/retry.rs` continuam válidos (retry é independente do response_format).

**Validação manual:**

1. Gravar 30s misturando: fala normal + silêncio de 1s + filler ("é") + frase curta legítima ("Obrigado, Pedro").
2. Verificar:
   - Chunks de mic respeitam pausa de 0.5s (não cortam no meio de frase).
   - Hallucinations conhecidas (ex: "se inscreva no canal") continuam descartadas.
   - "Obrigado, Pedro" (3 palavras) **não** é mais descartado (substituído pelo gate probabilístico).
   - Frases longas claras (`avg_logprob` alto) passam sem problema.

## Compatibilidade

- **Schema em disco:** `TranscriptSegment` salvo em reuniões não muda. Reuniões antigas abrem normalmente.
- **Settings:** novo campo `hallucination_patterns` é opcional via `#[serde(default)]`. Settings antigas no disco recebem default ao deserializar.
- **UI:** sem breaking change. Painel de transcrição não é afetado.
- **Provedores:** OpenAI Whisper e Groq Whisper aceitam `verbose_json` e `temperature`. Sem mudança na API contract.

## Fora de escopo (próximas fases)

- Migrar para Silero VAD (item #6 do diagnóstico).
- Paralelizar drain após stop (item #5).
- Reduzir/limitar contexto acumulado em 120 palavras (item #4).
- Expor `hallucination_patterns` na UI das settings.
- Fallback automático OpenAI ↔ Groq quando um falha.
- Virtualização da lista de segments no painel.
