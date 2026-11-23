//! The Settings webview stays on the app's own pages (plan criterion 84).

use tauri::{Runtime, Url};

/// The app's own origin: `tauri://localhost` on macOS and Linux, `http://tauri.localhost` on
/// Windows; the Vite dev server only in debug builds.
pub fn navigation_allowed(url: &Url) -> bool {
    matches!(
        (url.scheme(), url.host_str(), url.port()),
        ("tauri", Some("localhost"), None) | ("http" | "https", Some("tauri.localhost"), None)
    ) || (cfg!(debug_assertions) && (url.scheme(), url.host_str(), url.port()) == ("http", Some("localhost"), Some(1420)))
}

/// Every new-window request is refused.
pub fn new_window<R: Runtime>(_url: Url) -> tauri::webview::NewWindowResponse<R> {
    tauri::webview::NewWindowResponse::Deny
}

/// The one Settings window, from `tauri.conf.json` (640×560, fixed, transparent over the OS
/// material), with the navigation and new-window policy attached.
/// `view` becomes the URL fragment the page reads its first view from.
pub fn settings_window<'a, R: Runtime, M: tauri::Manager<R>>(manager: &'a M, view: &str) -> tauri::WebviewWindowBuilder<'a, R, M> {
    let mut config = manager
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == crate::settings::LABEL)
        .expect("tauri.conf.json defines the settings window")
        .clone();
    config.url = tauri::WebviewUrl::App(format!("index.html#{view}").into());
    tauri::WebviewWindowBuilder::from_config(manager, &config)
        .expect("the settings window config is valid")
        .on_navigation(navigation_allowed)
        .on_new_window(|url, _features| new_window(url))
}
