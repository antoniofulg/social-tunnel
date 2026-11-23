//! social-tunnel menu bar app. The CLI is the only tunnel, status and check implementation; this
//! crate runs it as a sidecar and draws its state (AGENTS.md).

pub mod doctor;
pub mod domains;
pub mod driver;
pub mod login;
pub mod model;
pub mod nav;
pub mod settings;
pub mod sidecar;
pub mod status;
pub mod supervisor;

use driver::{Driver, Icon, PollGate, Snapshot, TraySink, FRAME_MS, POLL_MS};
use doctor::{Clipboard, Doctors};
use domains::{DomainCall, DomainError, DomainView, ErrorCode};
use model::{Doctor, Entry, Inputs, TrayImage, Tracker};
use sidecar::{CancellableRunner, SidecarCall};
use status::{read_status, StatusRead, MAX_STDOUT, STATUS_TIMEOUT_MS};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use supervisor::{ProcessSpawner, Supervisor};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

const TRAY_ID: &str = "main";
const TICK_MS: u64 = 100;

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

#[cfg(target_os = "macos")]
fn reduce_transparency() -> bool {
    objc2_app_kit::NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceTransparency()
}

#[cfg(not(target_os = "macos"))]
fn reduce_transparency() -> bool {
    false
}

struct Core {
    tracker: Tracker,
    status: StatusRead,
    driver: Driver,
    sup: Supervisor,
    spawner: ProcessSpawner,
    /// The last model showed the lock-down alarm (criterion 88).
    lockdown: bool,
    open_at_login: bool,
}

struct AppState {
    core: Mutex<Core>,
    gate: PollGate,
    domain_gate: PollGate,
    doctors: Doctors,
    /// Set by Quit: kills running status and doctor calls (criterion 46).
    quitting: Arc<AtomicBool>,
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
    if state.quitting.load(Ordering::SeqCst) {
        return;
    }
    let out = sidecar::call(
        &CancellableRunner(state.quitting.clone()),
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
    if state.quitting.load(Ordering::SeqCst) {
        return;
    }
    core.tracker.observe(&read, now);
    // The spawn decision comes before the tray is judged (criterion 50).
    let Core { sup, spawner, .. } = &mut *core;
    sup.on_status(&read, now, spawner);
    core.status = read;
    let image = redraw(app, &mut core, now);
    let latest = state.doctors.latest();
    let current = latest.as_ref().is_some_and(|d| core.tracker.is_current(d, now));
    let alarm = matches!(image, TrayImage::Disconnected | TrayImage::Blocked);
    let due = doctor::auto_due(alarm, current, latest.as_ref(), state.doctors.last_started(), core.lockdown, now);
    core.lockdown = image == TrayImage::Blocked && latest.as_ref().is_some_and(|d| d.exit == 14) && current;
    drop(core);
    if due {
        std::thread::spawn({
            let app = app.clone();
            move || check(&app)
        });
    }
}

fn redraw(app: &AppHandle, core: &mut Core, now: i64) -> TrayImage {
    let state = app.state::<AppState>();
    let doctor = state.doctors.latest();
    let inputs = Inputs {
        status: &core.status,
        doctor: doctor.as_ref(),
        child_pid: core.sup.child_pid(),
        spawned_at: core.sup.spawned_at(),
        now,
        checking: state.doctors.running(),
        open_at_login: core.open_at_login,
    };
    let model = model::view(&core.tracker, &inputs);
    let mut snapshot = Snapshot::new(&model, &core.status, doctor.as_ref(), core.sup.child_pid());
    snapshot.reduce_transparency = reduce_transparency();
    snapshot.checking = inputs.checking;
    core.driver.apply(&model, snapshot, reduce_motion(), &mut TauriSink { app });
    model.image
}

fn redraw_now(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut core = state.core.lock().unwrap();
    redraw(app, &mut core, now_ms());
}

/// Runs doctor once, or joins the run in flight (criterion 49), redrawing for `Checking…`.
fn check(app: &AppHandle) -> Option<Doctor> {
    let state = app.state::<AppState>();
    if state.quitting.load(Ordering::SeqCst) {
        return None;
    }
    let runner = CancellableRunner(state.quitting.clone());
    let now = now_ms();
    if !state.doctors.try_begin(now) {
        return state.doctors.run(&runner, &state.sidecar, now);
    }
    redraw_now(app);
    let result = state.doctors.finish(&runner, &state.sidecar, now);
    redraw_now(app);
    result
}

struct TauriClipboard<'a>(&'a AppHandle);

impl Clipboard for TauriClipboard<'_> {
    fn write(&mut self, text: &str) -> bool {
        self.0.clipboard().write_text(text).is_ok()
    }
}

fn copy_fix_for(app: &AppHandle, hop: &str) -> Result<(), String> {
    let latest = app.state::<AppState>().doctors.latest();
    doctor::copy_fix(&mut TauriClipboard(app), latest.as_ref(), hop)
}

/// Settings…, Set Up… and Review Server Key… (criteria 55, 62, 68, 70).
fn show_settings(app: &AppHandle, view: settings::View) {
    let last = app.state::<AppState>().doctors.last_started();
    let _ = settings::show(&settings::TauriWindows(app), view, last, now_ms(), || {
        let app = app.clone();
        std::thread::spawn(move || check(&app));
    });
}

fn reconnect(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut core = state.core.lock().unwrap();
    let Core { sup, spawner, .. } = &mut *core;
    sup.reconnect(now_ms(), spawner);
    redraw(app, &mut core, now_ms());
}

fn quit(app: &AppHandle) {
    let state = app.state::<AppState>();
    supervisor::begin_quit(&state.quitting, &mut state.core.lock().unwrap().sup, now_ms());
}

/// Reaps the child, fires restarts and the stop deadline, and exits once Quit has finished.
fn supervise(app: &AppHandle) {
    loop {
        std::thread::sleep(Duration::from_millis(TICK_MS));
        let state = app.state::<AppState>();
        let mut core = state.core.lock().unwrap();
        let Core { sup, spawner, .. } = &mut *core;
        let tick = sup.tick(now_ms(), spawner);
        drop(core);
        if tick.exit {
            app.exit(0);
            return;
        }
        if tick.doctor {
            let app = app.clone();
            std::thread::spawn(move || check(&app));
        }
    }
}

#[tauri::command]
fn get_snapshot(state: tauri::State<'_, AppState>) -> Option<Snapshot> {
    state.core.lock().unwrap().driver.snapshot().cloned()
}

#[tauri::command]
async fn run_check(app: AppHandle) -> Result<Doctor, String> {
    tauri::async_runtime::spawn_blocking(move || check(&app))
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "timeout".into())
}

#[tauri::command]
fn copy_fix(app: AppHandle, hop: String) -> Result<(), String> {
    copy_fix_for(&app, &hop)
}

/// Switches the login item, keeps the read-back state and redraws the checkmark (criterion 78).
fn switch_login(app: &AppHandle, enabled: Option<bool>) -> Result<bool, String> {
    let state = app.state::<AppState>();
    let mut core = state.core.lock().unwrap();
    let item = login::Autostart(app);
    let result = login::set(&item, enabled.unwrap_or(!core.open_at_login));
    let read_back = result.as_ref().copied().unwrap_or_else(|_| login::read(&item));
    if enabled.is_none() && read_back == core.open_at_login {
        core.driver.invalidate_menu();
    }
    core.open_at_login = read_back;
    redraw(app, &mut core, now_ms());
    result
}

#[tauri::command]
async fn set_open_at_login(app: AppHandle, enabled: bool) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || switch_login(&app, Some(enabled)))
        .await
        .map_err(|_| "autostart_failed".to_string())?
}

fn domain_sender(window: &tauri::WebviewWindow) -> Result<(), DomainError> {
    if window.url().is_ok_and(|url| domains::settings_sender(window.label(), &url)) {
        Ok(())
    } else {
        Err(ErrorCode::Unavailable.error())
    }
}

async fn call_domains(app: AppHandle, command: DomainCall) -> Result<DomainView, DomainError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if !state.domain_gate.try_start() {
            return Err(ErrorCode::Conflict.error());
        }
        let result = domains::run(&CancellableRunner(state.quitting.clone()), &state.sidecar, command);
        state.domain_gate.finish();
        result
    }).await.map_err(|_| ErrorCode::Internal.error())?
}

fn domain_payload<'a>(window: &tauri::WebviewWindow, request: &'a tauri::ipc::Request<'_>) -> Result<&'a serde_json::Value, DomainError> {
    domain_sender(window)?;
    match request.body() {
        tauri::ipc::InvokeBody::Json(value) => Ok(value),
        _ => Err(ErrorCode::Unavailable.error()),
    }
}

#[tauri::command]
async fn get_domains(window: tauri::WebviewWindow, request: tauri::ipc::Request<'_>) -> Result<DomainView, DomainError> {
    let payload = domain_payload(&window, &request)?;
    if !payload.as_object().is_some_and(|o| o.is_empty()) { return Err(ErrorCode::Unavailable.error()); }
    call_domains(window.app_handle().clone(), DomainCall::List).await
}

#[tauri::command]
async fn edit_domain(window: tauri::WebviewWindow, request: tauri::ipc::Request<'_>) -> Result<DomainView, DomainError> {
    let edit = domains::edit_request(domain_payload(&window, &request)?)?;
    call_domains(window.app_handle().clone(), DomainCall::Edit(edit)).await
}

#[tauri::command]
async fn retry_domain_edit(window: tauri::WebviewWindow, request: tauri::ipc::Request<'_>) -> Result<DomainView, DomainError> {
    let retry = domains::retry_request(domain_payload(&window, &request)?)?;
    call_domains(window.app_handle().clone(), DomainCall::Retry(retry)).await
}

pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_clipboard_manager::init());
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(login::plugin());
    builder
        .invoke_handler(tauri::generate_handler![
            get_snapshot, run_check, copy_fix, set_open_at_login, get_domains, edit_domain, retry_domain_edit,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let exe = std::env::current_exe()?;
            #[cfg(target_os = "macos")]
            app.manage(login::MacLogin::new(app.path().home_dir().ok().as_deref(), &exe));
            let program = sidecar::sidecar_path(&exe);
            app.manage(AppState {
                core: Mutex::new(Core {
                    tracker: Tracker::default(),
                    status: StatusRead::Unreadable,
                    driver: Driver::default(),
                    sup: Supervisor::default(),
                    spawner: ProcessSpawner { program: program.clone() },
                    lockdown: false,
                    open_at_login: login::read(&login::Autostart(app.handle())),
                }),
                gate: PollGate::default(),
                domain_gate: PollGate::default(),
                doctors: Doctors::default(),
                quitting: Arc::new(AtomicBool::new(false)),
                sidecar: program,
                timer_generation: Arc::new(AtomicU64::new(0)),
            });
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(image(Icon::State(TrayImage::Disconnected)))
                .icon_as_template(true)
                .show_menu_on_left_click(true)
                .menu(&build_menu(app.handle(), &[])?)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "quit" => quit(app),
                    "reconnect" => reconnect(app),
                    "run_check" => {
                        let app = app.clone();
                        std::thread::spawn(move || check(&app));
                    }
                    "copy_fix" => {
                        let latest = app.state::<AppState>().doctors.latest();
                        if let Some(hop) = latest.as_ref().and_then(Doctor::first_failing) {
                            let _ = copy_fix_for(app, &hop.hop.clone());
                        }
                    }
                    "open_at_login" => {
                        // Poll redraws can hold core while waiting for AppKit on this thread.
                        let app = app.clone();
                        std::thread::spawn(move || switch_login(&app, None));
                    }
                    "settings" => show_settings(app, settings::View::Status),
                    "set_up" => show_settings(app, settings::View::SetUp),
                    "review_key" => show_settings(app, settings::View::Server),
                    _ => {}
                })
                .build(app)?;
            let handle = app.handle().clone();
            std::thread::spawn(move || supervise(&handle));
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
        .build(tauri::generate_context!())
        .expect("error while building social-tunnel")
        .run(|_, event| settings::keep_running(&event));
}
