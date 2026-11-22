//! social-tunnel menu bar app. The CLI is the only tunnel, status and check implementation; this
//! crate runs it as a sidecar and draws its state (AGENTS.md).

pub mod driver;
pub mod model;
pub mod nav;
pub mod sidecar;
pub mod status;

use driver::{Driver, Icon, PollGate, Snapshot, TraySink, FRAME_MS, POLL_MS};
use model::{Doctor, Entry, Inputs, TrayImage, Tracker};
use sidecar::{ProcessRunner, SidecarCall};
use status::{read_status, StatusRead, MAX_STDOUT, STATUS_TIMEOUT_MS};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

const TRAY_ID: &str = "main";

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

fn image(icon: Icon) -> Image<'static> {
    match icon {
        Icon::State(TrayImage::NotSetUp) => tauri::include_image!("icons/tray/not-set-up@2x.png"),
        Icon::State(TrayImage::Connected) => tauri::include_image!("icons/tray/connected@2x.png"),
        Icon::State(TrayImage::Disconnected) => tauri::include_image!("icons/tray/disconnected@2x.png"),
        Icon::State(TrayImage::Blocked) => tauri::include_image!("icons/tray/blocked@2x.png"),
        Icon::State(TrayImage::Reconnecting) | Icon::Frame(0) => tauri::include_image!("icons/tray/reconnecting-0@2x.png"),
        Icon::Frame(1) => tauri::include_image!("icons/tray/reconnecting-1@2x.png"),
        Icon::Frame(2) => tauri::include_image!("icons/tray/reconnecting-2@2x.png"),
        Icon::Frame(3) => tauri::include_image!("icons/tray/reconnecting-3@2x.png"),
        Icon::Frame(4) => tauri::include_image!("icons/tray/reconnecting-4@2x.png"),
        Icon::Frame(5) => tauri::include_image!("icons/tray/reconnecting-5@2x.png"),
        Icon::Frame(6) => tauri::include_image!("icons/tray/reconnecting-6@2x.png"),
        Icon::Frame(_) => tauri::include_image!("icons/tray/reconnecting-7@2x.png"),
    }
}

#[cfg(target_os = "macos")]
fn reduce_motion() -> bool {
    objc2_app_kit::NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceMotion()
}

#[cfg(not(target_os = "macos"))]
fn reduce_motion() -> bool {
    false
}

struct Core {
    tracker: Tracker,
    status: StatusRead,
    doctor: Option<Doctor>,
    driver: Driver,
}

struct AppState {
    core: Mutex<Core>,
    gate: PollGate,
    sidecar: PathBuf,
    /// Bumped to stop the running frame timer.
    timer_generation: Arc<AtomicU64>,
}

struct TauriSink<'a> {
    app: &'a AppHandle,
}

impl TraySink for TauriSink<'_> {
    fn set_icon(&mut self, icon: Icon) {
        if let Some(tray) = self.app.tray_by_id(TRAY_ID) {
            let _ = tray.set_icon(Some(image(icon)));
            let _ = tray.set_icon_as_template(true);
        }
    }

    fn set_menu(&mut self, entries: &[Entry]) {
        if let (Some(tray), Ok(menu)) = (self.app.tray_by_id(TRAY_ID), build_menu(self.app, entries)) {
            let _ = tray.set_menu(Some(menu));
        }
    }

    fn emit_snapshot(&mut self, snapshot: &Snapshot) {
        let _ = self.app.emit("snapshot", snapshot);
    }

    fn start_timer(&mut self) {
        let state = self.app.state::<AppState>();
        let generation = state.timer_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let app = self.app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(FRAME_MS));
            let state = app.state::<AppState>();
            if state.timer_generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let mut core = state.core.lock().unwrap();
            core.driver.tick(&mut TauriSink { app: &app });
        });
    }

    fn stop_timer(&mut self) {
        self.app.state::<AppState>().timer_generation.fetch_add(1, Ordering::SeqCst);
    }
}

fn build_menu(app: &AppHandle, entries: &[Entry]) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    for (n, entry) in entries.iter().enumerate() {
        match entry {
            Entry::Info { text } => menu.append(&MenuItem::with_id(app, format!("info-{n}"), text, false, None::<&str>)?)?,
            Entry::Action { id, text, enabled, accelerator } => {
                menu.append(&MenuItem::with_id(app, id, text, *enabled, accelerator.as_deref())?)?
            }
            Entry::Check { id, text, checked } => {
                menu.append(&CheckMenuItem::with_id(app, id, text, true, *checked, None::<&str>)?)?
            }
            Entry::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
        }
    }
    Ok(menu)
}

/// One status poll: run the sidecar, read the result, redraw.
fn poll(app: &AppHandle) {
    let state = app.state::<AppState>();
    let out = sidecar::call(
        &ProcessRunner,
        &state.sidecar,
        &SidecarCall::Status,
        None,
        Duration::from_millis(STATUS_TIMEOUT_MS),
        MAX_STDOUT,
    );
    let read = match out {
        Ok(out) => read_status(&out, |path| Path::new(path).try_exists().unwrap_or(false)),
        Err(_) => StatusRead::Unreadable,
    };
    let now = now_ms();
    let mut core = state.core.lock().unwrap();
    core.tracker.observe(&read, now);
    core.status = read;
    redraw(app, &mut core, now);
}

fn redraw(app: &AppHandle, core: &mut Core, now: i64) {
    let inputs = Inputs {
        status: &core.status,
        doctor: core.doctor.as_ref(),
        child_pid: None,
        spawned_at: None,
        now,
        checking: false,
        open_at_login: false,
    };
    let model = model::view(&core.tracker, &inputs);
    let snapshot = Snapshot::new(&model, &core.status, core.doctor.as_ref(), None);
    core.driver.apply(&model, snapshot, reduce_motion(), &mut TauriSink { app });
}

#[tauri::command]
fn get_snapshot(state: tauri::State<'_, AppState>) -> Option<Snapshot> {
    state.core.lock().unwrap().driver.snapshot().cloned()
}

// The next three land with the supervisor (S2) and the login item (S4).
#[tauri::command]
fn run_check() -> Result<(), String> {
    Err("unavailable".into())
}

#[tauri::command]
fn copy_fix(hop: String) -> Result<(), String> {
    let _ = hop;
    Err("no_fix".into())
}

#[tauri::command]
fn set_open_at_login(enabled: bool) -> Result<bool, String> {
    let _ = enabled;
    Err("autostart_failed".into())
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_snapshot, run_check, copy_fix, set_open_at_login])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let exe = std::env::current_exe()?;
            app.manage(AppState {
                core: Mutex::new(Core {
                    tracker: Tracker::default(),
                    status: StatusRead::Unreadable,
                    doctor: None,
                    driver: Driver::default(),
                }),
                gate: PollGate::default(),
                sidecar: sidecar::sidecar_path(&exe),
                timer_generation: Arc::new(AtomicU64::new(0)),
            });
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(image(Icon::State(TrayImage::Disconnected)))
                .icon_as_template(true)
                .show_menu_on_left_click(true)
                .menu(&build_menu(app.handle(), &[])?)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "quit" => app.exit(0),
                    "settings" => {
                        if let Some(window) = app.get_webview_window("settings") {
                            let _ = window.set_focus();
                        } else {
                            let _ = nav::settings_window(app).build();
                        }
                    }
                    _ => {}
                })
                .build(app)?;
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                let state = handle.state::<AppState>();
                if state.gate.try_start() {
                    let app = handle.clone();
                    std::thread::spawn(move || {
                        poll(&app);
                        app.state::<AppState>().gate.finish();
                    });
                }
                std::thread::sleep(Duration::from_millis(POLL_MS));
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running social-tunnel");
}
