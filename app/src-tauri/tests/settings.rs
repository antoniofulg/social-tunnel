//! The Settings window (checks C55, C56, C62, C71 config half). Window selection runs against a
//! fake `Windows`: building a window under Tauri's mock runtime on a test worker thread crashes on
//! macOS (AppKit windows belong to the main thread). Reads tauri.conf.json, so it lives in tests/.

use serde_json::Value;
use social_tunnel_app_lib::settings::{self, Opened, View, Windows};
use std::cell::RefCell;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

fn conf() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn settings_config() -> Value {
    conf()["app"]["windows"].as_array().unwrap().iter().find(|w| w["label"] == "settings").unwrap().clone()
}

/// Records what the app asked of its windows; `open` holds the views of windows that exist.
#[derive(Default)]
struct FakeWindows {
    open: RefCell<Vec<View>>,
    created: RefCell<Vec<View>>,
    focused: RefCell<Vec<View>>,
}

impl Windows for FakeWindows {
    fn exists(&self) -> bool {
        !self.open.borrow().is_empty()
    }
    fn focus(&self, view: View) -> tauri::Result<()> {
        self.focused.borrow_mut().push(view);
        self.open.borrow_mut()[0] = view;
        Ok(())
    }
    fn create(&self, view: View) -> tauri::Result<()> {
        self.created.borrow_mut().push(view);
        self.open.borrow_mut().push(view);
        Ok(())
    }
}

#[test]
fn tray_c55_config_gives_one_fixed_640_by_560_settings_window() {
    let c = settings_config();
    assert_eq!((c["width"].as_f64(), c["height"].as_f64()), (Some(640.0), Some(560.0)));
    assert_eq!(c["resizable"], Value::Bool(false));
    assert_eq!(c["create"], Value::Bool(false), "the app builds it on demand, once");
    let windows = conf()["app"]["windows"].as_array().unwrap().len();
    assert_eq!(windows, 1);
}

#[test]
fn tray_c55_choosing_settings_twice_leaves_one_window_and_focuses_it() {
    let w = FakeWindows::default();
    assert_eq!(settings::open(&w, View::Status).unwrap(), Opened::Created);
    assert_eq!(settings::open(&w, View::Status).unwrap(), Opened::Focused);
    assert_eq!(*w.created.borrow(), [View::Status], "never a second window; opens on Status");
    assert_eq!(*w.focused.borrow(), [View::Status]);
    assert_eq!(*w.open.borrow(), [View::Status]);
    assert_eq!(View::Status.name(), "status");
}

#[test]
fn tray_c55_review_server_key_and_set_up_ask_for_their_views() {
    let w = FakeWindows::default();
    settings::open(&w, View::Server).unwrap();
    settings::open(&w, View::SetUp).unwrap();
    assert_eq!(*w.created.borrow(), [View::Server]);
    assert_eq!(*w.focused.borrow(), [View::SetUp]);
    assert_eq!((View::Server.name(), View::SetUp.name()), ("server", "setup"));
}

#[test]
fn tray_c56_closing_settings_keeps_the_app_running_with_its_tray_icon() {
    // Closing the last window raises an exit request with no code: refused. Quit's `app.exit(0)` passes.
    assert!(!settings::exit_allowed(None));
    assert!(settings::exit_allowed(Some(0)));
    // The app passes every run event to that hook.
    let lib = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs")).unwrap();
    assert!(lib.contains(".run(|_, event| settings::keep_running(&event))"));
}

#[test]
fn tray_c62_opening_settings_runs_doctor_once_when_the_last_start_is_old() {
    let now = 1_790_000_000_000;
    for (last, runs) in [(Some(now - 31_000), 1), (Some(now - 29_000), 0), (None, 1), (Some(now - 30_000), 1)] {
        let count = AtomicUsize::new(0);
        settings::show(&FakeWindows::default(), View::Status, last, now, || {
            count.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        assert_eq!(count.load(Ordering::SeqCst), runs, "last start {last:?}");
    }
}

#[test]
fn tray_c62_focusing_an_open_window_checks_again_only_when_due() {
    let w = FakeWindows::default();
    let now = 1_790_000_000_000;
    let count = AtomicUsize::new(0);
    let run = || {
        count.fetch_add(1, Ordering::SeqCst);
    };
    settings::show(&w, View::Status, Some(now - 31_000), now, run).unwrap();
    settings::show(&w, View::Status, Some(now), now + 1_000, run).unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[test]
fn tray_c71_settings_window_is_transparent_with_os_window_effects() {
    let c = settings_config();
    assert_eq!(c["transparent"], Value::Bool(true));
    assert_eq!(c["windowEffects"]["effects"], serde_json::json!(["sidebar"]));
    assert_eq!(conf()["app"]["macOSPrivateApi"], Value::Bool(true));
}
