//! Open at Login through the platform backend (plan criterion 78, Landing 15 on macOS).

#[cfg(target_os = "macos")]
use auto_launch::{AutoLaunch, MacOSLaunchMode};
#[cfg(target_os = "macos")]
use std::path::Path;

/// The login item's LaunchAgent label and plist name. Never the user's own
/// `tech.antoniofulg.social-tunnel`: a login item under that label would overwrite its plist.
pub const LABEL: &str = "tech.antoniofulg.social-tunnel.tray";

/// The login-item operations shared by the native menu and Settings.
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

/// Keep the startup-resolved program in the backend, not the launch alias.
#[cfg(target_os = "macos")]
pub struct MacLogin(AutoLaunch);

#[cfg(target_os = "macos")]
impl MacLogin {
    pub fn new(home: Option<&Path>, executable: &Path) -> Self {
        let program = (|| {
            let installed = home?.canonicalize().ok()?
                .join("Applications/social-tunnel.app/Contents/MacOS/social-tunnel-app");
            let canonical = executable.canonicalize().ok()?;
            if canonical != installed {
                return None;
            }
            // The pinned LaunchAgent backend interpolates its program into XML without escaping.
            let program = canonical.to_str()?;
            if program.chars().any(|c| c.is_control() || matches!(c, '&' | '<' | '>' | '\u{fffe}' | '\u{ffff}')) {
                return None;
            }
            Some(canonical)
        })();
        // Disable/read-back depend only on the label, even outside the installed app.
        Self(AutoLaunch::new(
            LABEL,
            program.as_deref().and_then(Path::to_str).unwrap_or(""),
            MacOSLaunchMode::LaunchAgent,
            &[] as &[&str],
            &[] as &[&str],
            "",
        ))
    }
}

#[cfg(target_os = "macos")]
impl LoginItem for MacLogin {
    fn enable(&self) -> Result<(), String> {
        let program = Path::new(self.0.get_app_path());
        // Refuse a replacement symlink or removed installation without resolving the launch alias again.
        if !program.is_absolute() || !program.canonicalize().is_ok_and(|p| p == program) {
            return Err("autostart_failed".into());
        }
        self.0.enable().map_err(|e| e.to_string())
    }

    fn disable(&self) -> Result<(), String> {
        self.0.disable().map_err(|e| e.to_string())
    }

    fn is_enabled(&self) -> Result<bool, String> {
        self.0.is_enabled().map_err(|e| e.to_string())
    }
}

#[cfg(not(target_os = "macos"))]
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_autostart::Builder::new().app_name(LABEL).build()
}

pub struct Autostart<'a, R: tauri::Runtime>(pub &'a tauri::AppHandle<R>);

#[cfg(target_os = "macos")]
impl<R: tauri::Runtime> LoginItem for Autostart<'_, R> {
    fn enable(&self) -> Result<(), String> {
        use tauri::Manager;
        self.0.state::<MacLogin>().enable()
    }

    fn disable(&self) -> Result<(), String> {
        use tauri::Manager;
        self.0.state::<MacLogin>().disable()
    }

    fn is_enabled(&self) -> Result<bool, String> {
        use tauri::Manager;
        self.0.state::<MacLogin>().is_enabled()
    }
}

#[cfg(not(target_os = "macos"))]
impl<R: tauri::Runtime> LoginItem for Autostart<'_, R> {
    fn enable(&self) -> Result<(), String> {
        use tauri_plugin_autostart::ManagerExt;
        self.0.autolaunch().enable().map_err(|e| e.to_string())
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
