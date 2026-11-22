//! The one Settings window: open it or focus it, ask it for a view, run doctor when its data is
//! old, and keep the app alive when it closes (plan criteria 55, 56, 62).

use tauri::{Emitter, Manager, RunEvent};

pub const LABEL: &str = "settings";
/// The event the webview listens to for a view change (`app/src/ipc.ts`).
pub const VIEW_EVENT: &str = "settings-view";
/// Criterion 62: doctor runs on open unless one started within this long.
pub const CHECK_GAP_MS: i64 = 30_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    Status,
    Server,
    SetUp,
}

impl View {
    /// The name the webview knows the view by.
    pub fn name(self) -> &'static str {
        match self {
            View::Status => "status",
            View::Server => "server",
            View::SetUp => "setup",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Opened {
    Created,
    Focused,
}

/// Criterion 62: true when no doctor run started within the last 30 s.
pub fn check_due(last_started: Option<i64>, now: i64) -> bool {
    last_started.is_none_or(|t| now - t >= CHECK_GAP_MS)
}

/// The window operations Settings needs; the app's is Tauri, tests use a fake.
pub trait Windows {
    fn exists(&self) -> bool;
    /// Shows and focuses the open window and sends it `VIEW_EVENT` with the view name.
    fn focus(&self, view: View) -> tauri::Result<()>;
    /// Builds the window from config with the view as its URL fragment, and focuses it.
    fn create(&self, view: View) -> tauri::Result<()>;
}

pub struct TauriWindows<'a>(pub &'a tauri::AppHandle);

impl Windows for TauriWindows<'_> {
    fn exists(&self) -> bool {
        self.0.get_webview_window(LABEL).is_some()
    }

    fn focus(&self, view: View) -> tauri::Result<()> {
        let window = self.0.get_webview_window(LABEL).ok_or(tauri::Error::WindowNotFound)?;
        window.show()?;
        window.set_focus()?;
        window.emit(VIEW_EVENT, view.name())
    }

    fn create(&self, view: View) -> tauri::Result<()> {
        // A fresh page learns its view from the URL; an event sent now would arrive before it listens.
        crate::nav::settings_window(self.0, view.name()).build()?.set_focus()
    }
}

/// Shows the single Settings window on `view`: builds it, or focuses the one that exists.
pub fn open(windows: &dyn Windows, view: View) -> tauri::Result<Opened> {
    if windows.exists() {
        windows.focus(view)?;
        Ok(Opened::Focused)
    } else {
        windows.create(view)?;
        Ok(Opened::Created)
    }
}

/// Settings…, Set Up… and Review Server Key…: open the window, then run doctor once when its
/// last start is old. `run_check` is the app's single-flight Run Check.
pub fn show(
    windows: &dyn Windows,
    view: View,
    last_check_started: Option<i64>,
    now: i64,
    run_check: impl FnOnce(),
) -> tauri::Result<Opened> {
    let opened = open(windows, view)?;
    if check_due(last_check_started, now) {
        run_check();
    }
    Ok(opened)
}

/// Only an exit someone asked for (`app.exit(code)`, Quit) ends the app; the request that closing
/// the last window raises carries no code (criterion 56).
pub fn exit_allowed(code: Option<i32>) -> bool {
    code.is_some()
}

/// Closing the last window is not quitting: only Quit leaves (criterion 56). Pass every run event.
pub fn keep_running(event: &RunEvent) {
    if let RunEvent::ExitRequested { code, api, .. } = event {
        if !exit_allowed(*code) {
            api.prevent_exit();
        }
    }
}
