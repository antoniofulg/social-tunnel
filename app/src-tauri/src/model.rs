//! Pure mapping from status, doctor result, ownership, downtime and the clock to the tray image and
//! menu (plan criteria 13-30, 87). Times are ms since the epoch.

use crate::status::{RunStatus, StatusRead};
use serde::Serialize;

pub const RECONNECT_LIMIT_MS: i64 = 60_000;
pub const SPAWN_GRACE_MS: i64 = 5_000;
pub const DOCTOR_FRESH_MS: i64 = 10 * 60_000;
pub const ROW_MAX: usize = 60;
pub const DOMAIN_ROWS: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TrayImage {
    NotSetUp,
    Connected,
    Reconnecting,
    Disconnected,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Entry {
    /// A disabled text row.
    Info { text: String },
    Action { id: String, text: String, enabled: bool, accelerator: Option<String> },
    Check { id: String, text: String, checked: bool },
    Separator,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TrayModel {
    pub image: TrayImage,
    pub title: String,
    pub menu: Vec<Entry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hop {
    pub hop: String,
    pub ok: bool,
    pub skipped: bool,
    pub detail: String,
    pub fix: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Doctor {
    pub exit: i32,
    pub hops: Vec<Hop>,
    pub started_at: i64,
}

impl Doctor {
    pub fn first_failing(&self) -> Option<&Hop> {
        self.hops.iter().find(|h| !h.ok && !h.skipped)
    }
}

/// What the app remembers between polls.
#[derive(Debug, Clone, Default)]
pub struct Tracker {
    last_connected: Option<i64>,
    down_from: Option<i64>,
    key: Option<(i32, String, Option<String>)>,
    key_changed_at: i64,
    /// The latest readable `status` with run fields (for counts, host, port, first domain).
    last_run: Option<RunStatus>,
}

impl Tracker {
    pub fn observe(&mut self, status: &StatusRead, now: i64) {
        let key = match status {
            StatusRead::Unreadable => (-1, String::new(), None),
            StatusRead::ConfigInvalid { .. } => (2, String::new(), None),
            StatusRead::Run(r) => (r.exit, r.state.clone(), r.reason.clone()),
        };
        if self.key.as_ref() != Some(&key) {
            self.key = Some(key);
            self.key_changed_at = now;
        }
        match status {
            StatusRead::Run(r) if r.exit == 0 => {
                self.last_connected = Some(now);
                self.down_from = None;
            }
            _ => {
                if self.down_from.is_none() {
                    self.down_from = Some(self.last_connected.unwrap_or(now));
                }
            }
        }
        if let StatusRead::Run(r) = status {
            self.last_run = Some(r.clone());
        }
    }

    /// Criterion 87: started after the latest change of state, reason or exit, and under 10 minutes old.
    pub fn is_current(&self, doctor: &Doctor, now: i64) -> bool {
        doctor.started_at >= self.key_changed_at && now - doctor.started_at < DOCTOR_FRESH_MS
    }

    pub fn downtime(&self, now: i64) -> i64 {
        self.down_from.map_or(0, |from| now - from)
    }
}

pub struct Inputs<'a> {
    pub status: &'a StatusRead,
    pub doctor: Option<&'a Doctor>,
    /// pid of the app's own `run` child, if any.
    pub child_pid: Option<u32>,
    /// When the app last spawned a `run` child.
    pub spawned_at: Option<i64>,
    pub now: i64,
    pub checking: bool,
    pub open_at_login: bool,
}

/// Cuts a row to 59 characters plus `…` when it is longer than 60.
pub fn cut(text: &str) -> String {
    if text.chars().count() > ROW_MAX {
        text.chars().take(ROW_MAX - 1).chain(std::iter::once('…')).collect()
    } else {
        text.to_string()
    }
}

fn info(text: impl AsRef<str>) -> Entry {
    Entry::Info { text: cut(text.as_ref()) }
}

fn action(id: &str, text: &str, enabled: bool, accelerator: Option<&str>) -> Entry {
    Entry::Action { id: id.into(), text: text.into(), enabled, accelerator: accelerator.map(String::from) }
}

/// The two short rows for a failing hop (uiux.md, hop-and-exit map).
pub fn hop_rows(hop: &str, exit: i32, last: Option<&RunStatus>) -> Option<[String; 2]> {
    let host = last.map_or("the server".into(), |r| format!("{}:{}", r.server.host, r.server.port));
    let port = last.map_or("?".into(), |r| r.remote_port.to_string());
    let domain = last.and_then(|r| r.allowlist.first().cloned()).unwrap_or_else(|| "the first domain".into());
    let rows: (String, String) = match (hop, exit) {
        ("config", 2) => ("This Mac: the config file needs a fix".into(), "Fix: open Settings for the field to change".into()),
        ("key", 2) => ("This Mac: the tunnel key can't be used".into(), "Fix: open Settings for the key fix".into()),
        ("server_reachable", 10) => (format!("Server: no connection to {host}"), "Fix: check the server is up and allows SSH".into()),
        ("ssh_auth", 10) => ("Server: SSH sign-in failed".into(), "Fix: open Settings for the full fix".into()),
        ("ssh_auth", 13) => ("Server: host key does not match the saved one".into(), "Fix: do not connect until you know why".into()),
        ("forward", 11) => (
            format!("Tunnel port: the server refused port {port}"),
            format!("Fix: free port {port}, allow it for the key"),
        ),
        ("forward", 10) => ("Tunnel port: the server did not answer".into(), "Fix: run the check again".into()),
        ("lockdown", 14) => (
            "Lock-down: the tunnel user can do more than forward".into(),
            "Fix: restrict the tunnel user on the server".into(),
        ),
        ("lockdown", 10) => ("Lock-down: the server did not answer".into(), "Fix: run the check again".into()),
        ("egress", 10) => (format!("This Mac: no internet connection to {domain}"), "Fix: check this Mac's internet and DNS".into()),
        ("domain", 12) => ("Domains: the host is not on the list".into(), "Fix: add it only if it should use home".into()),
        _ => return None,
    };
    Some([rows.0, rows.1])
}

#[derive(PartialEq)]
enum Layout {
    Connected,
    Reconnecting,
    Disconnected,
    BlockedPort,
    BlockedKey,
    Lockdown,
}

pub fn not_set_up_menu() -> Vec<Entry> {
    vec![
        info("Not set up"),
        info("Nothing is routed yet."),
        Entry::Separator,
        action("set_up", "Set Up…", true, None),
        Entry::Separator,
        action("quit", "Quit Social Tunnel", true, Some("CmdOrCtrl+Q")),
    ]
}

pub fn view(tracker: &Tracker, i: &Inputs) -> TrayModel {
    if let StatusRead::ConfigInvalid { exists: false, .. } = i.status {
        return TrayModel { image: TrayImage::NotSetUp, title: "Not set up".into(), menu: not_set_up_menu() };
    }
    let current = i.doctor.filter(|d| tracker.is_current(d, i.now));
    let run = match i.status {
        StatusRead::Run(r) => Some(r),
        _ => None,
    };
    let lockdown = current.is_some_and(|d| d.exit == 14);
    let layout = match run {
        None => Layout::Disconnected,
        Some(r) if r.exit == 13 => Layout::BlockedKey,
        Some(_) if lockdown => Layout::Lockdown,
        Some(r) if r.exit == 11 => Layout::BlockedPort,
        Some(r) if r.exit == 0 => Layout::Connected,
        Some(r) => {
            let retrying = matches!(r.state.as_str(), "connecting" | "reconnecting")
                || (r.state == "disconnected" && r.reason.as_deref() == Some("connection_lost"));
            let in_grace = r.state == "stopped" && i.spawned_at.is_some_and(|t| i.now - t < SPAWN_GRACE_MS);
            if (retrying && tracker.downtime(i.now) < RECONNECT_LIMIT_MS) || in_grace {
                Layout::Reconnecting
            } else {
                Layout::Disconnected
            }
        }
    };
    let last = tracker.last_run.as_ref();
    let external = run.and_then(|r| r.pid).filter(|&pid| Some(pid) != i.child_pid);

    let mut menu = Vec::new();
    let (image, title) = match layout {
        Layout::Connected => (TrayImage::Connected, "Connected"),
        Layout::Reconnecting => (TrayImage::Reconnecting, "Reconnecting…"),
        Layout::Disconnected => (TrayImage::Disconnected, "Disconnected"),
        Layout::BlockedPort => (TrayImage::Blocked, "Blocked at the server"),
        Layout::BlockedKey => (TrayImage::Blocked, "Server key changed"),
        Layout::Lockdown => (TrayImage::Blocked, "Server allows too much"),
    };
    menu.push(info(title));
    match layout {
        Layout::Reconnecting => {
            let wait = run.and_then(|r| r.retry_at_ms).map(|t| t - i.now).filter(|&ms| ms > 0);
            menu.push(info(match wait {
                Some(ms) => format!("Next try in {} s.", (ms + 999) / 1000),
                None => "Trying now.".into(),
            }));
        }
        Layout::Disconnected => {
            if let Some((d, hop)) = current.and_then(|d| d.first_failing().map(|h| (d, h))) {
                if let Some(rows) = hop_rows(&hop.hop, d.exit, last) {
                    menu.extend(rows.iter().map(info));
                }
            }
            match (i.status, run.and_then(|r| r.reason.as_deref())) {
                (StatusRead::Unreadable, _) => menu.push(info("Can't read the tunnel status.")),
                (_, Some("stale")) if run.is_some_and(|r| r.state == "stopped") => {
                    menu.push(info("The tunnel stopped reporting."))
                }
                (_, Some("config_changed")) if run.is_some_and(|r| r.state == "stopped") => {
                    menu.push(info("The running tunnel uses an older config."))
                }
                _ => {}
            }
        }
        Layout::BlockedPort => menu.extend(hop_rows("forward", 11, run).unwrap().iter().map(info)),
        Layout::BlockedKey => menu.extend(hop_rows("ssh_auth", 13, run).unwrap().iter().map(info)),
        Layout::Lockdown => menu.extend(hop_rows("lockdown", 14, run).unwrap().iter().map(info)),
        Layout::Connected => {}
    }
    if let Some(pid) = external {
        menu.push(info(format!("Managed outside the app (pid {pid}).")));
    }
    if layout == Layout::Connected {
        menu.push(Entry::Separator);
        let status = run.expect("connected has a run");
        let selected = match &status.managed_domains {
            Some(domains) => domains.active.as_ref().map(|active| active.domains.as_slice()),
            None => Some(status.allowlist.as_slice()),
        };
        match selected {
            None => menu.push(info("Managed domain routing isn't verified.")),
            Some([]) if status.managed_domains.is_some() => menu.push(info("No domains use the tunnel.")),
            Some(list) => {
                menu.push(info("Through home"));
                menu.extend(list.iter().take(DOMAIN_ROWS).map(info));
                if list.len() > DOMAIN_ROWS {
                    menu.push(info(format!("{} more in Settings", list.len() - DOMAIN_ROWS)));
                }
            }
        }
    } else if run.or(last).is_some_and(|r| r.managed_domains.is_some()) {
        menu.push(info("Managed domain routing isn't verified."));
    } else if let Some(n) = last.map(|r| r.domains) {
        menu.push(info(if n == 1 {
            "1 domain paused. Nothing goes direct.".to_string()
        } else {
            format!("{n} domains paused. Nothing goes direct.")
        }));
    }
    menu.push(Entry::Separator);
    let has_fix = i.doctor.and_then(Doctor::first_failing).is_some_and(|h| !h.fix.is_empty());
    match layout {
        Layout::BlockedPort | Layout::Lockdown => menu.push(action("copy_fix", "Copy Fix", has_fix, None)),
        Layout::BlockedKey => menu.push(action("review_key", "Review Server Key…", true, None)),
        _ => {}
    }
    menu.push(if i.checking {
        action("run_check", "Checking…", false, None)
    } else {
        action("run_check", "Run Check", true, None)
    });
    if external.is_none() {
        menu.push(action("reconnect", "Reconnect", true, None));
    }
    menu.push(action("settings", "Settings…", true, Some("CmdOrCtrl+,")));
    menu.push(Entry::Check { id: "open_at_login".into(), text: "Open at Login".into(), checked: i.open_at_login });
    menu.push(Entry::Separator);
    menu.push(action("quit", "Quit Social Tunnel", true, Some("CmdOrCtrl+Q")));
    TrayModel { image, title: title.into(), menu }
}
