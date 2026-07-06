/// The packaged app spawns the Python backend (PyInstaller bundle in
/// resources) as a child process and kills it when the app exits.
/// Dev builds skip this — `uvicorn --reload` is run by hand as before.
struct BackendChild(std::sync::Mutex<Option<std::process::Child>>);

impl BackendChild {
    fn kill(&self) {
        if let Some(mut child) = self.0.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(not(debug_assertions))]
fn spawn_backend(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager;

    let resources = app.path().resource_dir()?;
    let exe_name = if cfg!(windows) {
        "audioedit-backend.exe"
    } else {
        "audioedit-backend"
    };
    let backend = resources.join("backend/audioedit-backend").join(exe_name);
    let data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir).ok();

    let child = std::process::Command::new(&backend)
        .arg("--port")
        .arg("8756")
        .env("AUDIOEDIT_DATA_DIR", &data_dir)
        .spawn()?;
    app.manage(BackendChild(std::sync::Mutex::new(Some(child))));
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|_app| {
            #[cfg(not(debug_assertions))]
            spawn_backend(_app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    // RunEvent::Exit fires reliably on Cmd+Q / window close / quit — more
    // dependable than WindowEvent::Destroyed for reaping the sidecar so the
    // backend never lingers after the app is gone.
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            use tauri::Manager;
            if let Some(backend) = handle.try_state::<BackendChild>() {
                backend.kill();
            }
        }
    });
}
