//! `doctor --json`: single-flight runs, when the app runs one by itself, and Copy Fix (plan criteria
//! 26, 49-54, 85, 88).

use crate::model::{Doctor, Hop};
use crate::sidecar::{self, CallOutput, Runner, SidecarCall};
use crate::status::MAX_STDOUT;
use serde_json::Value;
use std::path::Path;
use std::sync::{Condvar, Mutex};
use std::time::Duration;

pub const DOCTOR_TIMEOUT_MS: u64 = 120_000;
pub const AUTO_GAP_MS: i64 = 30_000;
pub const LOCKDOWN_RECHECK_MS: i64 = 10 * 60_000;

/// Reads one doctor call; a call that hung, overflowed or printed no hop list gives None.
pub fn parse_doctor(out: &CallOutput, started_at: i64) -> Option<Doctor> {
    if out.timed_out || out.overflow {
        return None;
    }
    let exit = out.exit?;
    let v: Value = serde_json::from_slice(&out.stdout).ok()?;
    let hops = v
        .get("hops")?
        .as_array()?
        .iter()
        .map(|h| {
            Some(Hop {
                hop: h.get("hop")?.as_str()?.into(),
                ok: h.get("ok")?.as_bool()?,
                skipped: h.get("skipped")?.as_bool()?,
                detail: h.get("detail")?.as_str()?.into(),
                fix: h.get("fix")?.as_str()?.into(),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    Some(Doctor { exit, hops, started_at })
}

#[derive(Default)]
struct State {
    running: bool,
    generation: u64,
    last_started: Option<i64>,
    latest: Option<Doctor>,
    /// What the last finished run produced (None: it timed out or was unreadable).
    last_result: Option<Doctor>,
}

/// One doctor call at a time; a request while one runs joins it and gets the same result.
#[derive(Default)]
pub struct Doctors {
    state: Mutex<State>,
    done: Condvar,
}

impl Doctors {
    pub fn running(&self) -> bool {
        self.state.lock().unwrap().running
    }

    pub fn last_started(&self) -> Option<i64> {
        self.state.lock().unwrap().last_started
    }

    /// The latest readable result, kept across a call that timed out (criterion 51).
    pub fn latest(&self) -> Option<Doctor> {
        self.state.lock().unwrap().latest.clone()
    }

    /// Marks a run as started without blocking; false when one already runs. Pair with `finish`.
    pub fn try_begin(&self, now: i64) -> bool {
        let mut s = self.state.lock().unwrap();
        if s.running {
            return false;
        }
        s.running = true;
        s.last_started = Some(now);
        true
    }

    /// Runs the call for a `try_begin` that returned true.
    pub fn finish(&self, runner: &dyn Runner, program: &Path, now: i64) -> Option<Doctor> {
        // v0.2 never passes --domain (criterion 26).
        let out = sidecar::call(
            runner,
            program,
            &SidecarCall::Doctor { domain: None },
            None,
            Duration::from_millis(DOCTOR_TIMEOUT_MS),
            MAX_STDOUT,
        )
        .unwrap_or_default();
        let result = parse_doctor(&out, now);
        let mut s = self.state.lock().unwrap();
        if result.is_some() {
            s.latest = result.clone();
        }
        s.last_result = result.clone();
        s.running = false;
        s.generation += 1;
        self.done.notify_all();
        result
    }

    /// Run Check, `run_check` and Check Again: starts a run, or joins the one already running.
    pub fn run(&self, runner: &dyn Runner, program: &Path, now: i64) -> Option<Doctor> {
        if self.try_begin(now) {
            return self.finish(runner, program, now);
        }
        let mut s = self.state.lock().unwrap();
        let generation = s.generation;
        while s.running && s.generation == generation {
            s = self.done.wait(s).unwrap();
        }
        s.last_result.clone()
    }
}

/// Whether a poll should start doctor by itself: the tray shows Disconnected or Blocked with no
/// current result and no run in the last 30 s (criterion 50), or a lock-down alarm is 10 minutes
/// old (criterion 88).
pub fn auto_due(alarm: bool, current: bool, latest: Option<&Doctor>, last_started: Option<i64>, lockdown: bool, now: i64) -> bool {
    let recent = last_started.is_some_and(|t| now - t < AUTO_GAP_MS);
    let lockdown_due = lockdown && latest.is_some_and(|d| d.exit == 14 && now - d.started_at >= LOCKDOWN_RECHECK_MS);
    !recent && ((alarm && !current) || lockdown_due)
}

/// A control character (U+0000-U+001F, U+007F-U+009F) in a fix can drive a terminal it is pasted into.
fn has_control(text: &str) -> bool {
    text.chars().any(|c| c <= '\u{1f}' || ('\u{7f}'..='\u{9f}').contains(&c))
}

/// The text Copy Fix may put on the clipboard for `hop` (criteria 52, 54, 85).
pub fn fix_for(latest: Option<&Doctor>, hop: &str) -> Option<String> {
    let h = latest?.hops.iter().find(|h| h.hop == hop && !h.ok && !h.skipped)?;
    (!h.fix.is_empty() && !has_control(&h.fix)).then(|| h.fix.clone())
}

pub trait Clipboard {
    fn write(&mut self, text: &str) -> bool;
}

/// `copy_fix`: writes doctor's own fix byte for byte, or returns `no_fix` and writes nothing.
pub fn copy_fix(clipboard: &mut dyn Clipboard, latest: Option<&Doctor>, hop: &str) -> Result<(), String> {
    let fix = fix_for(latest, hop).ok_or("no_fix")?;
    if clipboard.write(&fix) {
        Ok(())
    } else {
        Err("no_fix".into())
    }
}
