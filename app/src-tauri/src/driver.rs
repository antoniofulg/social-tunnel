//! Applies tray models to the menu bar: frame loop, change detection, the poll gate (plan
//! criteria 12, 32-35). The sink is the real tray in production and a recorder in tests.

use crate::model::{Doctor, Entry, TrayImage, TrayModel};
use crate::status::{RunStatus, StatusRead};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};

pub const POLL_MS: u64 = 2_000;
pub const FRAME_MS: u64 = 150;
pub const FRAMES: u8 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Icon {
    State(TrayImage),
    /// Reconnecting frame 0-7.
    Frame(u8),
}

/// What the Settings window and `get_snapshot` see.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub tray_state: TrayImage,
    pub title: String,
    pub rows: Vec<String>,
    pub status_unreadable: bool,
    pub status: Option<RunStatus>,
    pub config_path: Option<String>,
    pub doctor: Option<Doctor>,
    pub ownership: Option<String>,
    pub open_at_login: bool,
    pub reduce_transparency: bool,
    /// A doctor run is in flight (Run Check, Check Again).
    pub checking: bool,
}

impl Snapshot {
    pub fn new(model: &TrayModel, status: &StatusRead, doctor: Option<&Doctor>, child_pid: Option<u32>) -> Self {
        let run = match status {
            StatusRead::Run(r) => Some(r.clone()),
            _ => None,
        };
        let config_path = match status {
            StatusRead::ConfigInvalid { config_path, .. } => Some(config_path.clone()),
            _ => run.as_ref().and_then(|r| r.config_path.clone()),
        };
        let ownership = run.as_ref().and_then(|r| r.pid).map(|pid| {
            if Some(pid) == child_pid { "owned".to_string() } else { "external".to_string() }
        });
        let open_at_login = model.menu.iter().any(|e| matches!(e, Entry::Check { checked: true, .. }));
        Snapshot {
            tray_state: model.image,
            title: model.title.clone(),
            rows: model
                .menu
                .iter()
                .filter_map(|e| match e {
                    Entry::Info { text } => Some(text.clone()),
                    _ => None,
                })
                .collect(),
            status_unreadable: matches!(status, StatusRead::Unreadable),
            status: run,
            config_path,
            doctor: doctor.cloned(),
            ownership,
            open_at_login,
            reduce_transparency: false,
            checking: false,
        }
    }
}

pub trait TraySink {
    fn set_icon(&mut self, icon: Icon);
    fn set_menu(&mut self, menu: &[Entry]);
    fn emit_snapshot(&mut self, snapshot: &Snapshot);
    fn start_timer(&mut self);
    fn stop_timer(&mut self);
}

#[derive(Debug, Default)]
pub struct Driver {
    icon: Option<Icon>,
    timer: bool,
    frame: u8,
    menu: Option<Vec<Entry>>,
    snapshot: Option<Snapshot>,
}

impl Driver {
    pub fn timer_running(&self) -> bool {
        self.timer
    }

    fn show(&mut self, icon: Icon, sink: &mut dyn TraySink) {
        if self.icon != Some(icon) {
            self.icon = Some(icon);
            sink.set_icon(icon);
        }
    }

    fn stop(&mut self, sink: &mut dyn TraySink) {
        if self.timer {
            self.timer = false;
            sink.stop_timer();
        }
    }

    /// Sets the image (or starts the frame loop), rebuilds the menu and emits the snapshot only
    /// when they changed.
    pub fn apply(&mut self, model: &TrayModel, snapshot: Snapshot, reduce_motion: bool, sink: &mut dyn TraySink) {
        if model.image == TrayImage::Reconnecting {
            if reduce_motion {
                self.stop(sink);
                self.frame = 0;
                self.show(Icon::Frame(0), sink);
            } else if !self.timer {
                self.frame = 0;
                self.show(Icon::Frame(0), sink);
                self.timer = true;
                sink.start_timer();
            }
        } else {
            self.stop(sink);
            self.show(Icon::State(model.image), sink);
        }
        if self.menu.as_deref() != Some(&model.menu[..]) {
            sink.set_menu(&model.menu);
            self.menu = Some(model.menu.clone());
        }
        if self.snapshot.as_ref() != Some(&snapshot) {
            sink.emit_snapshot(&snapshot);
            self.snapshot = Some(snapshot);
        }
    }

    /// One frame-timer tick (every FRAME_MS while the timer runs).
    pub fn tick(&mut self, sink: &mut dyn TraySink) {
        if self.timer {
            self.frame = (self.frame + 1) % FRAMES;
            self.icon = Some(Icon::Frame(self.frame));
            sink.set_icon(Icon::Frame(self.frame));
        }
    }

    pub fn snapshot(&self) -> Option<&Snapshot> {
        self.snapshot.as_ref()
    }
}

/// At most one status call in flight; a tick that finds one running is skipped.
#[derive(Debug, Default)]
pub struct PollGate(AtomicBool);

impl PollGate {
    pub fn try_start(&self) -> bool {
        self.0.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_ok()
    }

    pub fn finish(&self) {
        self.0.store(false, Ordering::Release);
    }
}
