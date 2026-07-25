use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use serde::Serialize;
use serde_json::Value;
use tauri::{menu::{Menu, MenuItem}, tray::TrayIconBuilder, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSnapshot {
    path: PathBuf,
    recipe: Option<Value>,
    lock: Option<Value>,
    state: Option<Value>,
}

fn read_json(path: &Path) -> Result<Option<Value>, String> {
    if !path.exists() { return Ok(None); }
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map(Some).map_err(|error| error.to_string())
}

fn registered_path(path: String) -> Result<PathBuf, String> {
    let path = fs::canonicalize(path).map_err(|error| error.to_string())?;
    if !path.is_dir() { return Err("Registered project path must be a directory.".into()); }
    Ok(path)
}

#[tauri::command]
fn inspect_project(path: String) -> Result<ProjectSnapshot, String> {
    let path = registered_path(path)?;
    Ok(ProjectSnapshot {
        recipe: read_json(&path.join("calavera.config.json"))?,
        lock: read_json(&path.join(".calavera/artifacts.lock.json"))?,
        state: read_json(&path.join(".calavera/state.json"))?,
        path,
    })
}

#[tauri::command]
fn open_terminal(path: String, application: String) -> Result<(), String> {
    let path = registered_path(path)?;
    let application = application.trim();
    if application.is_empty() {
        return Err("A preferred terminal application is required.".into());
    }
    let output = Command::new("/usr/bin/open")
        .args(["-a", application])
        .arg(path)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if message.is_empty() {
            format!("macOS could not open {application}.")
        } else {
            message
        })
    }
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with(
        "https://github.com/schalkneethling/create-project-calavera/releases/",
    ) {
        return Err("Only Calavera release URLs may be opened.".into());
    }
    Command::new("/usr/bin/open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![inspect_project, open_terminal, open_url])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory)?;
            let show = MenuItem::with_id(app, "show", "Show Calavera", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("app icon").clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Calavera menu-bar companion");
}
