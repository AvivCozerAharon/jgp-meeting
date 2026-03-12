/// detection/mod.rs — Feature 12
/// Detecta se algum aplicativo de reunião está em execução via enumeração de processos.
/// Usa o crate `sysinfo` para listar processos do sistema.
use sysinfo::System;

/// Informações sobre um app de reunião detectado.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DetectedApp {
    /// Nome amigável do app (ex: "Zoom", "Microsoft Teams")
    pub name: String,
    /// Nome do processo detectado (ex: "zoom.exe")
    pub process: String,
}

/// Lista de processos conhecidos de apps de reunião.
/// Cada entrada: (substring do nome do processo, nome amigável)
const MEETING_PROCESSES: &[(&str, &str)] = &[
    ("zoom",         "Zoom"),
    ("teams",        "Microsoft Teams"),
    ("webex",        "Cisco Webex"),
    ("slack",        "Slack"),
    ("discord",      "Discord"),
    ("skype",        "Skype"),
    ("meet",         "Google Meet"),
    ("gotomeeting",  "GoToMeeting"),
    ("whereby",      "Whereby"),
    ("ringcentral",  "RingCentral"),
];

/// Verifica quais apps de reunião estão rodando no momento.
/// Retorna a lista dos apps detectados (pode ser vazia).
pub fn detect_meeting_apps() -> Vec<DetectedApp> {
    let mut sys = System::new_all();
    sys.refresh_all();

    let mut detected: Vec<DetectedApp> = Vec::new();
    let mut seen_names: Vec<String> = Vec::new();

    for (_, process) in sys.processes() {
        let proc_name = process.name().to_lowercase();

        for &(pattern, label) in MEETING_PROCESSES {
            if proc_name.contains(pattern) && !seen_names.contains(&label.to_string()) {
                seen_names.push(label.to_string());
                detected.push(DetectedApp {
                    name: label.to_string(),
                    process: process.name().to_string(),
                });
                break;
            }
        }
    }

    if !detected.is_empty() {
        log::info!(
            "Apps de reunião detectados: {}",
            detected.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(", ")
        );
    }

    detected
}
