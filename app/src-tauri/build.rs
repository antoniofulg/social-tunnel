// Tauri v2 lets the webview call every registered command unless an app manifest names them; this
// list makes the Settings capability's explicit `allow-*` permissions the only way in.
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "get_snapshot", "run_check", "copy_fix", "set_open_at_login",
            "get_domains", "edit_domain", "retry_domain_edit",
        ]),
    ))
    .expect("failed to run tauri-build");
}
