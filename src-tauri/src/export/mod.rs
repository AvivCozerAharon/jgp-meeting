/// export/mod.rs — Feature 4
/// Exporta reuniões para .txt e .md na pasta Documentos/JGP Meeting.
/// Permite abrir a pasta no explorador de arquivos do sistema.
use anyhow::{Context, Result};
use std::fs;
use std::path::PathBuf;

use crate::ai::MeetingSummary;
use crate::storage::Meeting;

// ─── Exportação ───────────────────────────────────────────────────────────────

/// Exporta a reunião como texto plano (.txt) e retorna o caminho do arquivo.
pub fn export_txt(meeting: &Meeting) -> Result<String> {
    let path = export_path(meeting, "txt")?;
    fs::write(&path, format_txt(meeting))
        .context(format!("Falha ao escrever {}", path.display()))?;
    log::info!("Exportado TXT: {}", path.display());
    Ok(path.to_string_lossy().to_string())
}

/// Exporta a reunião como Markdown (.md) e retorna o caminho do arquivo.
pub fn export_md(meeting: &Meeting) -> Result<String> {
    let path = export_path(meeting, "md")?;
    fs::write(&path, format_md(meeting))
        .context(format!("Falha ao escrever {}", path.display()))?;
    log::info!("Exportado MD: {}", path.display());
    Ok(path.to_string_lossy().to_string())
}

/// Abre a pasta de exportações no explorador de arquivos do sistema.
pub fn open_export_folder() -> Result<()> {
    let folder = base_export_dir()?;
    open::that(&folder).context(format!("Falha ao abrir pasta: {}", folder.display()))?;
    Ok(())
}

/// Abre o arquivo específico no aplicativo padrão do sistema.
pub fn open_file(path: &str) -> Result<()> {
    open::that(path).context(format!("Falha ao abrir arquivo: {path}"))?;
    Ok(())
}

// ─── Formatadores ─────────────────────────────────────────────────────────────

fn format_txt(meeting: &Meeting) -> String {
    let mut out = String::new();
    let sep = "=".repeat(60);

    out.push_str(&format!("{}\n", sep));
    out.push_str(&format!("  {}\n", meeting.title));
    out.push_str(&format!("{}\n\n", sep));

    if let Some(mt) = &meeting.meeting_type {
        out.push_str(&format!("Tipo: {} {}\n", mt.icon(), mt.label()));
    }

    let started = meeting.started_at.format("%d/%m/%Y às %H:%M").to_string();
    out.push_str(&format!("Data: {}\n", started));

    if meeting.duration_secs > 0 {
        let mins = meeting.duration_secs / 60;
        let secs = meeting.duration_secs % 60;
        out.push_str(&format!("Duração: {}m{}s\n", mins, secs));
    }

    out.push('\n');
    out.push_str(&format!("{}\n", "-".repeat(60)));
    out.push_str("TRANSCRIÇÃO\n");
    out.push_str(&format!("{}\n\n", "-".repeat(60)));

    if meeting.transcript.is_empty() {
        out.push_str("(sem transcrição)\n");
    } else {
        out.push_str(&meeting.transcript);
        out.push('\n');
    }

    // Falantes (Feature 10)
    if let Some(speakers) = &meeting.speakers {
        if !speakers.is_empty() {
            out.push('\n');
            out.push_str(&format!("{}\n", "-".repeat(60)));
            out.push_str("FALANTES IDENTIFICADOS\n");
            out.push_str(&format!("{}\n\n", "-".repeat(60)));
            for seg in speakers {
                out.push_str(&format!("[{}]\n{}\n\n", seg.speaker, seg.text));
            }
        }
    }

    // Resumo
    if let Some(summary) = &meeting.summary {
        out.push_str(&format!("{}\n", "-".repeat(60)));
        out.push_str("RESUMO\n");
        out.push_str(&format!("{}\n\n", "-".repeat(60)));
        format_summary_txt(&mut out, summary);
    }

    out
}

fn format_md(meeting: &Meeting) -> String {
    let mut out = String::new();

    out.push_str(&format!("# {}\n\n", meeting.title));

    // Metadados
    out.push_str("## 📋 Informações\n\n");
    if let Some(mt) = &meeting.meeting_type {
        out.push_str(&format!("- **Tipo:** {} {}\n", mt.icon(), mt.label()));
    }
    let started = meeting.started_at.format("%d/%m/%Y às %H:%M").to_string();
    out.push_str(&format!("- **Data:** {}\n", started));
    if meeting.duration_secs > 0 {
        let mins = meeting.duration_secs / 60;
        let secs = meeting.duration_secs % 60;
        out.push_str(&format!("- **Duração:** {}m{}s\n", mins, secs));
    }
    out.push('\n');

    // Transcrição
    out.push_str("## 🎙️ Transcrição\n\n");
    if meeting.transcript.is_empty() {
        out.push_str("*(sem transcrição)*\n\n");
    } else {
        out.push_str(&meeting.transcript);
        out.push_str("\n\n");
    }

    // Falantes (Feature 10)
    if let Some(speakers) = &meeting.speakers {
        if !speakers.is_empty() {
            out.push_str("## 👥 Falantes Identificados\n\n");
            for seg in speakers {
                out.push_str(&format!("**{}:** {}\n\n", seg.speaker, seg.text));
            }
        }
    }

    // Resumo
    if let Some(summary) = &meeting.summary {
        format_summary_md(&mut out, summary);
    }

    // Rodapé
    out.push_str("---\n");
    out.push_str("*Gerado por JGP Meeting*\n");
    out
}

fn format_summary_txt(out: &mut String, s: &MeetingSummary) {
    out.push_str(&format!("Resumo:\n{}\n\n", s.summary));

    if !s.decisions.is_empty() {
        out.push_str("Decisões:\n");
        for d in &s.decisions {
            out.push_str(&format!("  • {}\n", d));
        }
        out.push('\n');
    }
    if !s.tasks.is_empty() {
        out.push_str("Tarefas:\n");
        for t in &s.tasks {
            out.push_str(&format!("  • {}\n", t));
        }
        out.push('\n');
    }
    if !s.key_points.is_empty() {
        out.push_str("Pontos Importantes:\n");
        for k in &s.key_points {
            out.push_str(&format!("  • {}\n", k));
        }
        out.push('\n');
    }
    if let Some(email) = &s.followup_email {
        out.push_str("E-mail de Follow-up:\n");
        out.push_str(email);
        out.push('\n');
    }
}

fn format_summary_md(out: &mut String, s: &MeetingSummary) {
    out.push_str("## 🤖 Resumo Gerado por IA\n\n");
    out.push_str(&format!("{}\n\n", s.summary));

    if !s.decisions.is_empty() {
        out.push_str("### ✅ Decisões\n\n");
        for d in &s.decisions {
            out.push_str(&format!("- {}\n", d));
        }
        out.push('\n');
    }
    if !s.tasks.is_empty() {
        out.push_str("### 📌 Tarefas\n\n");
        for t in &s.tasks {
            out.push_str(&format!("- {}\n", t));
        }
        out.push('\n');
    }
    if !s.key_points.is_empty() {
        out.push_str("### 💡 Pontos Importantes\n\n");
        for k in &s.key_points {
            out.push_str(&format!("- {}\n", k));
        }
        out.push('\n');
    }
    if let Some(email) = &s.followup_email {
        out.push_str("### 📧 E-mail de Follow-up\n\n");
        out.push_str("```\n");
        out.push_str(email);
        out.push_str("\n```\n\n");
    }
}

// ─── Utilitários internos ─────────────────────────────────────────────────────

fn base_export_dir() -> Result<PathBuf> {
    let dir = dirs::document_dir()
        .context("Não foi possível localizar pasta Documentos")?
        .join("JGP Meeting");
    fs::create_dir_all(&dir).context("Falha ao criar pasta de exportações")?;
    Ok(dir)
}

fn export_path(meeting: &Meeting, ext: &str) -> Result<PathBuf> {
    let dir = base_export_dir()?;
    let safe_title = sanitize(&meeting.title);
    let short_id = &meeting.id[..8];
    Ok(dir.join(format!("{safe_title}_{short_id}.{ext}")))
}

fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("_")
}
