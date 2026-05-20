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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        if let Some(window) = app.get_webview_window("main") {
                            let toggle = Shortcut::new(
                                Some(Modifiers::CONTROL | Modifiers::SHIFT),
                                Code::KeyH,
                            );
                            if shortcut == &toggle {
                                let visible = window.is_visible().unwrap_or(false);
                                let minimized = window.is_minimized().unwrap_or(false);
                                // Restore if hidden OR minimized. Only hide when truly visible on screen.
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
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Register global hotkey Ctrl+Shift+H
            let toggle = Shortcut::new(
                Some(Modifiers::CONTROL | Modifiers::SHIFT),
                Code::KeyH,
            );
            app.global_shortcut().register(toggle)?;

            // Notify frontend on focus events so it can hint stealth status
            if let Some(window) = app.get_webview_window("main") {
                let w = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(focused) = event {
                        let _ = w.emit("window-focus", *focused);
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
