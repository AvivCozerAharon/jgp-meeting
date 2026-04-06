# Summary Redesign: Prose Format + No Empty Meeting — Design Spec

**Data:** 2026-04-06  
**Status:** Aprovado

## Contexto

O resumo gerado hoje usa arrays de bullet points (`decisions`, `tasks`, `key_points`) que não se prestam a cópia direta para o JGRC. Além disso, reuniões sem nenhuma transcrição são salvas desnecessariamente no histórico.

## Mudanças

### 1. Struct `MeetingSummary` — remover campos de array

**Rust (`ai/mod.rs`):**

```rust
pub struct MeetingSummary {
    pub summary: String,
    pub followup_email: Option<String>,
}
```

Removidos: `decisions: Vec<String>`, `tasks: Vec<String>`, `key_points: Vec<String>`.

**TypeScript (`types/index.ts`):**

```typescript
export interface MeetingSummary {
  summary: string;
  followup_email?: string | null;
}
```

Removidos: `decisions: string[]`, `tasks: string[]`, `key_points: string[]`.

**Compatibilidade:** `serde` em Rust ignora campos extras na deserialização — reuniões antigas com os campos preenchidos continuam carregando sem erro; os campos são simplesmente descartados. Nenhuma migração necessária.

---

### 2. Prompt de geração de resumo

Substituir o system prompt em `summary_system_prompt()` em `ai/mod.rs`. O novo formato pede um texto corrido rico em vez de JSON com arrays.

**Novo JSON esperado:**
```json
{
  "summary": "texto longo em prosa cobrindo contexto, decisões, responsáveis e próximos passos",
  "followup_email": null
}
```

**Novo system prompt (base — ajustado por tipo de reunião):**

```
Você é um assistente especializado em análise de reuniões de trabalho.
Tipo desta reunião: {icon} — {template_focus}

Analise a transcrição e gere um resumo detalhado em JSON com EXATAMENTE este formato:
{
  "summary": "texto completo em prosa",
  "followup_email": null
}

O campo "summary" deve ser um texto corrido em português do Brasil, profissional e completo, 
cobrindo: contexto e objetivo da reunião, principais temas discutidos, decisões tomadas 
(com responsáveis quando mencionados), próximos passos acordados e pontos de atenção relevantes.
Escreva em parágrafos fluidos, sem bullet points, sem marcadores, sem cabeçalhos.
O texto deve ser suficientemente detalhado para ser publicado diretamente em um sistema de gestão
sem necessidade de edição.

Regras:
- Responda SEMPRE em português do Brasil
- Texto corrido, sem bullet points ou listas
- Capture decisões concretas com responsáveis quando mencionados
- Se a transcrição for muito curta, indique no summary
```

O `template_focus` por tipo de reunião continua existindo e é incorporado ao prompt — mas agora orienta o modelo a focar em determinados aspectos dentro do texto corrido, não em campos separados.

---

### 3. Não salvar reunião sem transcrição

Em `stop_capture` em `commands.rs`, após `meeting.transcript = state.transcript.lock().unwrap().clone()`, adicionar:

```rust
if meeting.transcript.trim().is_empty() {
    return Err("Nenhuma fala foi capturada.".to_string());
}
```

Antes da linha `storage::save_meeting(&meeting)`. O draining de chunks já terá acontecido (é assíncrono e acontece no worker), então esta verificação é no transcript acumulado no estado.

**Nota:** a verificação deve acontecer ANTES de `save_meeting` e ANTES de definir `draining_meeting_id`.

---

### 4. Componentes afetados

| Arquivo | Mudança |
|---------|---------|
| `src-tauri/src/ai/mod.rs` | Remove campos do struct, reescreve prompt |
| `src-tauri/src/commands.rs` | Adiciona verificação de transcript vazio em `stop_capture` |
| `src/types/index.ts` | Remove campos do interface `MeetingSummary` |
| `src/services/aiSummaryService.ts` | Atualiza `hasMeaningfulSummary` — só verifica `summary.length > 10` |
| `src/components/SummaryPanel.tsx` | Remove seções de `decisions`, `tasks`, `key_points` — exibe só `summary` em prosa |
| `src/components/JgrcExportModal.tsx` | Atualiza string de contexto e referências a `tasks`/`key_points` |

---

### 5. SummaryPanel.tsx — nova exibição

O painel passa a exibir o campo `summary` como texto corrido (com `whitespace-pre-line` ou paragrafação), sem as seções separadas de Decisões, Tarefas e Pontos-chave.

O `followup_email` continua sendo exibido separadamente (componente `FollowupEmail`).

---

### 6. JgrcExportModal.tsx — contexto para sugestão de campos

A linha que monta o contexto de IA para sugestão de campos do JGRC (linha ~80) usa `tasks.join` e `key_points.join`. Deve ser substituída para usar apenas `summary`:

```typescript
? `Resumo: ${meeting.summary.summary}`
```

A linha ~156 que usa `meeting.summary?.tasks?.join("; ")` deve ser substituída pelo `summary` completo ou deixada vazia.
