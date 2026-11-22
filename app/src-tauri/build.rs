// Tauri v2 lets the webview call every registered command unless an app manifest names them; this
// list makes the capability's four `allow-*` permissions the only way in (plan door 5).
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["get_snapshot", "run_check", "copy_fix", "set_open_at_login"]),
    ))
    .expect("failed to run tauri-build");
}
