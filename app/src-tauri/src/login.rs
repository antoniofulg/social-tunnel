//! Open at Login through `tauri-plugin-autostart` as a LaunchAgent (plan criterion 78, Landing 7).

#[cfg(target_os = "macos")]
use std::path::Path;

/// The login item's LaunchAgent label and plist name. Never the user's own
/// `tech.antoniofulg.social-tunnel`: a login item under that label would overwrite its plist.
pub const LABEL: &str = "tech.antoniofulg.social-tunnel.tray";

/// The login-item operations the app needs; the app's is the autostart plugin, tests use a fake.
pub trait LoginItem {
    fn enable(&self) -> Result<(), String>;
    fn disable(&self) -> Result<(), String>;
    fn is_enabled(&self) -> Result<bool, String>;
}

/// Switches the login item and returns the state read back after the call, or `autostart_failed`.
pub fn set(item: &dyn LoginItem, enabled: bool) -> Result<bool, String> {
    let changed = if enabled { item.enable() } else { item.disable() };
    changed.and_then(|()| item.is_enabled()).map_err(|_| "autostart_failed".to_string())
}

/// The state to show; an unreadable login item shows unchecked.
pub fn read(item: &dyn LoginItem) -> bool {
    item.is_enabled().unwrap_or(false)
}

/// Only register the canonical path the plugin will put in the macOS login plist.
#[cfg(target_os = "macos")]
pub fn enable_installed(
    home: &Path,
    executable: &Path,
    enable: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let home = home.canonicalize().map_err(|_| "autostart_failed")?;
    let executable = executable.canonicalize().map_err(|_| "autostart_failed")?;
    if executable != home.join("Applications/social-tunnel.app/Contents/MacOS/social-tunnel-app") {
        return Err("autostart_failed".into());
    }
    enable()
}

pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let builder = tauri_plugin_autostart::Builder::new().app_name(LABEL);
    #[cfg(target_os = "macos")]
    let builder = builder.macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent);
    builder.build()
}

pub struct Autostart<'a, R: tauri::Runtime>(pub &'a tauri::AppHandle<R>);

impl<R: tauri::Runtime> LoginItem for Autostart<'_, R> {
    fn enable(&self) -> Result<(), String> {
        use tauri_plugin_autostart::ManagerExt;
        let enable = || self.0.autolaunch().enable().map_err(|e| e.to_string());
        #[cfg(target_os = "macos")]
        {
            use tauri::Manager;
            let home = self.0.path().home_dir().map_err(|_| "autostart_failed")?;
            let executable = std::env::current_exe().map_err(|_| "autostart_failed")?;
            enable_installed(&home, &executable, enable)
        }
        #[cfg(not(target_os = "macos"))]
        enable()
    }
    fn disable(&self) -> Result<(), String> {
        use tauri_plugin_autostart::ManagerExt;
        self.0.autolaunch().disable().map_err(|e| e.to_string())
    }
    fn is_enabled(&self) -> Result<bool, String> {
        use tauri_plugin_autostart::ManagerExt;
        self.0.autolaunch().is_enabled().map_err(|e| e.to_string())
    }
}
