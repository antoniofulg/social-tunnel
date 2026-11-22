mod common;

use common::*;
use serde_json::{json, Value};
use social_tunnel_app_lib::doctor::{self, auto_due, Clipboard, Doctors, DOCTOR_TIMEOUT_MS};
use social_tunnel_app_lib::model::{self, Doctor, Entry, Inputs, TrayImage, TrayModel, Tracker};
use social_tunnel_app_lib::sidecar::{CallOutput, CancellableRunner, Runner};
use social_tunnel_app_lib::status::{StatusRead, MAX_STDOUT};
use social_tunnel_app_lib::supervisor::{
    error_code, Child, ChildExit, ProcessSpawner, Sig, Spawner, Supervisor, STDOUT_TAIL,
};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// ---- fakes -----------------------------------------------------------------------------------

type SignalLog = Arc<Mutex<Vec<(u32, Sig)>>>;

#[derive(Default)]
struct Proc {
    exit: Option<ChildExit>,
    /// Exits on SIGTERM; otherwise ignores it.
    term_exits: bool,
}

struct FakeChild {
    pid: u32,
    proc: Arc<Mutex<Proc>>,
    log: SignalLog,
}

impl Child for FakeChild {
    fn pid(&self) -> u32 {
        self.pid
    }
    fn try_exit(&mut self) -> Option<ChildExit> {
        self.proc.lock().unwrap().exit.take()
    }
    fn signal(&mut self, sig: Sig) {
        self.log.lock().unwrap().push((self.pid, sig));
        let mut p = self.proc.lock().unwrap();
        if sig == Sig::Kill || p.term_exits {
            p.exit = Some(ChildExit { code: None, stdout: vec![] });
        }
    }
}

/// Fake `run` children with pids 100, 101, …
#[derive(Default)]
struct Fakes {
    spawns: Vec<(u32, Vec<String>)>,
    procs: Vec<Arc<Mutex<Proc>>>,
    log: SignalLog,
    term_exits: bool,
}

impl Spawner for Fakes {
    fn spawn(&mut self, args: &[String]) -> Option<Box<dyn Child>> {
        let pid = 100 + self.spawns.len() as u32;
        self.spawns.push((pid, args.to_vec()));
        let proc = Arc::new(Mutex::new(Proc { exit: None, term_exits: self.term_exits }));
        self.procs.push(proc.clone());
        Some(Box::new(FakeChild { pid, proc, log: self.log.clone() }))
    }
}

impl Fakes {
    fn count(&self) -> usize {
        self.spawns.len()
    }
    /// Makes the latest child exit with `code` (None: a signal from outside).
    fn exit_last(&self, code: Option<i32>, stdout: &str) {
        self.procs.last().unwrap().lock().unwrap().exit = Some(ChildExit { code, stdout: stdout.as_bytes().to_vec() });
    }
    fn signals(&self) -> Vec<(u32, Sig)> {
        self.log.lock().unwrap().clone()
    }
}

/// Real processes, counted, with every signal logged.
struct Logged {
    inner: ProcessSpawner,
    spawns: Vec<(u32, Vec<String>)>,
    log: SignalLog,
}

struct LoggedChild {
    inner: Box<dyn Child>,
    log: SignalLog,
}

impl Child for LoggedChild {
    fn pid(&self) -> u32 {
        self.inner.pid()
    }
    fn try_exit(&mut self) -> Option<ChildExit> {
        self.inner.try_exit()
    }
    fn signal(&mut self, sig: Sig) {
        self.log.lock().unwrap().push((self.inner.pid(), sig));
        self.inner.signal(sig)
    }
}

impl Spawner for Logged {
    fn spawn(&mut self, args: &[String]) -> Option<Box<dyn Child>> {
        let inner = self.inner.spawn(args)?;
        self.spawns.push((inner.pid(), args.to_vec()));
        Some(Box::new(LoggedChild { inner, log: self.log.clone() }))
    }
}

/// A temp `social-tunnel` script; it gets `run --json` like the real sidecar.
fn script(name: &str, body: &str) -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("tray-s2-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("social-tunnel");
    std::fs::write(&path, format!("#!/bin/sh\ncd '{}'\n{body}\n", dir.display())).unwrap();
    std::process::Command::new("chmod").arg("+x").arg(&path).status().unwrap();
    (path, dir)
}

fn logged(program: PathBuf) -> Logged {
    Logged { inner: ProcessSpawner { program }, spawns: vec![], log: SignalLog::default() }
}

/// Ticks at `now` until the real child's exit is observed (or 10 s pass).
fn settle(sup: &mut Supervisor, now: i64, sp: &mut dyn Spawner) -> bool {
    let started = Instant::now();
    let mut doctor = false;
    while sup.child_pid().is_some() && started.elapsed() < Duration::from_secs(10) {
        doctor |= sup.tick(now, sp).doctor;
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(sup.child_pid().is_none(), "child did not exit");
    doctor
}

fn with_pid(state: &str, reason: Value, pid: Value) -> StatusRead {
    let mut b = body(state, reason);
    b["pid"] = pid;
    let exit = if state == "connected" { 0 } else { 10 };
    read(exit, &b)
}

fn free() -> StatusRead {
    exit10("stopped", Value::Null)
}

/// Polls `status` and ticks every 2 s over `[from, to)` ms after T0.
fn poll_for(sup: &mut Supervisor, sp: &mut dyn Spawner, status: &StatusRead, from: i64, to: i64) {
    let mut t = from;
    while t < to {
        sup.tick(T0 + t, sp);
        sup.on_status(status, T0 + t, sp);
        t += 2_000;
    }
}

fn view_with(tracker: &Tracker, status: &StatusRead, doctor: Option<&Doctor>, child: Option<u32>, now: i64, checking: bool) -> TrayModel {
    model::view(
        tracker,
        &Inputs { status, doctor, child_pid: child, spawned_at: None, now, checking, open_at_login: false },
    )
}

/// A doctor call's output for a result.
fn doctor_out(d: &Doctor) -> CallOutput {
    let v = json!({ "ok": d.exit == 0, "command": "doctor", "configPath": "/x/config.json", "hops": d.hops });
    out(d.exit, &v)
}

/// A runner that records argv and answers with `answer`.
struct Answer<F: Fn(&[String], Duration) -> CallOutput + Send + Sync> {
    calls: Mutex<Vec<Vec<String>>>,
    answer: F,
}

impl<F: Fn(&[String], Duration) -> CallOutput + Send + Sync> Runner for Answer<F> {
    fn run(&self, _p: &Path, args: &[String], timeout: Duration, _max: usize) -> CallOutput {
        self.calls.lock().unwrap().push(args.to_vec());
        (self.answer)(args, timeout)
    }
}

fn answer<F: Fn(&[String], Duration) -> CallOutput + Send + Sync>(f: F) -> Answer<F> {
    Answer { calls: Mutex::new(vec![]), answer: f }
}

#[derive(Default)]
struct FakeClipboard(Vec<String>);

impl Clipboard for FakeClipboard {
    fn write(&mut self, text: &str) -> bool {
        self.0.push(text.into());
        true
    }
}

const PROGRAM: &str = "/X/social-tunnel";

fn run_args() -> Vec<String> {
    vec!["run".into(), "--json".into()]
}

// ---- ownership and spawning ------------------------------------------------------------------

#[test]
fn tray_c36_external_live_run_is_only_watched() {
    for status in [
        with_pid("connected", Value::Null, json!(4242)),
        with_pid("stopped", json!("stale"), json!(4242)),
        with_pid("stopped", json!("config_changed"), json!(4242)),
    ] {
        let (mut sup, mut sp) = (Supervisor::default(), Fakes::default());
        poll_for(&mut sup, &mut sp, &status, 0, 20_000);
        assert_eq!(sp.count(), 0, "{status:?}");
        let mut tracker = Tracker::default();
        tracker.observe(&status, T0);
        let m = view_with(&tracker, &status, None, sup.child_pid(), T0, false);
        assert!(has(&m, "Managed outside the app (pid 4242)."));
        assert!(!has(&m, "Reconnect"));
        // Reconnect while it is external starts nothing and signals nothing.
        sup.reconnect(T0 + 20_000, &mut sp);
        assert_eq!(sp.count(), 0);
        assert!(sp.signals().is_empty());
    }
}

#[test]
fn tray_c37_pid_null_spawns_exactly_one_run() {
    let (mut sup, mut sp) = (Supervisor::default(), Fakes::default());
    sup.on_status(&free(), T0, &mut sp);
    assert_eq!(sp.spawns, vec![(100, run_args())]);
    poll_for(&mut sup, &mut sp, &free(), 2_000, 12_000);
    assert_eq!(sp.count(), 1);
}

const MIB_TO_STDERR: &str = "head -c 1048576 /dev/zero >&2";

#[test]
fn tray_c38_already_running_waits_for_pid_null_then_backs_off() {
    let (program, dir) = script(
        "c38",
        &format!("{MIB_TO_STDERR}\necho '{{\"ok\":false,\"command\":\"run\",\"error\":{{\"code\":\"already_running\",\"message\":\"m\"}}}}'\nexit 2"),
    );
    let mut sp = logged(program);
    let mut sup = Supervisor::default();
    sup.on_status(&free(), T0, &mut sp);
    assert_eq!(sp.spawns.len(), 1);
    assert!(!settle(&mut sup, T0, &mut sp), "already_running runs no doctor");
    let live = with_pid("stopped", json!("config_changed"), json!(4242));
    poll_for(&mut sup, &mut sp, &live, 2_000, 62_000);
    assert_eq!(sp.spawns.len(), 1, "respawned while another run is live");
    sup.on_status(&free(), T0 + 62_000, &mut sp);
    sup.tick(T0 + 62_999, &mut sp);
    assert_eq!(sp.spawns.len(), 1, "respawned before the 1 s backoff");
    sup.tick(T0 + 63_000, &mut sp);
    assert_eq!(sp.spawns.len(), 2);
    settle(&mut sup, T0 + 63_000, &mut sp);
    std::fs::remove_dir_all(dir).unwrap();
}

fn never_respawns(code: i32) {
    let (mut sup, mut sp) = (Supervisor::default(), Fakes::default());
    sup.on_status(&free(), T0, &mut sp);
    sp.exit_last(Some(code), "");
    poll_for(&mut sup, &mut sp, &free(), 1_000, 61_000);
    assert_eq!(sp.count(), 1, "exit {code} respawned");
}

#[test]
fn tray_c39_exit_13_is_not_restarted() {
    never_respawns(13);
}

#[test]
fn tray_c40_config_or_key_error_is_not_restarted_and_runs_doctor_once() {
    let (program, dir) = script(
        "c40",
        &format!("{MIB_TO_STDERR}\necho '{{\"ok\":false,\"command\":\"run\",\"error\":{{\"code\":\"key_permissions\",\"message\":\"m\"}}}}'\nexit 2"),
    );
    let mut sp = logged(program);
    let mut sup = Supervisor::default();
    sup.on_status(&free(), T0, &mut sp);
    let mut doctors_wanted = settle(&mut sup, T0, &mut sp) as usize;
    let mut t = 2_000;
    while t < 62_000 {
        doctors_wanted += sup.tick(T0 + t, &mut sp).doctor as usize;
        sup.on_status(&free(), T0 + t, &mut sp);
        t += 2_000;
    }
    assert_eq!(sp.spawns.len(), 1);
    assert_eq!(doctors_wanted, 1);
    // That request goes through the one doctor call.
    let runner = answer(|_, _| doctor_out(&doctor(2, Some("key"), T0)));
    Doctors::default().run(&runner, Path::new(PROGRAM), T0);
    assert_eq!(*runner.calls.lock().unwrap(), vec![vec!["doctor".to_string(), "--json".to_string()]]);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn tray_c41_clean_exit_without_our_signal_is_not_restarted() {
    never_respawns(0);
}

#[test]
fn tray_c42_failures_back_off_and_reset_after_a_healthy_minute() {
    let (mut sup, mut sp) = (Supervisor::default(), Fakes::default());
    sup.on_status(&free(), T0, &mut sp);
    let mut t = T0 + 500;
    let exits = [Some(1), Some(3), Some(1), Some(1), Some(1), Some(1), Some(1), None];
    let delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000];
    for (n, (code, delay)) in exits.iter().zip(delays).enumerate() {
        sp.exit_last(*code, "");
        sup.tick(t, &mut sp);
        assert_eq!(sp.count(), n + 1);
        sup.tick(t + delay - 1, &mut sp);
        assert_eq!(sp.count(), n + 1, "exit #{n} respawned before {delay} ms");
        sup.tick(t + delay, &mut sp);
        assert_eq!(sp.count(), n + 2, "exit #{n} not respawned at {delay} ms");
        t += delay + 500;
    }
    // This child lives 60 s, then exits 1: back to 1 s.
    let started = t - 500;
    sup.tick(started + 60_000, &mut sp);
    sp.exit_last(Some(1), "");
    sup.tick(started + 60_000, &mut sp);
    sup.tick(started + 60_999, &mut sp);
    assert_eq!(sp.count(), 9);
    sup.tick(started + 61_000, &mut sp);
    assert_eq!(sp.count(), 10);
}

#[test]
fn tray_c43_host_key_mismatch_at_start_spawns_nothing() {
    let (mut sup, mut sp) = (Supervisor::default(), Fakes::default());
    let mismatch = read(13, &body("blocked", json!("host_key_mismatch")));
    assert!(matches!(mismatch, StatusRead::Run(_)));
    poll_for(&mut sup, &mut sp, &mismatch, 0, 20_000);
    assert_eq!(sp.count(), 0);
}

// ---- Reconnect, Quit, signals ----------------------------------------------------------------

#[test]
fn tray_c44_reconnect_terms_then_kills_at_five_seconds_and_resets_backoff() {
    let (mut sup, mut sp) = (Supervisor::default(), Fakes::default());
    sup.on_status(&free(), T0, &mut sp);
    // Three failures first, so the backoff would be 8 s.
    for n in 0..3 {
        sp.exit_last(Some(1), "");
        sup.tick(T0 + n * 20_000 + 1, &mut sp);
        sup.tick(T0 + n * 20_000 + 10_000, &mut sp);
    }
    assert_eq!(sp.count(), 4);
    let t = T0 + 100_000;
    sup.reconnect(t, &mut sp);
    assert_eq!(sp.signals(), vec![(103, Sig::Term)]);
    sup.tick(t + 4_999, &mut sp);
    assert_eq!(sp.signals(), vec![(103, Sig::Term)]);
    assert_eq!(sp.count(), 4);
    sup.tick(t + 5_000, &mut sp);
    assert_eq!(sp.signals(), vec![(103, Sig::Term), (103, Sig::Kill)]);
    sup.tick(t + 5_000, &mut sp);
    assert_eq!(sp.count(), 5, "one new spawn after the kill");
    // The next failure backs off 1 s.
    sp.exit_last(Some(1), "");
    sup.tick(t + 6_000, &mut sp);
    sup.tick(t + 6_999, &mut sp);
    assert_eq!(sp.count(), 5);
    sup.tick(t + 7_000, &mut sp);
    assert_eq!(sp.count(), 6);

    // A child that exits on SIGTERM gets no SIGKILL.
    let (mut sup, mut sp) = (Supervisor::default(), Fakes { term_exits: true, ..Fakes::default() });
    sup.on_status(&free(), T0, &mut sp);
    sup.reconnect(T0 + 1_000, &mut sp);
    sup.tick(T0 + 1_100, &mut sp);
    sup.tick(T0 + 9_000, &mut sp);
    assert_eq!(sp.signals(), vec![(100, Sig::Term)]);
    assert_eq!(sp.count(), 2);
}

#[test]
fn tray_c45_reconnect_cancels_a_pending_restart_and_spawns_at_once() {
    let (mut sup, mut sp) = (Supervisor::default(), Fakes::default());
    sup.on_status(&free(), T0, &mut sp);
    let mut t = T0;
    for delay in [1_000, 2_000, 4_000, 8_000] {
        sp.exit_last(Some(1), "");
        sup.tick(t, &mut sp);
        t += delay;
        sup.tick(t, &mut sp);
    }
    sp.exit_last(Some(1), "");
    sup.tick(t, &mut sp);
    assert_eq!(sup.pending_restart(), Some(t + 16_000));
    let spawned = sp.count();
    sup.reconnect(t + 1_000, &mut sp);
    assert_eq!(sp.count(), spawned + 1);
    assert_eq!(sup.pending_restart(), None);
    sup.tick(t + 16_000, &mut sp);
    sup.tick(t + 40_000, &mut sp);
    assert_eq!(sp.count(), spawned + 1, "the cancelled restart fired");
    assert!(sp.signals().is_empty());
}

#[test]
fn tray_c46_quit_kills_calls_terms_the_child_and_exits_after_it_is_gone() {
    let hang = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/hang.sh");
    let quitting = Arc::new(AtomicBool::new(false));
    let calls: Vec<_> = (0..2)
        .map(|_| {
            let (hang, q) = (hang.clone(), quitting.clone());
            std::thread::spawn(move || {
                let started = Instant::now();
                let out = CancellableRunner(q).run(&hang, &[], Duration::from_millis(DOCTOR_TIMEOUT_MS), MAX_STDOUT);
                (out, started.elapsed())
            })
        })
        .collect();
    std::thread::sleep(Duration::from_millis(300));
    let (mut sup, mut sp) = (Supervisor::default(), Fakes::default());
    sup.on_status(&free(), T0, &mut sp);
    let t = T0 + 1_000;
    social_tunnel_app_lib::supervisor::begin_quit(&quitting, &mut sup, t);
    for call in calls {
        let (out, took) = call.join().unwrap();
        assert!(out.timed_out && took < Duration::from_secs(3), "{took:?}");
    }
    assert_eq!(sp.signals(), vec![(100, Sig::Term)]);
    assert!(!sup.tick(t + 4_999, &mut sp).exit);
    assert_eq!(sp.signals(), vec![(100, Sig::Term)]);
    assert!(!sup.tick(t + 5_000, &mut sp).exit, "exited before the child was gone");
    assert_eq!(sp.signals(), vec![(100, Sig::Term), (100, Sig::Kill)]);
    assert!(sup.tick(t + 5_000, &mut sp).exit);
    assert_eq!(sp.count(), 1);

    // A child that exits on SIGTERM gets no SIGKILL.
    let (mut sup, mut sp) = (Supervisor::default(), Fakes { term_exits: true, ..Fakes::default() });
    sup.on_status(&free(), T0, &mut sp);
    sup.quit(t);
    assert!(sup.tick(t + 100, &mut sp).exit);
    assert_eq!(sp.signals(), vec![(100, Sig::Term)]);
    // No child: Quit exits at once.
    let (mut sup, mut sp) = (Supervisor::default(), Fakes::default());
    sup.quit(t);
    assert!(sup.tick(t, &mut sp).exit);
    assert!(sp.signals().is_empty());
}

#[test]
fn tray_c47_signals_go_only_to_spawned_pids() {
    let external = with_pid("connected", Value::Null, json!(4242));
    let (mut sup, mut sp) = (Supervisor::default(), Fakes::default());
    // Nothing owned: Reconnect and Quit with an external live run.
    poll_for(&mut sup, &mut sp, &external, 0, 6_000);
    sup.reconnect(T0 + 6_000, &mut sp);
    sup.quit(T0 + 6_000);
    assert!(sup.tick(T0 + 6_000, &mut sp).exit);
    assert!(sp.signals().is_empty());

    // Owned children through every exit path, with an external pid in status meanwhile.
    let (mut sup, mut sp) = (Supervisor::default(), Fakes::default());
    sup.on_status(&free(), T0, &mut sp);
    let mut t = T0;
    for (code, stdout) in [(Some(1), ""), (None, ""), (Some(3), "")] {
        sp.exit_last(code, stdout);
        sup.on_status(&external, t, &mut sp);
        sup.tick(t, &mut sp);
        sup.on_status(&free(), t + 1, &mut sp);
        t += 60_000;
        sup.tick(t, &mut sp);
    }
    sup.reconnect(t, &mut sp);
    sup.tick(t + 5_000, &mut sp);
    sup.tick(t + 5_000, &mut sp);
    sup.on_status(&external, t + 6_000, &mut sp);
    sup.quit(t + 6_000);
    sup.tick(t + 11_000, &mut sp);
    let spawned: Vec<u32> = sp.spawns.iter().map(|(pid, _)| *pid).collect();
    assert!(!sp.signals().is_empty());
    for (pid, _) in sp.signals() {
        assert!(spawned.contains(&pid) && pid != 4242, "signalled {pid}");
    }
}

#[test]
fn tray_c83_no_signal_after_the_exit_was_observed() {
    // Exit observed, then Reconnect and Quit: zero signal calls.
    let (mut sup, mut sp) = (Supervisor::default(), Fakes::default());
    sup.on_status(&free(), T0, &mut sp);
    sp.exit_last(Some(1), "");
    sup.tick(T0 + 10, &mut sp);
    sup.reconnect(T0 + 20, &mut sp);
    assert!(sp.signals().is_empty());
    // Exited but not yet observed: Reconnect observes it instead of signalling.
    sp.exit_last(Some(1), "");
    sup.reconnect(T0 + 30, &mut sp);
    sp.exit_last(Some(1), "");
    sup.quit(T0 + 40);
    assert!(sup.tick(T0 + 40, &mut sp).exit);
    assert!(sp.signals().is_empty(), "{:?}", sp.signals());

    // A live real child: SIGTERM goes through its handle and reaches it.
    let (program, dir) = script("c83", "trap 'echo TERM > got; exit 0' TERM\necho ready > ready\nwhile :; do sleep 0.05; done");
    let mut sp = logged(program);
    let mut sup = Supervisor::default();
    sup.on_status(&free(), T0, &mut sp);
    let pid = sup.child_pid().unwrap();
    let started = Instant::now();
    while !dir.join("ready").exists() && started.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(20));
    }
    sup.quit(T0 + 1_000);
    let started = Instant::now();
    while !sup.tick(T0 + 1_000, &mut sp).exit && started.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(*sp.log.lock().unwrap(), vec![(pid, Sig::Term)]);
    assert_eq!(std::fs::read_to_string(dir.join("got")).unwrap().trim(), "TERM");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn tray_c48_pipes_are_drained_and_the_last_64_kib_classify_the_exit() {
    // 1 MiB on stderr does not block the child.
    let (program, dir) = script("c48a", &format!("{MIB_TO_STDERR}\necho past-stderr\nexec sleep 30"));
    let mut child = ProcessSpawner { program }.spawn(&run_args()).unwrap();
    std::thread::sleep(Duration::from_secs(2));
    assert!(child.try_exit().is_none(), "the child stopped");
    child.signal(Sig::Kill);
    let started = Instant::now();
    let exit = loop {
        if let Some(exit) = child.try_exit() {
            break exit;
        }
        assert!(started.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(String::from_utf8_lossy(&exit.stdout).trim(), "past-stderr", "stderr blocked the child");
    std::fs::remove_dir_all(dir).unwrap();

    // 7500 whole stdout lines (240 KB, past 200 KiB), then the JSON line.
    let json_line = r#"{"ok":false,"command":"run","error":{"code":"already_running","message":"m"}}"#;
    let (program, dir) =
        script("c48b", &format!("yes 'a log line that is not json' | head -n 7500\necho '{json_line}'\nexit 2"));
    let mut child = ProcessSpawner { program }.spawn(&run_args()).unwrap();
    let started = Instant::now();
    let exit = loop {
        if let Some(exit) = child.try_exit() {
            break exit;
        }
        assert!(started.elapsed() < Duration::from_secs(10));
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(exit.code, Some(2));
    assert_eq!(exit.stdout.len(), STDOUT_TAIL);
    assert_eq!(STDOUT_TAIL, 64 * 1024);
    assert!(exit.stdout.ends_with(format!("{json_line}\n").as_bytes()));
    assert_eq!(error_code(&exit.stdout).as_deref(), Some("already_running"));
    std::fs::remove_dir_all(dir).unwrap();
}

// ---- doctor ----------------------------------------------------------------------------------

#[test]
fn tray_c49_run_check_is_single_flight_and_shows_checking() {
    let release = Arc::new(AtomicBool::new(false));
    let gate = release.clone();
    let runner = Arc::new(answer(move |_, _| {
        while !gate.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(10));
        }
        doctor_out(&doctor(10, Some("forward"), T0))
    }));
    let doctors = Arc::new(Doctors::default());
    let spawn_run = || {
        let (d, r) = (doctors.clone(), runner.clone());
        std::thread::spawn(move || d.run(r.as_ref(), Path::new(PROGRAM), T0))
    };
    let menu = spawn_run();
    let started = Instant::now();
    while !doctors.running() {
        assert!(started.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(5));
    }
    let m = World::new().view(&connected(), None);
    let checking = view_with(&Tracker::default(), &connected(), None, None, T0, doctors.running());
    assert!(has(&m, "Run Check"));
    assert!(checking
        .menu
        .contains(&Entry::Action { id: "run_check".into(), text: "Checking…".into(), enabled: false, accelerator: None }));
    let second_menu = spawn_run();
    let ipc = spawn_run();
    std::thread::sleep(Duration::from_millis(100));
    release.store(true, Ordering::SeqCst);
    let results: Vec<_> = [menu, second_menu, ipc].into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(runner.calls.lock().unwrap().len(), 1, "a second doctor started");
    assert!(results[0].is_some());
    assert!(results.iter().all(|r| *r == results[0]));
    assert!(!doctors.running());
}

#[test]
fn tray_c50_disconnected_or_blocked_runs_doctor_at_most_every_30_s() {
    let mut tracker = Tracker::default();
    let mut latest: Option<Doctor> = None;
    let mut last: Option<i64> = None;
    let mut step = |at: i64, status: &StatusRead, image: TrayImage, latest: &mut Option<Doctor>, last: &mut Option<i64>| {
        let now = T0 + at;
        tracker.observe(status, now);
        let current = latest.as_ref().is_some_and(|d| tracker.is_current(d, now));
        let alarm = matches!(image, TrayImage::Disconnected | TrayImage::Blocked);
        let due = auto_due(alarm, current, latest.as_ref(), *last, false, now);
        if due {
            *last = Some(now);
            *latest = Some(doctor(10, Some("server_reachable"), now));
        }
        due
    };
    let down = exit10("disconnected", json!("auth_failed"));
    assert!(step(0, &down, TrayImage::Disconnected, &mut latest, &mut last), "entering Disconnected");
    assert!(!step(2_000, &down, TrayImage::Disconnected, &mut latest, &mut last), "current result");
    let blocked = read(11, &body("blocked", json!("port_blocked")));
    assert!(!step(20_000, &blocked, TrayImage::Blocked, &mut latest, &mut last), "Blocked 20 s later");
    assert!(step(31_000, &down, TrayImage::Disconnected, &mut latest, &mut last), "Disconnected 31 s after");

    // At launch: the first poll spawns run and shows Reconnecting, so no doctor.
    let (mut sup, mut sp) = (Supervisor::default(), Fakes::default());
    let mut tracker = Tracker::default();
    let stopped = free();
    tracker.observe(&stopped, T0);
    sup.on_status(&stopped, T0, &mut sp);
    let m = model::view(
        &tracker,
        &Inputs {
            status: &stopped,
            doctor: None,
            child_pid: sup.child_pid(),
            spawned_at: sup.spawned_at(),
            now: T0,
            checking: false,
            open_at_login: false,
        },
    );
    assert_eq!(sp.count(), 1);
    assert_eq!(m.title, "Reconnecting…");
    let alarm = matches!(m.image, TrayImage::Disconnected | TrayImage::Blocked);
    assert!(!auto_due(alarm, false, None, None, false, T0));
}

#[test]
fn tray_c51_hung_doctor_is_killed_at_120_s_and_the_previous_result_kept() {
    let doctors = Doctors::default();
    let good = doctor(10, Some("forward"), T0);
    let ok = answer(|_, _| doctor_out(&doctor(10, Some("forward"), T0)));
    doctors.run(&ok, Path::new(PROGRAM), T0);
    assert_eq!(doctors.latest(), Some(good));
    let hung = answer(|_, timeout| {
        assert_eq!(timeout, Duration::from_secs(120));
        CallOutput { exit: None, stdout: vec![], timed_out: true, overflow: false }
    });
    assert_eq!(doctors.run(&hung, Path::new(PROGRAM), T0 + 60_000), None);
    assert_eq!(hung.calls.lock().unwrap().len(), 1);
    assert_eq!(doctors.latest().map(|d| d.started_at), Some(T0));
    // The real runner kills a call at its timeout (C13 proves the kill on a hanging fixture).
    assert_eq!(DOCTOR_TIMEOUT_MS, 120_000);
}

fn doctor_with_fix(hop: &str, fix: &str) -> Doctor {
    let mut d = doctor(10, Some(hop), T0);
    d.hops.iter_mut().find(|h| h.hop == hop).unwrap().fix = fix.into();
    d
}

#[test]
fn tray_c52_copy_fix_copies_the_first_failing_fix_byte_for_byte() {
    let fix = r#"ssh root@vps.example.com 'printf "%s\n" "permitlisten=\"127.0.0.1:8888\" ssh-ed25519 AAAA" >> keys'"#;
    let d = doctor_with_fix("forward", fix);
    let hop = d.first_failing().unwrap().hop.clone();
    assert_eq!(hop, "forward");
    let mut clip = FakeClipboard::default();
    assert_eq!(doctor::copy_fix(&mut clip, Some(&d), &hop), Ok(()));
    assert_eq!(clip.0, vec![fix.to_string()]);
}

fn copy_fix_enabled(m: &TrayModel) -> Option<bool> {
    m.menu.iter().find_map(|e| match e {
        Entry::Action { id, enabled, .. } if id == "copy_fix" => Some(*enabled),
        _ => None,
    })
}

#[test]
fn tray_c53_copy_fix_is_disabled_without_a_fix() {
    let blocked = read(11, &body("blocked", json!("port_blocked")));
    let mut w = World::new();
    w.poll(0, &blocked, None);
    let empty = doctor_with_fix("forward", "");
    for d in [None, Some(doctor(0, None, T0)), Some(empty)] {
        assert_eq!(copy_fix_enabled(&w.view(&blocked, d.as_ref())), Some(false), "{d:?}");
    }
    let with_fix = doctor(11, Some("forward"), T0);
    assert_eq!(copy_fix_enabled(&w.view(&blocked, Some(&with_fix))), Some(true));
}

#[test]
fn tray_c54_copy_fix_refuses_unknown_passed_or_missing_hops() {
    let d = doctor(10, Some("forward"), T0);
    let mut clip = FakeClipboard::default();
    assert_eq!(doctor::copy_fix(&mut clip, Some(&d), "nope"), Err("no_fix".into()));
    assert_eq!(doctor::copy_fix(&mut clip, Some(&doctor(10, Some("forward"), T0)), "config"), Err("no_fix".into()));
    let passed = doctor(0, None, T0);
    assert_eq!(doctor::copy_fix(&mut clip, Some(&passed), "egress"), Err("no_fix".into()));
    assert_eq!(doctor::copy_fix(&mut clip, None, "forward"), Err("no_fix".into()));
    assert!(clip.0.is_empty());
}

#[test]
fn tray_c85_copy_fix_refuses_control_characters() {
    let mut clip = FakeClipboard::default();
    for bad in ["a\nb", "a\rb", "a\x1b[2Jb", "a\x7fb", "a\u{85}b", "a\0b"] {
        let d = doctor_with_fix("forward", bad);
        assert_eq!(doctor::copy_fix(&mut clip, Some(&d), "forward"), Err("no_fix".into()), "{bad:?}");
    }
    assert!(clip.0.is_empty());
    let fine = r#"permitlisten="127.0.0.1:8888" key=value"#;
    assert_eq!(doctor::copy_fix(&mut clip, Some(&doctor_with_fix("forward", fine)), "forward"), Ok(()));
    assert_eq!(clip.0, vec![fine.to_string()]);
}

#[test]
fn tray_c88_lockdown_alarm_rechecks_every_ten_minutes_until_clear() {
    let starts = Arc::new(Mutex::new(Vec::<i64>::new()));
    let doctors = Doctors::default();
    let mut w = World::new();
    let status = connected();
    w.tracker.observe(&status, T0);
    // The alarm: a current lock-down result at T0.
    let first = answer(|_, _| doctor_out(&doctor(14, Some("lockdown"), T0)));
    doctors.run(&first, Path::new(PROGRAM), T0);
    let mut lockdown = false;
    let mut at = 2_000;
    while at <= 50 * 60_000 {
        let now = T0 + at;
        w.now = now;
        w.tracker.observe(&status, now);
        let latest = doctors.latest();
        let m = w.view(&status, latest.as_ref());
        let current = latest.as_ref().is_some_and(|d| w.tracker.is_current(d, now));
        let alarm = matches!(m.image, TrayImage::Disconnected | TrayImage::Blocked);
        if auto_due(alarm, current, latest.as_ref(), doctors.last_started(), lockdown, now) {
            starts.lock().unwrap().push(at);
            let exit = if at >= 30 * 60_000 { 0 } else { 14 };
            let runner = answer(move |_, _| {
                doctor_out(&if exit == 14 { doctor(14, Some("lockdown"), 0) } else { doctor(0, None, 0) })
            });
            doctors.run(&runner, Path::new(PROGRAM), now);
        }
        lockdown = m.title == "Server allows too much";
        at += 2_000;
    }
    assert_eq!(*starts.lock().unwrap(), vec![10 * 60_000, 20 * 60_000, 30 * 60_000]);
}

#[test]
fn tray_c26_no_supervisor_or_doctor_call_passes_domain() {
    let runner = answer(|_, _| doctor_out(&doctor(10, Some("forward"), T0)));
    let doctors = Doctors::default();
    // Run Check, run_check and Check Again share `run`; automatic runs use try_begin + finish.
    doctors.run(&runner, Path::new(PROGRAM), T0);
    doctors.run(&runner, Path::new(PROGRAM), T0 + 1);
    assert!(doctors.try_begin(T0 + 2));
    doctors.finish(&runner, Path::new(PROGRAM), T0 + 2);
    let calls = runner.calls.lock().unwrap();
    assert_eq!(calls.len(), 3);
    assert!(calls.iter().all(|a| a == &vec!["doctor".to_string(), "--json".to_string()]), "{calls:?}");
    let (mut sup, mut sp) = (Supervisor::default(), Fakes::default());
    sup.on_status(&free(), T0, &mut sp);
    sup.reconnect(T0 + 1, &mut sp);
    sup.tick(T0 + 6_000, &mut sp);
    sup.tick(T0 + 6_000, &mut sp);
    assert!(sp.spawns.iter().all(|(_, a)| a == &run_args()), "{:?}", sp.spawns);
    let lib = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs")).unwrap();
    assert!(!lib.contains("--domain") && !lib.contains("domain: Some"));
}
