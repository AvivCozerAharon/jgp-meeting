# Summary Prose Format + No Empty Meeting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trocar resumo em bullet points por texto corrido em prosa rico, e impedir salvar reuniões sem transcrição.

**Architecture:** Duas mudanças independentes: (1) simplificação do struct `MeetingSummary` + reescrita do prompt de IA em `ai/mod.rs`; (2) guard em `stop_capture` em `commands.rs`. Frontend atualiza `types/index.ts`, `SummaryPanel.tsx`, `JgrcExportModal.tsx` e `aiSummaryService.ts`.

**Tech Stack:** Rust (serde, anyhow), React/TypeScript, Tailwind CSS

---

## File Map

| Arquivo | Mudança |
|---------|---------|
| `src-tauri/src/ai/mod.rs` | Remove campos do struct, reescreve prompt, aumenta max_tokens |
| `src-tauri/src/commands.rs` | Adiciona guard "transcript vazio" em `stop_capture` |
| `src/types/index.ts` | Remove `decisions`, `tasks`, `key_points` de `MeetingSummary` |
| `src/services/aiSummaryService.ts` | Atualiza `hasMeaningfulSummary` |
| `src/components/SummaryPanel.tsx` | Remove seções de listas, exibe `summary` em prosa |
| `src/components/JgrcExportModal.tsx` | Atualiza `summaryText` e `actions` default |

---

### Task 1: Rust — Simplificar MeetingSummary e reescrever prompt (ai/mod.rs)

**Files:**
- Modify: `src-tauri/src/ai/mod.rs`

- [ ] **Step 1: Substituir o struct `MeetingSummary`**

Substituir o bloco do struct e impl Default (linhas 16-36):

```rust
/// Resumo gerado pela IA a partir da transcrição — texto corrido em prosa.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MeetingSummary {
    pub summary: String,
    /// Feature 9: rascunho de e-mail de follow-up (gerado separadamente)
    pub followup_email: Option<String>,
}

impl Default for MeetingSummary {
    fn default() -> Self {
        Self {
            summary: String::new(),
            followup_email: None,
        }
    }
}
```

- [ ] **Step 2: Reescrever `summary_system_prompt`**

Substituir a função inteira `summary_system_prompt` (linhas 52-101):

```rust
fn summary_system_prompt(meeting_type: &MeetingType) -> String {
    let template_focus = match meeting_type {
        MeetingType::General => {
            "Aborde: contexto e objetivo da reunião, decisões estratégicas tomadas \
             (com responsáveis quando mencionados), próximas ações acordadas e pontos relevantes."
        }
        MeetingType::Standup => {
            "Aborde: o que cada pessoa concluiu desde o último standup, o que cada pessoa \
             fará até o próximo, e bloqueios ou impedimentos relatados. Mencione nomes."
        }
        MeetingType::OneOnOne => {
            "Aborde: feedbacks dados e recebidos, metas e desenvolvimento pessoal discutidos, \
             próximos passos acordados entre os participantes."
        }
        MeetingType::Retrospective => {
            "Aborde: o que funcionou bem e deve continuar (keep), o que deve melhorar (improve), \
             o que deve parar (stop) e as ações de melhoria concretas definidas."
        }
        MeetingType::Commercial => {
            "Aborde: perfil e dores do cliente, proposta de valor apresentada, objeções levantadas \
             e como foram tratadas, próxima ação de vendas acordada e timeline esperado."
        }
        MeetingType::Interview => {
            "Aborde: competências técnicas demonstradas, soft skills observadas, pontos fortes \
             do candidato, pontos de atenção e recomendação final sobre o perfil."
        }
    };

    format!(
        r#"Você é um assistente especializado em análise de reuniões de trabalho.
Tipo desta reunião: {} — {}

Analise a transcrição e gere um resumo em JSON com EXATAMENTE este formato:
{{
  "summary": "texto completo em prosa aqui",
  "followup_email": null
}}

O campo "summary" deve ser um texto corrido em português do Brasil, profissional e detalhado.
Escreva em parágrafos fluidos, sem bullet points, sem marcadores, sem cabeçalhos.
O texto deve cobrir: contexto e objetivo da reunião, principais temas discutidos, decisões tomadas
(com responsáveis quando mencionados), próximos passos acordados e pontos de atenção relevantes.
Seja suficientemente detalhado para que o texto possa ser publicado diretamente em um sistema
de gestão sem necessidade de edição.

Regras:
- Responda SEMPRE em português do Brasil
- Texto corrido sem listas ou marcadores
- Se a transcrição for muito curta ou sem conteúdo relevante, indique isso no summary"#,
        meeting_type.icon(),
        template_focus
    )
}
```

- [ ] **Step 3: Aumentar max_tokens na chamada de `generate_summary`**

Na função `generate_summary` (linha ~220), substituir:
```rust
    let content = call_gpt(&system, &user, api_key, model, 2000, endpoint).await?;
```
Por:
```rust
    let content = call_gpt(&system, &user, api_key, model, 3000, endpoint).await?;
```

- [ ] **Step 4: Verificar `cargo check`**

```bash
cd src-tauri && cargo check 2>&1 | grep -E "error|warning.*unused" | head -20
```

Esperado: erros apenas nos arquivos que ainda referenciam os campos removidos (nenhum dentro de `ai/mod.rs`).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/ai/mod.rs
git commit -m "feat(ai): simplify MeetingSummary to prose-only, rewrite summary prompt"
```

---

### Task 2: Rust — Guard "transcript vazio" em stop_capture (commands.rs)

**Files:**
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: Adicionar verificação antes de save_meeting**

Em `stop_capture`, após a linha `meeting.transcript = state.transcript.lock().unwrap().clone();` (linha ~452) e ANTES de `storage::save_meeting`, inserir:

```rust
    if meeting.transcript.trim().is_empty() {
        return Err("Nenhuma fala foi capturada.".to_string());
    }
```

O trecho deve ficar assim:

```rust
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
```

- [ ] **Step 2: Verificar `cargo build`**

```bash
cd src-tauri && cargo build 2>&1 | tail -5
```

Esperado: `Finished dev profile` sem erros.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(commands): return error when stopping capture with empty transcript"
```

---

### Task 3: TypeScript — Atualizar MeetingSummary (types/index.ts + aiSummaryService.ts)

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/services/aiSummaryService.ts`

- [ ] **Step 1: Remover campos do interface MeetingSummary em types/index.ts**

Substituir o bloco `MeetingSummary`:

```typescript
export interface MeetingSummary {
  summary: string;
  /** Feature 9: rascunho de e-mail de follow-up */
  followup_email?: string | null;
}
```

- [ ] **Step 2: Atualizar `hasMeaningfulSummary` em aiSummaryService.ts**

Substituir a função:

```typescript
export function hasMeaningfulSummary(summary: MeetingSummary | null): boolean {
  if (!summary) return false;
  return summary.summary.length > 10;
}
```

- [ ] **Step 3: Verificar TypeScript**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Esperado: erros apenas em `SummaryPanel.tsx` e `JgrcExportModal.tsx` (ainda não atualizados). Nenhum erro novo em outros arquivos.

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts src/services/aiSummaryService.ts
git commit -m "feat(types): simplify MeetingSummary to summary + followup_email only"
```

---

### Task 4: Frontend — Atualizar SummaryPanel.tsx

**Files:**
- Modify: `src/components/SummaryPanel.tsx`

- [ ] **Step 1: Remover imports não mais usados**

No bloco de imports do lucide-react, remover `CheckCircle2`, `ListTodo`, `Star` (usados apenas pelas seções de decisions/tasks/key_points). Manter `Sparkles`, `AlertCircle`.

```typescript
import {
  Sparkles,
  AlertCircle,
} from "lucide-react";
```

- [ ] **Step 2: Substituir o bloco de conteúdo `hasSummary`**

Substituir o bloco que vai de `{hasSummary && (` até o `)}` correspondente (linhas 108-169) por:

```tsx
        {hasSummary && (
          <div className="animate-slide-up">
            {summary.summary && (
              <SummaryCard
                icon={<Sparkles className="w-4 h-4 text-primary-500" />}
                title="Resumo"
                accentColor="primary"
              >
                <p className="text-sm text-surface-600 dark:text-surface-300 leading-relaxed whitespace-pre-line">
                  {summary.summary}
                </p>
              </SummaryCard>
            )}
          </div>
        )}
```

- [ ] **Step 3: Remover sub-componentes não mais usados**

Remover as constantes e interfaces que não são mais usadas:
- `const listItemDotColors` 
- `interface ListItemProps`
- `const ListItem`

Manter `SummaryCard`, `cardBgClasses`, `cardTitleClasses`, `AccentColor`, `SummaryCardProps`.

- [ ] **Step 4: Verificar TypeScript**

```bash
npx tsc --noEmit 2>&1 | grep "SummaryPanel" | head -10
```

Esperado: nenhum erro em SummaryPanel.tsx.

- [ ] **Step 5: Commit**

```bash
git add src/components/SummaryPanel.tsx
git commit -m "feat(ui): display summary as prose paragraph, remove bullet point sections"
```

---

### Task 5: Frontend — Atualizar JgrcExportModal.tsx

**Files:**
- Modify: `src/components/JgrcExportModal.tsx`

- [ ] **Step 1: Atualizar `summaryText` na função `suggestFieldsWithAI`**

Na função `suggestFieldsWithAI` (~linha 79), substituir:

```typescript
  const summaryText = meeting.summary
    ? `Resumo: ${meeting.summary.summary}\nPontos: ${meeting.summary.key_points.join("; ")}\nAções: ${meeting.summary.tasks.join("; ")}`
    : `Transcrição: ${meeting.transcript.slice(0, 2000)}`;
```

Por:

```typescript
  const summaryText = meeting.summary
    ? `Resumo: ${meeting.summary.summary}`
    : `Transcrição: ${meeting.transcript.slice(0, 2000)}`;
```

- [ ] **Step 2: Atualizar o estado inicial de `actions`**

Substituir a linha ~156:

```typescript
  const [actions, setActions] = useState(
    meeting.summary?.tasks?.join("; ") ?? ""
  );
```

Por:

```typescript
  const [actions, setActions] = useState("");
```

- [ ] **Step 3: Verificar TypeScript zero erros**

```bash
npx tsc --noEmit 2>&1 | head -10
```

Esperado: zero erros.

- [ ] **Step 4: Commit**

```bash
git add src/components/JgrcExportModal.tsx
git commit -m "feat(jgrc): update summary context and actions field for prose format"
```

---

### Task 6: Build final

- [ ] **Step 1: Cargo build**

```bash
cd src-tauri && cargo build 2>&1 | tail -5
```

Esperado: `Finished dev profile` sem erros.

- [ ] **Step 2: TypeScript zero erros**

```bash
npx tsc --noEmit 2>&1 && echo "TS_OK"
```

Esperado: `TS_OK`.

- [ ] **Step 3: Commit final (se houver ajustes)**

```bash
git add -p
git commit -m "fix: final cleanup after prose summary refactor"
```
