use std::str::FromStr;
use tauri::{Manager, Emitter};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[tauri::command]
fn set_content_protected(window: tauri::WebviewWindow, protected: bool) -> Result<(), String> {
    window.set_content_protected(protected).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_click_through(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    window.set_ignore_cursor_events(enabled).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_always_on_top(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    window.set_always_on_top(enabled).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_skip_taskbar(window: tauri::WebviewWindow, skip: bool) -> Result<(), String> {
    window.set_skip_taskbar(skip).map_err(|e| e.to_string())
}

#[tauri::command]
fn toggle_visibility(window: tauri::WebviewWindow) -> Result<(), String> {
    let visible = window.is_visible().map_err(|e| e.to_string())?;
    if visible {
        window.hide().map_err(|e| e.to_string())
    } else {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())
    }
}

/// Replace the currently registered global shortcut with a new one (e.g. "Ctrl+Shift+H").
#[tauri::command]
fn set_toggle_shortcut(app: tauri::AppHandle, shortcut: String) -> Result<(), String> {
    let parsed = Shortcut::from_str(&shortcut)
        .map_err(|e| format!("Atajo inválido '{}': {}", shortcut, e))?;
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    gs.register(parsed).map_err(|e| e.to_string())
}

/// Mascot was clicked. Surface the main window and tell it which chat to open.
/// Doing this in Rust is more reliable than emitting cross-window from JS because
/// the main window may be hidden and the click happens in a separate webview.
#[tauri::command]
fn mascot_clicked(app: tauri::AppHandle, room_id: Option<String>) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_ignore_cursor_events(false);
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
        if let Some(rid) = room_id {
            let _ = main.emit("mascot:open-chat-route", rid);
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // We only ever register one shortcut at a time (the user can rebind it),
                    // so any press here is the toggle command.
                    if event.state() == ShortcutState::Pressed {
                        if let Some(window) = app.get_webview_window("main") {
                            let visible = window.is_visible().unwrap_or(false);
                            let minimized = window.is_minimized().unwrap_or(false);
                            if visible && !minimized {
                                let _ = window.hide();
                            } else {
                                let _ = window.unminimize();
                                let _ = window.set_ignore_cursor_events(false);
                                let _ = window.show();
                                let _ = window.set_focus();
                                let _ = window.emit("click-through-disabled", ());
                            }
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Register global hotkey Ctrl+Shift+H. Don't fail setup if another instance
            // already holds it — just warn so the user can still use the app.
            let toggle = Shortcut::new(
                Some(Modifiers::CONTROL | Modifiers::SHIFT),
                Code::KeyH,
            );
            if let Err(e) = app.global_shortcut().register(toggle) {
                eprintln!(
                    "[stealth-chat] Could not register Ctrl+Shift+H: {e}. \
                     Probably another instance is already running."
                );
            }

            // Notify frontend on focus events + close the mascot when main goes away
            // so the process actually quits instead of leaving an orphaned mascot.
            if let Some(window) = app.get_webview_window("main") {
                let w = window.clone();
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    match event {
                        tauri::WindowEvent::Focused(focused) => {
                            let _ = w.emit("window-focus", *focused);
                        }
                        tauri::WindowEvent::CloseRequested { .. }
                        | tauri::WindowEvent::Destroyed => {
                            if let Some(mascot) = app_handle.get_webview_window("mascot") {
                                let _ = mascot.close();
                            }
                        }
                        _ => {}
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_content_protected,
            set_click_through,
            set_always_on_top,
            set_skip_taskbar,
            toggle_visibility,
            set_toggle_shortcut,
            mascot_clicked,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
