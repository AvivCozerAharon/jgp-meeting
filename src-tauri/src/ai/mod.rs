/// ai/mod.rs
/// Serviços de IA: geração de resumo, e-mail de follow-up e diarização de falantes.
/// Todos os modelos GPT são acessados via API OpenAI ou OpenRouter (chat completions).
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::storage::MeetingType;

pub const OPENAI_ENDPOINT: &str = "https://api.openai.com/v1/chat/completions";
pub const OPENROUTER_ENDPOINT: &str = "https://openrouter.ai/api/v1/chat/completions";

// ─── Tipos públicos ───────────────────────────────────────────────────────────

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
    endpoint: &str,
) -> Result<String> {
    call_gpt_inner(system, user, api_key, model, max_tokens, true, endpoint).await
}

/// Variante sem response_format json_object — para respostas de texto livre.
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

async fn call_gpt_inner(
    system: &str,
    user: &str,
    api_key: &str,
    model: &str,
    max_tokens: u32,
    json_mode: bool,
    endpoint: &str,
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

    let mut req = client
        .post(endpoint)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json");

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
    endpoint: &str,
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

    let content = call_gpt(&system, &user, api_key, model, 3000, endpoint).await?;

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
    endpoint: &str,
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

    let user = format!(
        "Resumo da reunião:\n{}\n\nGere o e-mail de follow-up.",
        summary.summary
    );

    let content = call_gpt(system, &user, api_key, model, 1000, endpoint).await?;

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
    endpoint: &str,
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

    let content = call_gpt(system, &user, api_key, model, 3000, endpoint).await?;

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
    endpoint: &str,
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

    call_gpt_text(system, &user, api_key, model, 800, endpoint).await
}

// ─── Utilitários ──────────────────────────────────────────────────────────────

pub fn default_model() -> &'static str {
    "gpt-4o-mini"
}
