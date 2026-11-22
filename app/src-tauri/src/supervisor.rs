//! Keeps the app's own `run` child alive and only watches a run it did not start (plan criteria
//! 36-48, 83, door 6). Times are ms since the epoch and passed in, so tests drive a fake clock.

use crate::sidecar::{argv, SidecarCall};
use crate::status::StatusRead;
use serde_json::Value;
use std::collections::VecDeque;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub const STOP_WAIT_MS: i64 = 5_000;
pub const HEALTHY_RUN_MS: i64 = 60_000;
pub const STDOUT_TAIL: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sig {
    Term,
    Kill,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChildExit {
    /// None when a signal ended the child.
    pub code: Option<i32>,
    /// The last `STDOUT_TAIL` bytes the child wrote.
    pub stdout: Vec<u8>,
}

/// A `run` child the app started. `try_exit` returns `Some` once, when the exit is observed; after
/// that the supervisor drops the handle and never signals it.
pub trait Child: Send {
    fn pid(&self) -> u32;
    fn try_exit(&mut self) -> Option<ChildExit>;
    fn signal(&mut self, sig: Sig);
}

pub trait Spawner: Send {
    fn spawn(&mut self, args: &[String]) -> Option<Box<dyn Child>>;
}

/// Backoff before the n-th successive restart: 1, 2, 4, 8, 16, then 30 s.
pub fn backoff_ms(failures: u32) -> i64 {
    [1_000, 2_000, 4_000, 8_000, 16_000].get(failures as usize).copied().unwrap_or(30_000)
}

/// `error.code` of the last stdout line that is a JSON object.
pub fn error_code(stdout: &[u8]) -> Option<String> {
    String::from_utf8_lossy(stdout)
        .lines()
        .rev()
        .find_map(|line| match serde_json::from_str::<Value>(line.trim()) {
            Ok(Value::Object(o)) => Some(o),
            _ => None,
        })?
        .get("error")?
        .get("code")?
        .as_str()
        .map(String::from)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Hold {
    /// Restart when status allows it.
    None,
    /// Exit 13, 0 or a config/key error: wait for Reconnect.
    Stopped,
    /// `already_running`: wait for a status with pid null, then back off.
    AwaitFree,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Then {
    Respawn,
    Exit,
}

struct Stopping {
    deadline: i64,
    killed: bool,
    then: Then,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Tick {
    /// Run `doctor --json` once (criterion 40).
    pub doctor: bool,
    /// Quit finished: the child is gone.
    pub exit: bool,
}

pub struct Supervisor {
    child: Option<Box<dyn Child>>,
    started_at: i64,
    spawned_at: Option<i64>,
    stopping: Option<Stopping>,
    pending: Option<i64>,
    failures: u32,
    hold: Hold,
    external: Option<u32>,
    quit: bool,
}

impl Default for Supervisor {
    fn default() -> Self {
        Supervisor {
            child: None,
            started_at: 0,
            spawned_at: None,
            stopping: None,
            pending: None,
            failures: 0,
            hold: Hold::None,
            external: None,
            quit: false,
        }
    }
}

impl Supervisor {
    pub fn child_pid(&self) -> Option<u32> {
        self.child.as_ref().map(|c| c.pid())
    }

    pub fn spawned_at(&self) -> Option<i64> {
        self.spawned_at
    }

    pub fn pending_restart(&self) -> Option<i64> {
        self.pending
    }

    fn spawn(&mut self, now: i64, spawner: &mut dyn Spawner) {
        let args = argv(&SidecarCall::Run, None).expect("run argv is fixed");
        self.spawned_at = Some(now);
        match spawner.spawn(&args) {
            Some(child) => {
                self.child = Some(child);
                self.started_at = now;
            }
            None => self.fail(now),
        }
    }

    fn fail(&mut self, now: i64) {
        self.pending = Some(now + backoff_ms(self.failures));
        self.failures += 1;
    }

    /// Reaps the child if its exit is observable now. Returns whether it is gone.
    fn reap(&mut self, now: i64, out: &mut Tick) -> bool {
        let Some(child) = self.child.as_mut() else { return true };
        let Some(exit) = child.try_exit() else { return false };
        self.child = None;
        if self.stopping.is_none() {
            self.classify(exit, now, out);
        }
        true
    }

    fn classify(&mut self, exit: ChildExit, now: i64, out: &mut Tick) {
        if now - self.started_at >= HEALTHY_RUN_MS {
            self.failures = 0;
        }
        match exit.code {
            Some(2) if error_code(&exit.stdout).as_deref() == Some("already_running") => self.hold = Hold::AwaitFree,
            Some(2) => {
                self.hold = Hold::Stopped;
                out.doctor = true;
            }
            Some(0) | Some(13) => self.hold = Hold::Stopped,
            _ => self.fail(now),
        }
    }

    /// One status poll: decides whether to start a run (criteria 36-38, 43).
    pub fn on_status(&mut self, status: &StatusRead, now: i64, spawner: &mut dyn Spawner) {
        let StatusRead::Run(r) = status else { return };
        self.external = r.pid.filter(|&pid| Some(pid) != self.child_pid());
        if self.quit || self.stopping.is_some() || self.child.is_some() || r.exit != 10 || r.pid.is_some() {
            return;
        }
        match self.hold {
            Hold::Stopped => {}
            Hold::AwaitFree => {
                self.hold = Hold::None;
                self.fail(now);
            }
            Hold::None if self.pending.is_none() => self.spawn(now, spawner),
            Hold::None => {}
        }
    }

    /// Reaps the child, fires a due restart and enforces the stop deadline.
    pub fn tick(&mut self, now: i64, spawner: &mut dyn Spawner) -> Tick {
        let mut out = Tick::default();
        let gone = self.reap(now, &mut out);
        if let Some(stop) = self.stopping.as_mut() {
            if gone {
                let then = stop.then;
                self.stopping = None;
                match then {
                    Then::Exit => out.exit = true,
                    Then::Respawn => {
                        self.failures = 0;
                        self.spawn(now, spawner);
                    }
                }
            } else if !stop.killed && now >= stop.deadline {
                stop.killed = true;
                self.child.as_mut().expect("not gone").signal(Sig::Kill);
            }
            return out;
        }
        if self.quit {
            out.exit = true;
            return out;
        }
        if gone && self.pending.is_some_and(|at| now >= at) {
            self.pending = None;
            if self.external.is_some() {
                self.hold = Hold::AwaitFree;
            } else {
                self.spawn(now, spawner);
            }
        }
        out
    }

    fn stop(&mut self, now: i64, then: Then) -> bool {
        let mut ignored = Tick::default();
        // An exit already observed leaves no handle to signal (criterion 83).
        if self.reap(now, &mut ignored) {
            return false;
        }
        self.child.as_mut().expect("not gone").signal(Sig::Term);
        self.stopping = Some(Stopping { deadline: now + STOP_WAIT_MS, killed: false, then });
        true
    }

    /// Reconnect (criteria 44, 45): restart an owned child, or start one at once. Does nothing while
    /// an external run is live.
    pub fn reconnect(&mut self, now: i64, spawner: &mut dyn Spawner) {
        if self.quit || self.stopping.is_some() || (self.child.is_none() && self.external.is_some()) {
            return;
        }
        let stopping = self.stop(now, Then::Respawn);
        // After `stop`, which may have just observed an exit and scheduled a restart.
        self.hold = Hold::None;
        self.pending = None;
        if !stopping {
            self.spawn(now, spawner);
        }
    }

    /// Quit (criterion 46): stop the owned child; `tick` reports `exit` once it is gone.
    pub fn quit(&mut self, now: i64) {
        self.quit = true;
        match self.stopping.as_mut() {
            Some(stop) => stop.then = Then::Exit,
            None => {
                self.stop(now, Then::Exit);
            }
        }
        self.pending = None;
    }
}

/// Quit: kills running status and doctor calls (through `CancellableRunner`) and stops the child.
pub fn begin_quit(calls: &AtomicBool, sup: &mut Supervisor, now: i64) {
    calls.store(true, Ordering::SeqCst);
    sup.quit(now);
}

/// The real `run` child: stdout and stderr drained as they arrive, stderr discarded, the last
/// 64 KiB of stdout kept (criterion 48).
pub struct ProcessSpawner {
    pub program: PathBuf,
}

struct ProcessChild {
    child: std::process::Child,
    tail: Arc<Mutex<VecDeque<u8>>>,
    reader: Option<JoinHandle<()>>,
}

impl Spawner for ProcessSpawner {
    fn spawn(&mut self, args: &[String]) -> Option<Box<dyn Child>> {
        let mut child = Command::new(&self.program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .ok()?;
        let mut stderr = child.stderr.take().expect("stderr is piped");
        std::thread::spawn(move || {
            let mut buf = [0u8; 16 * 1024];
            while matches!(stderr.read(&mut buf), Ok(n) if n > 0) {}
        });
        let mut stdout = child.stdout.take().expect("stdout is piped");
        let tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDOUT_TAIL)));
        let kept = tail.clone();
        let reader = std::thread::spawn(move || {
            let mut buf = [0u8; 16 * 1024];
            while let Ok(n @ 1..) = stdout.read(&mut buf) {
                let mut kept = kept.lock().unwrap();
                kept.extend(&buf[..n]);
                let over = kept.len().saturating_sub(STDOUT_TAIL);
                kept.drain(..over);
            }
        });
        Some(Box::new(ProcessChild { child, tail, reader: Some(reader) }))
    }
}

impl Child for ProcessChild {
    fn pid(&self) -> u32 {
        self.child.id()
    }

    fn try_exit(&mut self) -> Option<ChildExit> {
        let status = self.child.try_wait().ok()??;
        // The pipe closes with the child; wait briefly for the last bytes.
        let started = Instant::now();
        while self.reader.as_ref().is_some_and(|r| !r.is_finished()) && started.elapsed() < Duration::from_secs(1) {
            std::thread::sleep(Duration::from_millis(5));
        }
        if let Some(reader) = self.reader.take().filter(|r| r.is_finished()) {
            let _ = reader.join();
        }
        let stdout = self.tail.lock().unwrap().iter().copied().collect();
        Some(ChildExit { code: status.code(), stdout })
    }

    /// Only called before `try_exit` returned `Some`: the child is unreaped, so its pid cannot
    /// belong to another process yet (criterion 83).
    fn signal(&mut self, sig: Sig) {
        match sig {
            Sig::Kill => {
                let _ = self.child.kill();
            }
            Sig::Term => {
                // SAFETY: kill(2) on our own unreaped child's pid.
                unsafe {
                    libc::kill(self.child.id() as libc::pid_t, libc::SIGTERM);
                }
            }
        }
    }
}
