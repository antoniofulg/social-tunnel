#![allow(dead_code)]

use serde_json::{json, Value};
use social_tunnel_app_lib::model::{self, Doctor, Entry, Hop, Inputs, TrayModel, Tracker};
use social_tunnel_app_lib::sidecar::CallOutput;
use social_tunnel_app_lib::status::{read_status, StatusRead};

pub const T0: i64 = 1_790_000_000_000;

/// A `status --json` body for `state` with the shipped field set.
pub fn body(state: &str, reason: Value) -> Value {
    json!({
        "ok": state == "connected",
        "command": "status",
        "configPath": "/Users/me/Library/Application Support/social-tunnel/config.json",
        "state": state,
        "reason": reason,
        "since": "2026-11-21T10:00:00.000Z",
        "retryAt": null,
        "pid": null,
        "server": { "host": "vps.example.com", "port": 22, "user": "tunnel", "hostKey": format!("SHA256:{}", "A".repeat(43)) },
        "remotePort": 8888,
        "domains": 3,
        "keyPath": "/Users/me/.ssh/tunnel_key",
        "allowlist": ["instagram.com", "facebook.com", "threads.net"]
    })
}

pub fn out(exit: i32, v: &Value) -> CallOutput {
    CallOutput { exit: Some(exit), stdout: serde_json::to_vec(v).unwrap(), timed_out: false, overflow: false }
}

pub fn read(exit: i32, v: &Value) -> StatusRead {
    read_status(&out(exit, v), |_| false)
}

pub fn connected() -> StatusRead {
    read(0, &body("connected", Value::Null))
}

pub fn exit10(state: &str, reason: Value) -> StatusRead {
    read(10, &body(state, reason))
}

pub fn config_invalid(exists: bool) -> StatusRead {
    let v = json!({ "ok": false, "command": "status", "configPath": "/tmp/x/config.json",
                    "error": { "code": "config_invalid", "message": "m", "field": "$" } });
    read_status(&out(2, &v), |_| exists)
}

pub fn hop(name: &str, ok: bool, fix: &str) -> Hop {
    Hop { hop: name.into(), ok, skipped: false, detail: "d".into(), fix: fix.into() }
}

/// A doctor result whose first failing hop is `failing` (or all OK when None).
pub fn doctor(exit: i32, failing: Option<&str>, started_at: i64) -> Doctor {
    let order = ["config", "key", "server_reachable", "ssh_auth", "forward", "lockdown", "egress"];
    let mut hops = Vec::new();
    let mut failed = false;
    for name in order {
        if failed {
            hops.push(Hop { hop: name.into(), ok: false, skipped: true, detail: "skipped".into(), fix: String::new() });
        } else if Some(name) == failing {
            hops.push(hop(name, false, "the full fix"));
            failed = true;
        } else {
            hops.push(hop(name, true, ""));
        }
    }
    Doctor { exit, hops, started_at }
}

pub struct World {
    pub tracker: Tracker,
    pub now: i64,
}

impl World {
    pub fn new() -> Self {
        World { tracker: Tracker::default(), now: T0 }
    }

    /// Observes `status` at `at` ms after T0 and returns the model.
    pub fn poll(&mut self, at: i64, status: &StatusRead, doctor: Option<&Doctor>) -> TrayModel {
        self.now = T0 + at;
        self.tracker.observe(status, self.now);
        self.view(status, doctor)
    }

    pub fn view(&self, status: &StatusRead, doctor: Option<&Doctor>) -> TrayModel {
        model::view(
            &self.tracker,
            &Inputs { status, doctor, child_pid: None, spawned_at: None, now: self.now, checking: false, open_at_login: false },
        )
    }
}

pub fn texts(m: &TrayModel) -> Vec<String> {
    m.menu
        .iter()
        .map(|e| match e {
            Entry::Info { text } | Entry::Action { text, .. } | Entry::Check { text, .. } => text.clone(),
            Entry::Separator => "—".into(),
        })
        .collect()
}

pub fn has(m: &TrayModel, text: &str) -> bool {
    texts(m).iter().any(|t| t == text)
}
