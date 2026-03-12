/// ai/mod.rs
/// Serviços de IA: geração de resumo, e-mail de follow-up e diarização de falantes.
/// Todos os modelos GPT são acessados via API OpenAI (chat completions).
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::storage::MeetingType;

// ─── Tipos públicos ───────────────────────────────────────────────────────────

/// Resumo estruturado gerado pela IA a partir da transcrição.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MeetingSummary {
    pub summary: String,
    pub decisions: Vec<String>,
    pub tasks: Vec<String>,
    pub key_points: Vec<String>,
    /// Feature 9: rascunho de e-mail de follow-up (gerado separadamente)
    pub followup_email: Option<String>,
}

impl Default for MeetingSummary {
    fn default() -> Self {
        Self {
            summary: String::new(),
            decisions: Vec::new(),
            tasks: Vec::new(),
            key_points: Vec::new(),
            followup_email: None,
        }
    }
}

/// Feature 10: segmento de fala identificado por diarização via IA.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SpeakerSegment {
    /// Nome inferido ou "Participante A", "Participante B" etc.
    pub speaker: String,
    /// Trecho de fala atribuído a este participante
    pub text: String,
    /// Índice sequencial do turno (0, 1, 2, …)
    pub index: usize,
}

// ─── Prompts de sistema ───────────────────────────────────────────────────────

/// Retorna o system prompt adequado ao tipo de reunião (Feature 8).
fn summary_system_prompt(meeting_type: &MeetingType) -> String {
    let template_focus = match meeting_type {
        MeetingType::General => {
            "Foque em decisões estratégicas, ações definidas e pontos principais discutidos."
        }
        MeetingType::Standup => {
            "Identifique claramente: (1) O que cada pessoa fez, (2) O que cada pessoa fará, \
             (3) Bloqueios ou impedimentos relatados."
        }
        MeetingType::OneOnOne => {
            "Foque em: feedbacks dados/recebidos, metas e desenvolvimento pessoal, \
             próximos passos acordados entre os participantes."
        }
        MeetingType::Retrospective => {
            "Organize em: o que funcionou bem (keep), o que deve melhorar (improve), \
             o que deve parar (stop) e ações de melhoria concretas."
        }
        MeetingType::Commercial => {
            "Identifique: dores e necessidades do cliente, proposta de valor apresentada, \
             objeções levantadas, próxima ação de vendas e timeline esperado."
        }
        MeetingType::Interview => {
            "Avalie: competências técnicas demonstradas, soft skills observadas, \
             pontos fortes do candidato, pontos de atenção e recomendação final."
        }
    };

    format!(
        r#"Você é um assistente especializado em análise de reuniões de trabalho.
Tipo desta reunião: {} — {}

Analise a transcrição e gere um resumo estruturado em JSON com EXATAMENTE este formato:
{{
  "summary": "resumo geral objetivo em 2-4 frases",
  "decisions": ["decisão concreta 1", "decisão concreta 2"],
  "tasks": ["[Responsável] descrição da tarefa", "..."],
  "key_points": ["ponto importante 1", "..."],
  "followup_email": null
}}

Regras:
- Responda SEMPRE em português do Brasil
- Seja objetivo e conciso
- Capture apenas decisões concretas (não suposições)
- Se não houver decisões/tarefas, retorne array vazio []
- Se a transcrição for muito curta, indique no summary"#,
        meeting_type.icon(),
        template_focus
    )
}

// ─── Resposta da API ──────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: Message,
}

#[derive(Debug, Deserialize)]
struct Message {
    content: String,
}

async fn call_gpt(
    system: &str,
    user: &str,
    api_key: &str,
    model: &str,
    max_tokens: u32,
) -> Result<String> {
    call_gpt_inner(system, user, api_key, model, max_tokens, true).await
}

/// Variante sem response_format json_object — para respostas de texto livre.
async fn call_gpt_text(
    system: &str,
    user: &str,
    api_key: &str,
    model: &str,
    max_tokens: u32,
) -> Result<String> {
    call_gpt_inner(system, user, api_key, model, max_tokens, false).await
}

async fn call_gpt_inner(
    system: &str,
    user: &str,
    api_key: &str,
    model: &str,
    max_tokens: u32,
    json_mode: bool,
) -> Result<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .context("Falha ao criar cliente HTTP")?;

    let mut body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user",   "content": user }
        ],
        "temperature": 0.3,
        "max_tokens": max_tokens
    });
    if json_mode {
        body["response_format"] = json!({ "type": "json_object" });
    }

    let resp = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .context("Falha ao chamar API GPT")?;

    let status = resp.status();
    if !status.is_success() {
        let err = resp.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!("GPT erro ({}): {}", status, err));
    }

    let chat: ChatResponse = resp.json().await.context("Falha ao parsear resposta GPT")?;
    Ok(chat
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_default())
}

// ─── Feature 8: Resumo com template ──────────────────────────────────────────

/// Gera um resumo estruturado da reunião usando o template adequado ao tipo.
pub async fn generate_summary(
    transcript: &str,
    api_key: &str,
    model: &str,
    meeting_type: &MeetingType,
) -> Result<MeetingSummary> {
    if transcript.trim().len() < 50 {
        return Ok(MeetingSummary {
            summary: "Transcrição muito curta para gerar um resumo significativo.".to_string(),
            ..Default::default()
        });
    }

    let system = summary_system_prompt(meeting_type);
    let user = format!(
        "Analise a transcrição abaixo e gere o resumo JSON:\n\n---\n{transcript}\n---"
    );

    let content = call_gpt(&system, &user, api_key, model, 2000).await?;

    let mut summary: MeetingSummary =
        serde_json::from_str(&content)
            .context(format!("Falha ao parsear resumo JSON: {content}"))?;

    // followup_email é gerado separadamente (Feature 9)
    summary.followup_email = None;

    Ok(summary)
}

// ─── Feature 9: E-mail de follow-up ──────────────────────────────────────────

/// Gera um rascunho de e-mail de follow-up baseado no resumo da reunião.
pub async fn generate_followup_email(
    transcript: &str,
    summary: &MeetingSummary,
    api_key: &str,
    model: &str,
) -> Result<String> {
    let system = r#"Você é um assistente especializado em comunicação profissional.
Gere um e-mail de follow-up em português do Brasil, profissional e conciso.

Responda em JSON com este formato:
{
  "email": "texto completo do e-mail incluindo Assunto, saudação, corpo e assinatura"
}

O e-mail deve:
- Ter um assunto claro na primeira linha (ex: "Assunto: Reunião – Próximos Passos")
- Ser profissional e amigável
- Listar as decisões tomadas de forma clara
- Listar as tarefas com responsáveis
- Terminar com próximos passos ou call-to-action"#;

    let decisions_text = if summary.decisions.is_empty() {
        "Nenhuma decisão formal registrada.".to_string()
    } else {
        summary.decisions.iter().map(|d| format!("• {d}")).collect::<Vec<_>>().join("\n")
    };

    let tasks_text = if summary.tasks.is_empty() {
        "Nenhuma tarefa atribuída.".to_string()
    } else {
        summary.tasks.iter().map(|t| format!("• {t}")).collect::<Vec<_>>().join("\n")
    };

    let user = format!(
        "Resumo da reunião: {}\n\nDecisões:\n{}\n\nTarefas:\n{}\n\n\
         Gere o e-mail de follow-up.",
        summary.summary, decisions_text, tasks_text
    );

    let content = call_gpt(system, &user, api_key, model, 1000).await?;

    #[derive(Deserialize)]
    struct EmailResp {
        email: String,
    }

    let resp: EmailResp =
        serde_json::from_str(&content)
            .context(format!("Falha ao parsear e-mail JSON: {content}"))?;

    Ok(resp.email)
}

// ─── Feature 10: Diarização via IA ───────────────────────────────────────────

/// Analisa a transcrição e identifica os turnos de fala dos participantes.
/// Usa GPT para inferir mudanças de falante com base no contexto textual
/// (sem análise de áudio — pseudo-diarização por linguagem natural).
pub async fn diarize_transcript(
    transcript: &str,
    api_key: &str,
    model: &str,
) -> Result<Vec<SpeakerSegment>> {
    if transcript.trim().len() < 30 {
        return Ok(Vec::new());
    }

    let system = r#"Você é um especialista em análise de conversas.
Analise a transcrição e identifique os diferentes falantes, dividindo o texto em turnos de fala.

Use nomes reais se mencionados na transcrição. Caso contrário, use "Participante A", "Participante B", etc.

Responda em JSON com este formato:
{
  "segments": [
    { "speaker": "Nome ou Participante A", "text": "trecho de fala", "index": 0 },
    { "speaker": "Nome ou Participante B", "text": "trecho de fala", "index": 1 }
  ]
}

Regras:
- Agrupe falas consecutivas do mesmo participante
- Identifique mudanças de interlocutor por marcadores contextuais (perguntas, respostas, mudanças de tema)
- Máximo de 6 participantes diferentes
- Responda SEMPRE em português do Brasil"#;

    let user = format!(
        "Identifique os falantes nesta transcrição:\n\n---\n{transcript}\n---"
    );

    let content = call_gpt(system, &user, api_key, model, 3000).await?;

    #[derive(Deserialize)]
    struct DiarizationResp {
        segments: Vec<SpeakerSegment>,
    }

    let resp: DiarizationResp =
        serde_json::from_str(&content)
            .context(format!("Falha ao parsear diarização JSON: {content}"))?;

    Ok(resp.segments)
}

// ─── Feature 29: Perguntas à transcrição ─────────────────────────────────────

/// Responde uma pergunta sobre o conteúdo da transcrição usando GPT.
pub async fn ask_about_transcript(
    question: &str,
    transcript: &str,
    api_key: &str,
    model: &str,
) -> Result<String> {
    if transcript.trim().is_empty() {
        return Err(anyhow::anyhow!("Transcrição vazia — não é possível responder perguntas"));
    }

    let system = "Você é um assistente que responde perguntas sobre transcrições de reuniões.\
\nSeja objetivo e baseie-se apenas no conteúdo fornecido.\
\nSe a informação não estiver na transcrição, diga isso claramente.\
\nResponda sempre em português do Brasil.";

    let user = format!(
        "Transcrição da reunião:\n---\n{transcript}\n---\n\nPergunta: {question}"
    );

    call_gpt_text(system, &user, api_key, model, 800).await
}

// ─── Utilitários ──────────────────────────────────────────────────────────────

pub fn default_model() -> &'static str {
    "gpt-4o-mini"
}
