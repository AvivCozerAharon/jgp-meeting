# Settings Redesign — Modelos & APIs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar aba "Modelos & APIs" com blocos separados para Transcrição (OpenAI/Groq/Local) e Resumos (OpenAI/OpenRouter), removendo Google Cloud STT.

**Architecture:** Novos campos `openrouter_api_key` e `summary_provider` adicionados ao `AppSettings` (Rust + TS). O módulo `ai/mod.rs` recebe parâmetro `endpoint: &str` para suportar OpenRouter. Comandos Tauri expõem `base_url: Option<String>`. Frontend deriva key+endpoint a partir de `settings.summary_provider`.

**Tech Stack:** Rust (Tauri/Serde), React/TypeScript, Tailwind CSS, reqwest

---

## File Map

| Arquivo | Mudança |
|---------|---------|
| `src-tauri/src/storage/mod.rs` | Adiciona `openrouter_api_key`, `summary_provider`; mantém `google_cloud_api_key` com serde(default) |
| `src-tauri/src/ai/mod.rs` | Adiciona `endpoint: &str` a `call_gpt_inner`, `call_gpt`, `call_gpt_text` e todas as funções públicas de IA |
| `src-tauri/src/commands.rs` | Remove google_cloud, adiciona `base_url: Option<String>` aos comandos de resumo, corrige auto-summary |
| `src-tauri/src/transcription/mod.rs` | Remove `transcribe_google_cloud` |
| `src/types/index.ts` | Adiciona `openrouter_api_key`, `summary_provider`; remove `google_cloud_api_key` |
| `src/services/aiSummaryService.ts` | Adiciona `baseUrl?: string` a todas as funções |
| `src/hooks/useTranscription.ts` | Deriva key+endpoint por `summary_provider` |
| `src/hooks/useMeetingHistory.ts` | Idem |
| `src/components/JgrcExportModal.tsx` | Idem |
| `src/components/FollowupEmail.tsx` | Adiciona `baseUrl?: string` prop e passa ao invoke |
| `src/pages/SettingsPage.tsx` | Adiciona aba "modelos" |
| `src/components/SettingsModal.tsx` | Adiciona tab "modelos", reorganiza, remove google_cloud UI |

---

### Task 1: Rust — Atualizar AppSettings (storage/mod.rs)

**Files:**
- Modify: `src-tauri/src/storage/mod.rs`

- [ ] **Step 1: Adicionar campos novos após `google_cloud_api_key`**

Em `src-tauri/src/storage/mod.rs`, substituir o bloco do `google_cloud_api_key` (linha ~113) adicionando os novos campos:

```rust
    /// API key do Google Cloud (legado — mantido apenas para não quebrar settings.json existente)
    #[serde(default)]
    pub google_cloud_api_key: String,

    /// API key do OpenRouter (para geração de resumos com qualquer modelo)
    #[serde(default)]
    pub openrouter_api_key: String,

    /// Provider usado para geração de resumos: "openai" | "openrouter"
    #[serde(default = "default_summary_provider")]
    pub summary_provider: String,
```

- [ ] **Step 2: Adicionar função default**

Após `fn default_transcription_provider()` (linha ~247), adicionar:

```rust
fn default_summary_provider() -> String {
    "openai".to_string()
}
```

- [ ] **Step 3: Adicionar campos ao `with_defaults()`**

No bloco `with_defaults()` (linha ~290), após `google_cloud_api_key: String::new(),`, adicionar:

```rust
            openrouter_api_key: String::new(),
            summary_provider: "openai".to_string(),
```

- [ ] **Step 4: Build para verificar**

```bash
cd src-tauri && cargo check 2>&1 | head -30
```

Esperado: sem erros relacionados a `AppSettings`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/storage/mod.rs
git commit -m "feat(storage): add openrouter_api_key and summary_provider to AppSettings"
```

---

### Task 2: TypeScript — Atualizar AppSettings (types/index.ts)

**Files:**
- Modify: `src/types/index.ts`

- [ ] **Step 1: Substituir `google_cloud_api_key` pelos novos campos**

No bloco `AppSettings` em `src/types/index.ts`, substituir:

```ts
  /** API key do Google Cloud STT */
  google_cloud_api_key: string;
```

Por:

```ts
  /** API key do OpenRouter (resumos com qualquer modelo) */
  openrouter_api_key: string;
  /** Provider de resumos: "openai" | "openrouter" */
  summary_provider: string;
```

- [ ] **Step 2: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(types): add openrouter_api_key and summary_provider, remove google_cloud_api_key"
```

---

### Task 3: Rust — Suporte a OpenRouter em ai/mod.rs

**Files:**
- Modify: `src-tauri/src/ai/mod.rs`

- [ ] **Step 1: Adicionar `endpoint: &str` a `call_gpt_inner`**

Substituir a assinatura de `call_gpt_inner` (linha ~138):

```rust
async fn call_gpt_inner(
    system: &str,
    user: &str,
    api_key: &str,
    model: &str,
    max_tokens: u32,
    json_mode: bool,
    endpoint: &str,
) -> Result<String> {
```

No corpo, substituir a URL hardcoded e adicionar headers do OpenRouter:

```rust
    let mut req = client
        .post(endpoint)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json");

    // Headers específicos do OpenRouter
    if endpoint.contains("openrouter.ai") {
        req = req
            .header("HTTP-Referer", "https://jgp-meeting.app")
            .header("X-Title", "JGP Meeting");
    }

    let resp = req
        .json(&body)
        .send()
        .await
        .context("Falha ao chamar API")?;
```

- [ ] **Step 2: Atualizar `call_gpt` e `call_gpt_text` para propagar `endpoint`**

```rust
async fn call_gpt(
    system: &str,
    user: &str,
    api_key: &str,
    model: &str,
    max_tokens: u32,
    endpoint: &str,
) -> Result<String> {
    call_gpt_inner(system, user, api_key, model, max_tokens, true, endpoint).await
}

async fn call_gpt_text(
    system: &str,
    user: &str,
    api_key: &str,
    model: &str,
    max_tokens: u32,
    endpoint: &str,
) -> Result<String> {
    call_gpt_inner(system, user, api_key, model, max_tokens, false, endpoint).await
}
```

- [ ] **Step 3: Adicionar constantes de endpoint**

Logo após os imports no topo de `ai/mod.rs`:

```rust
pub const OPENAI_ENDPOINT: &str = "https://api.openai.com/v1/chat/completions";
pub const OPENROUTER_ENDPOINT: &str = "https://openrouter.ai/api/v1/chat/completions";
```

- [ ] **Step 4: Atualizar todas as funções públicas de IA para aceitar e propagar `endpoint`**

Funções a atualizar (adicionar `endpoint: &str` como último parâmetro, propagar para `call_gpt`/`call_gpt_text`):

**`generate_summary`**:
```rust
pub async fn generate_summary(
    transcript: &str,
    api_key: &str,
    model: &str,
    meeting_type: &MeetingType,
    endpoint: &str,
) -> Result<MeetingSummary> {
    // ...
    let content = call_gpt(&system, &user, api_key, model, 2000, endpoint).await?;
```

**`generate_followup_email`**:
```rust
pub async fn generate_followup_email(
    transcript: &str,
    summary: &MeetingSummary,
    api_key: &str,
    model: &str,
    endpoint: &str,
) -> Result<String> {
    // ...
    let content = call_gpt(system, &user, api_key, model, 1000, endpoint).await?;
```

**`diarize_transcript`** (se existir):
```rust
pub async fn diarize_transcript(
    transcript: &str,
    api_key: &str,
    model: &str,
    endpoint: &str,
) -> Result<Vec<SpeakerSegment>> {
    // ...
    let content = call_gpt(system, &user, api_key, model, 3000, endpoint).await?;
```

**`ask_about_transcript`**:
```rust
pub async fn ask_about_transcript(
    question: &str,
    transcript: &str,
    api_key: &str,
    model: &str,
    endpoint: &str,
) -> Result<String> {
    // ...
    call_gpt_text(system, &user, api_key, model, 800, endpoint).await
```

- [ ] **Step 5: Build para verificar**

```bash
cd src-tauri && cargo check 2>&1 | head -40
```

Esperado: erros apenas nos call sites em `commands.rs` (ainda não atualizados).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/ai/mod.rs
git commit -m "feat(ai): add endpoint parameter to support OpenRouter alongside OpenAI"
```

---

### Task 4: Rust — Atualizar commands.rs

**Files:**
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: Adicionar helper para derivar endpoint e key de resumo das settings**

Logo após os imports, antes do `AppState`, adicionar:

```rust
/// Retorna (api_key, endpoint) para geração de resumos com base nas configurações.
fn summary_credentials(settings: &storage::AppSettings) -> (String, &'static str) {
    if settings.summary_provider == "openrouter" {
        (settings.openrouter_api_key.clone(), ai::OPENROUTER_ENDPOINT)
    } else {
        (settings.openai_api_key.clone(), ai::OPENAI_ENDPOINT)
    }
}
```

- [ ] **Step 2: Remover google_cloud do `start_capture` — validação e worker**

Remover o bloco de validação do google_cloud (linhas ~106-108):
```rust
        "google_cloud" if settings.google_cloud_api_key.is_empty() => {
            return Err("Chave da API Google Cloud não configurada.".to_string());
        }
```

Remover variável `gcloud_key` (linha ~164):
```rust
    let gcloud_key       = settings.google_cloud_api_key.clone();
```

Remover o parâmetro `gcloud_key: &str` de `process_chunk` e sua referência.

Remover o branch `"google_cloud"` do match (linhas ~230-232):
```rust
                "google_cloud" => {
                    transcription::transcribe_google_cloud(wav_bytes, gcloud_key, Some(language)).await
                }
```

Remover a linha que calcula `needs_whisper_format` incluindo google_cloud (linha ~202), substituindo por:
```rust
            let needs_whisper_format = provider == "local";
```

- [ ] **Step 3: Corrigir auto-summary para usar summary_credentials**

Substituir o bloco de auto-summary (linhas ~466-499) em `stop_capture`:

```rust
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
```

- [ ] **Step 4: Atualizar comando `generate_summary`**

```rust
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
```

- [ ] **Step 5: Atualizar comando `generate_and_save_summary`**

```rust
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
```

- [ ] **Step 6: Atualizar `generate_followup_email`, `diarize_transcript`, `ask_about_transcript`**

Para cada um, adicionar `base_url: Option<String>` e propagar:

```rust
// generate_followup_email
pub async fn generate_followup_email(
    meeting_id: String,
    api_key: String,
    model: Option<String>,
    base_url: Option<String>,
) -> Result<String, String> {
    // ...
    let endpoint = base_url.as_deref().unwrap_or(ai::OPENAI_ENDPOINT);
    let email = ai::generate_followup_email(&meeting.transcript, &summary, &api_key, &model, endpoint)
        .await
        .map_err(|e| format!("Erro ao gerar e-mail: {e}"))?;
    // ...
}

// diarize_transcript
pub async fn diarize_transcript(
    meeting_id: String,
    api_key: String,
    model: Option<String>,
    base_url: Option<String>,
) -> Result<Vec<SpeakerSegment>, String> {
    // ...
    let endpoint = base_url.as_deref().unwrap_or(ai::OPENAI_ENDPOINT);
    let segments = ai::diarize_transcript(&meeting.transcript, &api_key, &model, endpoint)
        .await
        .map_err(|e| format!("Erro na diarização: {e}"))?;
    // ...
}

// ask_about_transcript
pub async fn ask_about_transcript(
    meeting_id: String,
    question: String,
    api_key: String,
    model: Option<String>,
    base_url: Option<String>,
) -> Result<String, String> {
    // ...
    let endpoint = base_url.as_deref().unwrap_or(ai::OPENAI_ENDPOINT);
    ai::ask_about_transcript(&question, &meeting.transcript, &api_key, &model, endpoint)
        .await
        .map_err(|e| format!("Erro ao responder pergunta: {e}"))
}
```

- [ ] **Step 7: Build completo**

```bash
cd src-tauri && cargo build 2>&1 | tail -20
```

Esperado: build bem-sucedido sem erros.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(commands): remove google_cloud, add base_url to AI commands, fix auto-summary"
```

---

### Task 5: Rust — Remover transcribe_google_cloud (transcription/mod.rs)

**Files:**
- Modify: `src-tauri/src/transcription/mod.rs`

- [ ] **Step 1: Remover função `transcribe_google_cloud`**

Localizar e remover a função `pub async fn transcribe_google_cloud` (linha ~181 em diante) e qualquer import relacionado (`base64`, `serde_json` específico do Google se não usado em outros lugares).

- [ ] **Step 2: Build para confirmar**

```bash
cd src-tauri && cargo build 2>&1 | tail -10
```

Esperado: build bem-sucedido.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/transcription/mod.rs
git commit -m "feat(transcription): remove Google Cloud STT provider"
```

---

### Task 6: Frontend — Atualizar aiSummaryService.ts e FollowupEmail.tsx

**Files:**
- Modify: `src/services/aiSummaryService.ts`
- Modify: `src/components/FollowupEmail.tsx`

- [ ] **Step 1: Adicionar `baseUrl` a todas as funções de aiSummaryService.ts**

Substituir o conteúdo completo de `src/services/aiSummaryService.ts`:

```typescript
import { invoke } from "@tauri-apps/api/core";
import type { MeetingSummary } from "@/types";

export async function generateSummary(
  transcript: string,
  apiKey: string,
  model?: string,
  baseUrl?: string
): Promise<MeetingSummary> {
  return await invoke<MeetingSummary>("generate_summary", {
    transcript,
    apiKey,
    model: model ?? "gpt-4o-mini",
    baseUrl: baseUrl ?? null,
  });
}

export async function generateAndSaveSummary(
  meetingId: string,
  apiKey: string,
  model?: string,
  baseUrl?: string
): Promise<MeetingSummary> {
  return await invoke<MeetingSummary>("generate_and_save_summary", {
    meetingId,
    apiKey,
    model: model ?? "gpt-4o-mini",
    baseUrl: baseUrl ?? null,
  });
}

export async function askAboutTranscript(
  meetingId: string,
  question: string,
  apiKey: string,
  model?: string,
  baseUrl?: string
): Promise<string> {
  return await invoke<string>("ask_about_transcript", {
    meetingId,
    question,
    apiKey,
    model: model ?? "gpt-4o-mini",
    baseUrl: baseUrl ?? null,
  });
}

export function hasMeaningfulSummary(summary: MeetingSummary | null): boolean {
  if (!summary) return false;
  return (
    summary.summary.length > 10 ||
    summary.decisions.length > 0 ||
    summary.tasks.length > 0 ||
    summary.key_points.length > 0
  );
}
```

- [ ] **Step 2: Atualizar FollowupEmail.tsx**

Adicionar `baseUrl?: string` à interface `Props` e ao invoke:

```typescript
interface Props {
  meetingId: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  existingEmail?: string | null;
  onGenerated: (email: string) => void;
}

export function FollowupEmail({ meetingId, apiKey, model, baseUrl, existingEmail, onGenerated }: Props) {
  // ...
  const generate = async () => {
    // ...
    const email = await invoke<string>('generate_followup_email', {
      meetingId,
      apiKey,
      model: model ?? null,
      baseUrl: baseUrl ?? null,
    });
    // ...
  };
```

- [ ] **Step 3: Commit**

```bash
git add src/services/aiSummaryService.ts src/components/FollowupEmail.tsx
git commit -m "feat(frontend): add baseUrl param to AI service functions"
```

---

### Task 7: Frontend — Atualizar hooks e JgrcExportModal

**Files:**
- Modify: `src/hooks/useTranscription.ts`
- Modify: `src/hooks/useMeetingHistory.ts`
- Modify: `src/components/JgrcExportModal.tsx`

- [ ] **Step 1: Criar helper para derivar credentials de resumo das settings**

Em `src/hooks/useTranscription.ts`, adicionar helper local antes do hook:

```typescript
function getSummaryCredentials(settings: AppSettings): { apiKey: string; baseUrl: string } {
  if (settings.summary_provider === "openrouter") {
    return {
      apiKey: settings.openrouter_api_key ?? "",
      baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    };
  }
  return {
    apiKey: settings.openai_api_key ?? "",
    baseUrl: "https://api.openai.com/v1/chat/completions",
  };
}
```

- [ ] **Step 2: Atualizar `generateSummaryFromCurrent` em useTranscription.ts**

Substituir o bloco de validação e chamada (linhas ~99-107):

```typescript
  const generateSummaryFromCurrent = useCallback(async () => {
    // ...
    const { apiKey, baseUrl } = getSummaryCredentials(settings);
    if (!apiKey) {
      throw new Error(
        settings.summary_provider === "openrouter"
          ? "Chave do OpenRouter não configurada."
          : "Chave da API OpenAI não configurada."
      );
    }
    const result = await generateSummary(
      transcript,
      apiKey,
      settings.summary_model || "gpt-4o-mini",
      baseUrl
    );
    // ...
  }, [/* deps */]);
```

- [ ] **Step 3: Atualizar `generateSummary` em useMeetingHistory.ts**

Adicionar o mesmo helper `getSummaryCredentials` (pode importar de um utils ou duplicar) e atualizar (linhas ~161-168):

```typescript
  const generateSummary = useCallback(async (meetingId: string) => {
    // ...
    const { apiKey, baseUrl } = getSummaryCredentials(settings);
    if (!apiKey) {
      throw new Error(
        settings.summary_provider === "openrouter"
          ? "Chave do OpenRouter não configurada."
          : "Chave da API OpenAI não configurada."
      );
    }
    const summary = await generateAndSaveSummary(
      meetingId,
      apiKey,
      settings.summary_model,
      baseUrl
    );
    // ...
  }, [/* deps */]);
```

- [ ] **Step 4: Atualizar JgrcExportModal.tsx**

Substituir as linhas ~192-199 que usam `settings.openai_api_key` diretamente:

```typescript
    if (!exportData || aiDone) return;
    const apiKey = settings.summary_provider === "openrouter"
      ? settings.openrouter_api_key
      : settings.openai_api_key;
    const baseUrl = settings.summary_provider === "openrouter"
      ? "https://openrouter.ai/api/v1/chat/completions"
      : "https://api.openai.com/v1/chat/completions";
    if (!apiKey) return;
    // ...
    generateAndSaveSummary(
      exportData.meeting.id,
      apiKey,
      settings.summary_model ?? "gpt-4o-mini",
      baseUrl
    )
```

Também atualizar a dependência do useEffect (linha ~217) — remover `settings.openai_api_key`, adicionar `settings.summary_provider`, `settings.openrouter_api_key`.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useTranscription.ts src/hooks/useMeetingHistory.ts src/components/JgrcExportModal.tsx
git commit -m "feat(hooks): derive summary credentials from summary_provider setting"
```

---

### Task 8: Frontend — Adicionar aba "modelos" em SettingsPage.tsx

**Files:**
- Modify: `src/pages/SettingsPage.tsx`

- [ ] **Step 1: Adicionar tipo e aba**

Substituir o conteúdo de `src/pages/SettingsPage.tsx`:

```typescript
// pages/SettingsPage.tsx
import React, { useState } from "react";
import { Settings, Keyboard, Link, Cpu } from "lucide-react";
import clsx from "clsx";
import { SettingsPanel } from "@/components/SettingsModal";

export type SettingsTab = "config" | "modelos" | "shortcuts" | "jgrc";

const TABS: { id: SettingsTab; label: string; icon: React.ElementType }[] = [
  { id: "config",   label: "Geral",          icon: Settings },
  { id: "modelos",  label: "Modelos & APIs",  icon: Cpu },
  { id: "shortcuts", label: "Atalhos",        icon: Keyboard },
  { id: "jgrc",     label: "Integração JGRC", icon: Link },
];

export const SettingsPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<SettingsTab>("config");

  return (
    <div className="flex flex-col h-full bg-surface-50 dark:bg-[#0c0f17]">
      <div className="bg-white dark:bg-surface-900/50 border-b border-surface-100 dark:border-surface-800/50 px-6 py-4 flex-shrink-0">
        <div className="flex items-center gap-2 mb-3">
          <Settings className="w-5 h-5 text-surface-400 dark:text-surface-500" />
          <h1 className="text-lg font-bold text-surface-900 dark:text-surface-100">Configurações</h1>
        </div>
        <div className="flex gap-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={clsx(
                "flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-150",
                activeTab === id
                  ? "bg-primary-500 text-white shadow-sm"
                  : "text-surface-500 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-800 hover:text-surface-700 dark:hover:text-surface-200"
              )}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        <SettingsPanel activeTab={activeTab} />
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Atualizar o tipo SettingsTab exportado em SettingsModal.tsx**

No topo de `src/components/SettingsModal.tsx`, substituir:

```typescript
type SettingsTab = "config" | "shortcuts" | "jgrc";
```

Por:

```typescript
type SettingsTab = "config" | "modelos" | "shortcuts" | "jgrc";
```

E atualizar a prop:

```typescript
interface SettingsPanelProps {
  className?: string;
  activeTab?: SettingsTab;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/pages/SettingsPage.tsx src/components/SettingsModal.tsx
git commit -m "feat(settings): add Modelos & APIs tab to SettingsPage"
```

---

### Task 9: Frontend — Implementar aba "modelos" em SettingsModal.tsx (parte 1 — estrutura e transcrição)

**Files:**
- Modify: `src/components/SettingsModal.tsx`

- [ ] **Step 1: Adicionar constantes de provider para transcrição e resumo**

Após `SUPPORTED_MODELS` (linha ~50), adicionar:

```typescript
const TRANSCRIPTION_PROVIDERS = [
  { value: "openai", label: "OpenAI Whisper" },
  { value: "groq",   label: "Groq (rápido)" },
  { value: "local",  label: "Local (offline)" },
];

const SUMMARY_PROVIDERS = [
  { value: "openai",      label: "OpenAI" },
  { value: "openrouter",  label: "OpenRouter" },
];

const OPENROUTER_MODEL_SUGGESTIONS = [
  "openai/gpt-4o-mini",
  "openai/gpt-4o",
  "anthropic/claude-haiku-4-5",
  "anthropic/claude-sonnet-4-5",
  "meta-llama/llama-3.1-8b-instruct:free",
  "google/gemini-flash-1.5",
];
```

- [ ] **Step 2: Atualizar state inicial com novos campos**

No state inicial (linha ~86), adicionar após `google_cloud_api_key: ""`:

```typescript
    openrouter_api_key: "",
    summary_provider: "openai",
```

Remover `google_cloud_api_key: ""` do estado inicial (não precisa estar no form, só para evitar erro de tipo — manter como vazio mas não mostrar na UI).

- [ ] **Step 3: Adicionar seção completa da aba "modelos"**

Após o bloco `{activeTab === "config" && (<>...</>)}` (linha ~848), mas antes do bloco `{activeTab === "jgrc"...}`, adicionar:

```tsx
      {activeTab === "modelos" && (<>

      {/* ── Bloco 1: Transcrição ── */}
      <SettingSection
        icon={<Cpu className="w-4 h-4 text-surface-500" />}
        title="Transcrição"
        description="Serviço usado para transcrever o áudio das reuniões."
      >
        {/* Selector visual de provider */}
        <div className="flex gap-2">
          {TRANSCRIPTION_PROVIDERS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => updateSetting("transcription_provider", value)}
              className={clsx(
                "flex-1 px-3 py-2.5 rounded-xl text-sm font-medium border transition-all duration-150",
                (settings.transcription_provider ?? "openai") === value
                  ? "bg-primary-500 border-primary-500 text-white shadow-sm"
                  : "bg-surface-50 dark:bg-surface-800/60 border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-300 hover:border-primary-400 dark:hover:border-primary-400"
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* API Key por provider */}
        <div className="mt-4 space-y-3">
          {(settings.transcription_provider ?? "openai") === "openai" && (
            <div>
              <label className="text-xs font-medium text-surface-600 dark:text-surface-400 mb-1.5 flex items-center gap-1.5">
                <Key className="w-3.5 h-3.5" />
                Chave da API OpenAI
              </label>
              <div className="relative">
                <input
                  type={showKey ? "text" : "password"}
                  value={settings.openai_api_key}
                  onChange={(e) => updateSetting("openai_api_key", e.target.value)}
                  placeholder="sk-..."
                  className={clsx(
                    "w-full px-3 pr-10 py-2.5 text-sm font-mono rounded-xl border",
                    "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
                    "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
                    "placeholder:text-surface-300 dark:placeholder:text-surface-600 transition-all"
                  )}
                />
                <button onClick={() => setShowKey((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600 dark:hover:text-surface-300 transition-colors">
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
          )}

          {(settings.transcription_provider ?? "openai") === "groq" && (
            <div>
              <label className="text-xs font-medium text-surface-600 dark:text-surface-400 mb-1.5 flex items-center gap-1.5">
                <Key className="w-3.5 h-3.5" />
                Chave da API Groq
              </label>
              <div className="relative">
                <input
                  type={showKey ? "text" : "password"}
                  value={settings.groq_api_key ?? ""}
                  onChange={(e) => updateSetting("groq_api_key", e.target.value)}
                  placeholder="gsk_..."
                  className={clsx(
                    "w-full px-3 pr-10 py-2.5 text-sm font-mono rounded-xl border",
                    "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
                    "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
                    "placeholder:text-surface-300 dark:placeholder:text-surface-600 transition-all"
                  )}
                />
                <button onClick={() => setShowKey((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600 dark:hover:text-surface-300 transition-colors">
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-xs text-surface-400 dark:text-surface-500 mt-1">
                Crie uma conta gratuita em console.groq.com.
              </p>
            </div>
          )}

          {(settings.transcription_provider ?? "openai") === "local" && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 p-2 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 rounded-lg text-xs text-amber-800 dark:text-amber-300">
                <span className="mt-0.5">⚠️</span>
                <span>Baixe o <strong>whisper-cli.exe</strong> em github.com/ggerganov/whisper.cpp/releases.</span>
              </div>
              <div>
                <label className="text-xs font-medium text-surface-600 dark:text-surface-400 mb-1 block flex items-center gap-1.5">
                  <FolderOpen className="w-3.5 h-3.5" />
                  Executável whisper-cli.exe
                </label>
                <input
                  type="text"
                  value={settings.local_whisper_exe ?? ""}
                  onChange={(e) => updateSetting("local_whisper_exe", e.target.value)}
                  placeholder="C:\whisper\whisper-cli.exe"
                  className={clsx(
                    "w-full px-3 py-2 text-sm rounded-xl border font-mono",
                    "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
                    "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
                    "placeholder:text-surface-300 dark:placeholder:text-surface-600"
                  )}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-surface-600 dark:text-surface-400 mb-1 block flex items-center gap-1.5">
                  <HardDrive className="w-3.5 h-3.5" />
                  Caminho do modelo (.bin)
                </label>
                <input
                  type="text"
                  value={settings.local_whisper_model ?? "base"}
                  onChange={(e) => updateSetting("local_whisper_model", e.target.value)}
                  placeholder="base  ou  C:\...\ggml-base.bin"
                  className={clsx(
                    "w-full px-3 py-2 text-sm rounded-xl border font-mono",
                    "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
                    "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
                    "placeholder:text-surface-300 dark:placeholder:text-surface-600"
                  )}
                />
              </div>
            </div>
          )}
        </div>

        {/* Idioma + Chunk duration — sempre visíveis */}
        <div className="mt-4 grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-surface-600 dark:text-surface-400 mb-1.5 flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5" />
              Idioma
            </label>
            <select
              value={settings.transcription_language}
              onChange={(e) => updateSetting("transcription_language", e.target.value)}
              className={clsx(
                "w-full px-3 py-2 text-sm rounded-xl border",
                "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
                "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
                "transition-all appearance-none cursor-pointer"
              )}
            >
              {SUPPORTED_LANGUAGES.map((lang) => (
                <option key={lang.value} value={lang.value}>{lang.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-surface-600 dark:text-surface-400 mb-1.5 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              Intervalo
            </label>
            <select
              value={settings.chunk_duration_secs}
              onChange={(e) => updateSetting("chunk_duration_secs", Number(e.target.value))}
              className={clsx(
                "w-full px-3 py-2 text-sm rounded-xl border",
                "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
                "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
                "transition-all appearance-none cursor-pointer"
              )}
            >
              {CHUNK_DURATIONS.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
          </div>
        </div>
      </SettingSection>

      {/* ── Bloco 2: Resumos com IA ── */}
      <SettingSection
        icon={<Sparkles className="w-4 h-4 text-surface-500" />}
        title="Resumos com IA"
        description="Provider e modelo usados para gerar resumos das reuniões."
      >
        {/* Selector visual de provider */}
        <div className="flex gap-2">
          {SUMMARY_PROVIDERS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => updateSetting("summary_provider", value)}
              className={clsx(
                "flex-1 px-3 py-2.5 rounded-xl text-sm font-medium border transition-all duration-150",
                (settings.summary_provider ?? "openai") === value
                  ? "bg-primary-500 border-primary-500 text-white shadow-sm"
                  : "bg-surface-50 dark:bg-surface-800/60 border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-300 hover:border-primary-400 dark:hover:border-primary-400"
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-3">
          {/* OpenAI: key (ou aviso de reuso) + modelo */}
          {(settings.summary_provider ?? "openai") === "openai" && (<>
            {(settings.transcription_provider ?? "openai") === "openai" ? (
              <p className="text-xs text-surface-400 dark:text-surface-500 flex items-center gap-1.5">
                <Key className="w-3.5 h-3.5" />
                Usando a mesma chave OpenAI configurada na Transcrição.
              </p>
            ) : (
              <div>
                <label className="text-xs font-medium text-surface-600 dark:text-surface-400 mb-1.5 flex items-center gap-1.5">
                  <Key className="w-3.5 h-3.5" />
                  Chave da API OpenAI (resumos)
                </label>
                <div className="relative">
                  <input
                    type={showKey ? "text" : "password"}
                    value={settings.openai_api_key}
                    onChange={(e) => updateSetting("openai_api_key", e.target.value)}
                    placeholder="sk-..."
                    className={clsx(
                      "w-full px-3 pr-10 py-2.5 text-sm font-mono rounded-xl border",
                      "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
                      "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
                      "placeholder:text-surface-300 dark:placeholder:text-surface-600 transition-all"
                    )}
                  />
                  <button onClick={() => setShowKey((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600 dark:hover:text-surface-300 transition-colors">
                    {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            )}
            <div>
              <label className="text-xs font-medium text-surface-600 dark:text-surface-400 mb-1.5 block">
                Modelo
              </label>
              <select
                value={settings.summary_model}
                onChange={(e) => updateSetting("summary_model", e.target.value)}
                className={clsx(
                  "w-full px-3 py-2.5 text-sm rounded-xl border",
                  "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
                  "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
                  "transition-all appearance-none cursor-pointer"
                )}
              >
                {SUPPORTED_MODELS.map((model) => (
                  <option key={model.value} value={model.value}>{model.label}</option>
                ))}
              </select>
            </div>
          </>)}

          {/* OpenRouter: key + input livre de modelo */}
          {(settings.summary_provider ?? "openai") === "openrouter" && (<>
            <div>
              <label className="text-xs font-medium text-surface-600 dark:text-surface-400 mb-1.5 flex items-center gap-1.5">
                <Key className="w-3.5 h-3.5" />
                Chave da API OpenRouter
              </label>
              <div className="relative">
                <input
                  type={showKey ? "text" : "password"}
                  value={settings.openrouter_api_key ?? ""}
                  onChange={(e) => updateSetting("openrouter_api_key", e.target.value)}
                  placeholder="sk-or-..."
                  className={clsx(
                    "w-full px-3 pr-10 py-2.5 text-sm font-mono rounded-xl border",
                    "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
                    "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
                    "placeholder:text-surface-300 dark:placeholder:text-surface-600 transition-all"
                  )}
                />
                <button onClick={() => setShowKey((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600 dark:hover:text-surface-300 transition-colors">
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-xs text-surface-400 dark:text-surface-500 mt-1">
                Obtenha em openrouter.ai/keys — acesso a centenas de modelos.
              </p>
            </div>
            <div>
              <label className="text-xs font-medium text-surface-600 dark:text-surface-400 mb-1.5 block">
                Modelo
              </label>
              <input
                type="text"
                list="openrouter-models"
                value={settings.summary_model}
                onChange={(e) => updateSetting("summary_model", e.target.value)}
                placeholder="openai/gpt-4o-mini"
                className={clsx(
                  "w-full px-3 py-2.5 text-sm font-mono rounded-xl border",
                  "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
                  "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
                  "placeholder:text-surface-300 dark:placeholder:text-surface-600 transition-all"
                )}
              />
              <datalist id="openrouter-models">
                {OPENROUTER_MODEL_SUGGESTIONS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <p className="text-xs text-surface-400 dark:text-surface-500 mt-1">
                Digite qualquer model ID do OpenRouter ou escolha uma sugestão.
              </p>
            </div>
          </>)}
        </div>
      </SettingSection>

      {/* Download de modelo Whisper — só aparece quando provider é local */}
      {(settings.transcription_provider ?? "openai") === "local" && (
        <WhisperModelDownloader onModelDownloaded={(path) => updateSetting("local_whisper_model", path)} />
      )}

      </>)}
```

- [ ] **Step 4: Commit**

```bash
git add src/components/SettingsModal.tsx
git commit -m "feat(settings): implement Modelos & APIs tab with transcription and summary blocks"
```

---

### Task 10: Frontend — Limpar aba "config" em SettingsModal.tsx

**Files:**
- Modify: `src/components/SettingsModal.tsx`

- [ ] **Step 1: Remover seções migradas da aba "config"**

Da aba "config" (bloco `{activeTab === "config" && (<>...</>)}`), remover as seguintes seções que agora estão na aba "modelos":

1. **"Serviço de Transcrição"** (SettingSection com `<Cpu>`, provider selector) — linhas ~205-226
2. **API Key dinâmica** (SettingSection com `<Key>` condicional por provider) — linhas ~229-284
3. **API Key OpenAI para resumos** (SettingSection `<Key>` separado para não-openai) — linhas ~287-316
4. **"Idioma da Transcrição"** (SettingSection com `<Globe>`) — linhas ~318-340
5. **"Modelo para Resumos"** (SettingSection com `<Cpu>`, dropdown SUPPORTED_MODELS) — linhas ~342-364
6. **"Intervalo de Transcrição"** (SettingSection com `<Clock>`) — linhas ~366-388
7. **"Configuração do Whisper Local"** (SettingSection com `<Laptop>`) — linhas ~598-668
8. **`<WhisperModelDownloader />`** no final do bloco config (linha ~846) — já movido para aba "modelos"

- [ ] **Step 2: Verificar TypeScript sem erros**

```bash
cd .. && npx tsc --noEmit 2>&1 | head -30
```

Esperado: sem erros de tipo.

- [ ] **Step 3: Commit**

```bash
git add src/components/SettingsModal.tsx
git commit -m "feat(settings): remove migrated sections from config tab"
```

---

### Task 11: Build e teste final

- [ ] **Step 1: Build Tauri completo**

```bash
npm run tauri build 2>&1 | tail -30
```

Esperado: build bem-sucedido.

- [ ] **Step 2: Verificação manual — fluxo transcrição**

Abrir o app, ir em Configurações → Modelos & APIs:
- Clicar em cada provider de transcrição (OpenAI, Groq, Local) — verificar que os campos corretos aparecem
- Salvar configurações

- [ ] **Step 3: Verificação manual — fluxo resumo**

- Selecionar "OpenAI" como provider de resumo + transcrição OpenAI → deve mostrar mensagem "usando mesma chave"
- Selecionar "OpenAI" para resumo + "Groq" para transcrição → deve mostrar campo de key OpenAI
- Selecionar "OpenRouter" → deve mostrar campo openrouter_api_key + input de modelo com sugestões

- [ ] **Step 4: Verificar aba "config" (geral)**

Confirmar que as seções removidas sumiram e que o restante (aparência, microfone, compliance, etc.) continua funcionando.

- [ ] **Step 5: Commit final se necessário**

```bash
git add -p
git commit -m "fix(settings): final cleanup and adjustments"
```
