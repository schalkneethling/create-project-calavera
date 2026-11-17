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
    recipe_error: Option<String>,
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
    let stays_inside = relative
        .components()
        .any(|component| matches!(component, Component::Normal(_)))
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
    // A recipe that cannot be read or parsed is reported with its cause instead of failing the
    // whole check, so the project's updates stay listed.
    let (recipe, recipe_error) = match read_json(&recipe_path(&path, &config)?) {
        Ok(recipe) => (recipe, None),
        Err(error) => (None, Some(error)),
    };
    Ok(ProjectSnapshot {
        recipe,
        recipe_error,
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
    use super::{inspect_project, recipe_path};
    use std::{
        fs,
        os::unix::fs::symlink,
        path::{Path, PathBuf},
    };

    // A project directory and a sibling directory outside it, removed when the test ends.
    struct Tree {
        root: PathBuf,
        project: PathBuf,
        outside: PathBuf,
    }

    impl Tree {
        fn new(name: &str) -> Self {
            let root = fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!("calavera-menu-bar-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            let project = root.join("project");
            let outside = root.join("outside");
            fs::create_dir_all(&project).unwrap();
            fs::create_dir_all(&outside).unwrap();
            Tree { root, project, outside }
        }

        fn write(&self, path: &Path, contents: &str) {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn a_linked_recipe_file_outside_the_project_is_refused() {
        let tree = Tree::new("linked-file");
        tree.write(&tree.outside.join("calavera.json"), "{}");
        symlink(tree.outside.join("calavera.json"), tree.project.join("calavera.config.json"))
            .unwrap();
        let error = recipe_path(&tree.project, "calavera.config.json").unwrap_err();
        assert!(error.contains("resolves outside the project"), "{error}");
    }

    #[test]
    fn a_linked_parent_directory_outside_the_project_is_refused() {
        let tree = Tree::new("linked-directory");
        tree.write(&tree.outside.join("calavera.json"), "{}");
        symlink(&tree.outside, tree.project.join("recipes")).unwrap();
        let error = recipe_path(&tree.project, "recipes/calavera.json").unwrap_err();
        assert!(error.contains("resolves outside the project"), "{error}");
    }

    #[test]
    fn links_that_stay_inside_the_project_are_accepted() {
        let tree = Tree::new("linked-inside");
        tree.write(&tree.project.join("config/calavera.json"), "{}");
        symlink(tree.project.join("config/calavera.json"), tree.project.join("calavera.config.json"))
            .unwrap();
        symlink(tree.project.join("config"), tree.project.join("recipes")).unwrap();
        assert_eq!(
            recipe_path(&tree.project, "calavera.config.json").unwrap(),
            tree.project.join("calavera.config.json")
        );
        assert_eq!(
            recipe_path(&tree.project, "recipes/calavera.json").unwrap(),
            tree.project.join("recipes/calavera.json")
        );
    }

    #[test]
    fn an_unreadable_recipe_keeps_the_rest_of_the_snapshot_and_its_cause() {
        let tree = Tree::new("invalid-recipe");
        tree.write(&tree.project.join("calavera.config.json"), "{ not json");
        tree.write(
            &tree.project.join(".calavera/artifacts.lock.json"),
            r#"{ "schemaVersion": 1, "artifacts": [] }"#,
        );
        let snapshot = inspect_project(
            tree.project.to_string_lossy().into_owned(),
            "calavera.config.json".into(),
        )
        .unwrap();
        assert!(snapshot.recipe.is_none());
        assert!(snapshot.lock.is_some());
        let error = snapshot.recipe_error.expect("the read error");
        assert!(error.contains("key must be a string"), "{error}");
    }

    #[test]
    fn a_missing_recipe_is_not_an_error() {
        let tree = Tree::new("missing-recipe");
        let snapshot = inspect_project(
            tree.project.to_string_lossy().into_owned(),
            "calavera.config.json".into(),
        )
        .unwrap();
        assert!(snapshot.recipe.is_none());
        assert!(snapshot.recipe_error.is_none());
    }

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
        for config in ["", ".", "/etc/calavera.json", "../calavera.config.json", "recipes/../../x.json"] {
            assert!(recipe_path(&project, config).is_err(), "{config} was accepted");
        }
    }
}
