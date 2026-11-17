use std::{
    fs,
    path::{Component, Path, PathBuf},
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

// The recipe path is the one `--config` names, relative to the project. It may not leave the
// project, so the app reads only the registered project's files.
fn recipe_path(project: &Path, config: &str) -> Result<PathBuf, String> {
    let relative = Path::new(config);
    let stays_inside = relative.components().next().is_some()
        && relative
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir));
    if !stays_inside {
        return Err(format!("The recipe path {config} must be relative to the project and stay inside it."));
    }
    let path = project.join(relative);
    if path.exists() {
        let resolved = fs::canonicalize(&path).map_err(|error| error.to_string())?;
        if !resolved.starts_with(project) {
            return Err(format!("The recipe path {config} resolves outside the project."));
        }
    }
    Ok(path)
}

#[tauri::command]
fn inspect_project(path: String, config: String) -> Result<ProjectSnapshot, String> {
    let path = registered_path(path)?;
    Ok(ProjectSnapshot {
        recipe: read_json(&recipe_path(&path, &config)?)?,
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

#[cfg(test)]
mod tests {
    use super::recipe_path;
    use std::fs;

    #[test]
    fn recipe_path_stays_inside_the_project() {
        let project = fs::canonicalize(std::env::temp_dir()).unwrap();
        assert_eq!(
            recipe_path(&project, "recipes/calavera.json").unwrap(),
            project.join("recipes/calavera.json")
        );
        assert_eq!(
            recipe_path(&project, "./calavera.config.json").unwrap(),
            project.join("./calavera.config.json")
        );
        for config in ["", "/etc/calavera.json", "../calavera.config.json", "recipes/../../x.json"] {
            assert!(recipe_path(&project, config).is_err(), "{config} was accepted");
        }
    }
}
