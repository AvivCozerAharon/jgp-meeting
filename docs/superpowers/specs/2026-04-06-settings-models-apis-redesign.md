# Settings Redesign — Aba "Modelos & APIs"

**Data:** 2026-04-06  
**Status:** Aprovado

## Contexto

A tela de configurações atual mistura dois conceitos independentes — provider de transcrição e modelo de resumo — num mesmo fluxo, com lógica condicional complexa para API keys. O resultado é confuso: a mesma chave OpenAI aparece em contextos diferentes, o Google Cloud STT está presente mas pouco usado, e não há suporte a OpenRouter para resumos.

## Objetivo

Separar claramente os dois pipelines (transcrição e resumo) numa nova aba dedicada, simplificar os providers suportados e adicionar suporte a OpenRouter para resumos.

## Design

### Estrutura de abas

**Antes:** `config | shortcuts | jgrc`  
**Depois:** `config | modelos & apis | shortcuts | jgrc`

### Aba "config" (conteúdo restante)

Mantém apenas configurações gerais:
- Aparência / Tema
- Capturar Microfone (device, AGC, sensibilidade, intervalo)
- Sensibilidade ao Silêncio (sistema)
- Prompt de Contexto (Whisper)
- Tipo de Reunião Padrão
- Auto-resumo
- Compliance

### Aba "Modelos & APIs"

#### Bloco 1 — Transcrição

Selector visual com 3 botões:
```
[ OpenAI Whisper ]  [ Groq ]  [ Local ]
```

Campos condicionais por provider:

| Provider | Campos exibidos |
|----------|----------------|
| OpenAI   | `openai_api_key` + idioma + intervalo de chunk |
| Groq     | `groq_api_key` + idioma + intervalo de chunk |
| Local    | path `local_whisper_exe` + modelo ggml + idioma + intervalo de chunk |

**Google Cloud STT é removido.**

#### Bloco 2 — Resumos com IA

Selector visual com 2 botões:
```
[ OpenAI ]  [ OpenRouter ]
```

| Provider    | Campos exibidos |
|-------------|----------------|
| OpenAI      | Reusa `openai_api_key` (se já preenchido na transcrição, não duplica) + dropdown de modelos GPT |
| OpenRouter  | `openrouter_api_key` + input de modelo com sugestões populares |

Modelos GPT disponíveis (OpenAI):
- `gpt-4o-mini` (padrão)
- `gpt-4o`
- `gpt-4-turbo`
- `gpt-3.5-turbo`

Sugestões OpenRouter (input livre, não restrito):
- `openai/gpt-4o-mini`
- `openai/gpt-4o`
- `anthropic/claude-haiku-4-5`
- `anthropic/claude-sonnet-4-5`
- `meta-llama/llama-3.1-8b-instruct:free`
- `google/gemini-flash-1.5`

Se o usuário tiver OpenAI selecionado em ambos os blocos, o campo `openai_api_key` é exibido uma única vez (no bloco de Transcrição) com nota indicando que também é usado para resumos.

## Mudanças no AppSettings (TypeScript + Rust)

### Adicionar
- `openrouter_api_key: string` — chave do OpenRouter
- `summary_provider: string` — "openai" | "openrouter"

### Remover
- `google_cloud_api_key`
- opção `"google_cloud"` em `transcription_provider`

### Manter
- `openai_api_key` — usado para transcrição (OpenAI) e/ou resumo (OpenAI)
- `summary_model` — armazena o model ID (funciona tanto para GPT quanto para OpenRouter)
- `groq_api_key`, `transcription_provider`, `local_whisper_*` — sem alteração

## Mudanças no Backend (Rust)

- Remover branch `google_cloud` em `transcription/mod.rs` e `commands.rs`
- Adicionar `openrouter_api_key` e `summary_provider` na struct `AppSettings` em `storage/mod.rs`
- Atualizar chamada de resumo para usar OpenRouter API quando `summary_provider == "openrouter"` (endpoint: `https://openrouter.ai/api/v1/chat/completions`, header `Authorization: Bearer <openrouter_api_key>`)

## Componentes a modificar

| Arquivo | Mudança |
|---------|---------|
| `src/types/index.ts` | Adiciona `openrouter_api_key`, `summary_provider`; remove `google_cloud_api_key` |
| `src/components/SettingsModal.tsx` | Nova aba + reorganização dos blocos |
| `src-tauri/src/storage/mod.rs` | Atualiza struct `AppSettings` |
| `src-tauri/src/commands.rs` | Remove Google Cloud; atualiza lógica de resumo |
| `src-tauri/src/transcription/mod.rs` | Remove branch Google Cloud |

## Migração de dados

Usuários existentes com `transcription_provider == "google_cloud"` terão o valor migrado para `"openai"` no carregamento das configurações (fallback silencioso).
