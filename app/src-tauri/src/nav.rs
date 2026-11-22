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

/// The one Settings window, with the navigation and new-window policy attached.
pub fn settings_window<R: Runtime, M: tauri::Manager<R>>(manager: &M) -> tauri::WebviewWindowBuilder<'_, R, M> {
    tauri::WebviewWindowBuilder::new(manager, "settings", tauri::WebviewUrl::App("index.html".into()))
        .title("social-tunnel")
        .inner_size(640.0, 520.0)
        .resizable(false)
        .on_navigation(navigation_allowed)
        .on_new_window(|url, _features| new_window(url))
}
