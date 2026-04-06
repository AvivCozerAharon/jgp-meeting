// main.rs — JGP Meeting
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod audio;
mod commands;
mod detection;
mod export;
mod storage;
mod text_processing;
mod transcription;

use commands::AppState;
use tauri::{Emitter, Manager};

fn main() {
    env_logger::Builder::from_default_env()
        .filter_level(if cfg!(debug_assertions) {
            log::LevelFilter::Debug
        } else {
            log::LevelFilter::Warn
        })
        .init();

    log::info!("JGP Meeting iniciando...");

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            // Captura de áudio
            commands::start_capture,
            commands::stop_capture,
            commands::get_capture_status,
            commands::toggle_mic_mute,
            commands::toggle_pause_capture,
            commands::open_compliance_window,
            commands::close_compliance_window,
            commands::get_current_transcript,
            // Resumo IA (Feature 8: templates)
            commands::generate_summary,
            commands::generate_and_save_summary,
            // Feature 9: E-mail de follow-up
            commands::generate_followup_email,
            // Feature 10: Diarização
            commands::diarize_transcript,
            // Feature 4: Exportação
            commands::export_meeting,
            commands::open_export_folder,
            // Feature 8: Tipo de reunião
            commands::set_meeting_type,
            // Feature 12: Detecção de apps
            commands::check_meeting_apps,
            // Histórico
            commands::list_meetings,
            commands::get_meeting,
            commands::delete_meeting,
            // Configurações
            commands::get_settings,
            commands::save_settings,
            // Feature 13: Atalho global
            commands::register_global_shortcut,
            // Feature 29: Perguntas à transcrição
            commands::ask_about_transcript,
            // Download de modelo Whisper
            commands::download_whisper_model,
            commands::list_downloaded_whisper_models,
            // Microfones disponíveis
            commands::list_microphones,
            // Renomear + editar transcrição
            commands::update_meeting_meta,
            // Integração JGRC
            commands::export_to_jgrc,
            commands::jgrc_open_login,
            commands::jgrc_check_session,
            commands::jgrc_get_export_data,
        ])
        .setup(|app| {
            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }

            // Feature 14: System Tray
            setup_tray(app)?;

            // Feature 13: Atalho global (carregado das configurações)
            setup_global_shortcut(app);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Erro ao executar JGP Meeting");
}

// ─── Feature 14: System Tray ──────────────────────────────────────────────────

fn setup_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{
        menu::{Menu, MenuItem, PredefinedMenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };

    let show_item = MenuItem::with_id(app, "show", "Mostrar JGP Meeting", true, None::<&str>)?;
    let record_item = MenuItem::with_id(app, "toggle-record", "⏺  Iniciar Gravação", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show_item, &record_item, &separator, &quit_item])?;

    let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("JGP Meeting")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "toggle-record" => {
                let _ = app.emit("toggle-recording", ());
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

// ─── Feature 13: Atalho global ────────────────────────────────────────────────

fn setup_global_shortcut(app: &mut tauri::App) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let settings = storage::load_settings().unwrap_or_default();

    // Atalho de gravação
    let hotkey = settings.global_hotkey.clone();
    if !hotkey.is_empty() {
        let app_handle = app.handle().clone();
        if let Err(e) = app.global_shortcut().on_shortcut(
            hotkey.as_str(),
            move |_app, _s, event| {
                if event.state() == ShortcutState::Pressed {
                    let _ = app_handle.emit("toggle-recording", ());
                }
            },
        ) {
            log::warn!("Falha ao registrar atalho global '{hotkey}': {e}");
        } else {
            log::info!("Atalho global '{hotkey}' registrado");
        }
    }

    // Atalho de mute mic
    let mute_hotkey = settings.mute_mic_hotkey.clone();
    if !mute_hotkey.is_empty() {
        let app_handle = app.handle().clone();
        if let Err(e) = app.global_shortcut().on_shortcut(
            mute_hotkey.as_str(),
            move |_app, _s, event| {
                if event.state() == ShortcutState::Pressed {
                    let _ = app_handle.emit("toggle-mic-mute", ());
                }
            },
        ) {
            log::warn!("Falha ao registrar atalho mute mic '{mute_hotkey}': {e}");
        } else {
            log::info!("Atalho mute mic '{mute_hotkey}' registrado");
        }
    }
}
