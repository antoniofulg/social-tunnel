mod common;

use common::*;
use serde_json::{json, Value};
use social_tunnel_app_lib::driver::{Driver, Icon, PollGate, Snapshot, TraySink, FRAME_MS, POLL_MS};
use social_tunnel_app_lib::model::{self, cut, Entry, Inputs, TrayImage, TrayModel, Tracker};
use social_tunnel_app_lib::nav::navigation_allowed;
use social_tunnel_app_lib::status::StatusRead;

fn iso(ms: i64) -> String {
    // T0 = 2026-09-21T14:13:20.000Z
    let base = social_tunnel_app_lib::status::parse_iso_ms("2026-09-21T14:13:20.000Z").unwrap();
    assert_eq!(base, T0);
    let d = ms - T0;
    let total = 14 * 3_600_000 + 13 * 60_000 + 20_000 + d;
    format!("2026-09-21T{:02}:{:02}:{:02}.{:03}Z", total / 3_600_000, total / 60_000 % 60, total / 1000 % 60, total % 1000)
}

fn with(mut v: Value, f: impl FnOnce(&mut Value)) -> Value {
    f(&mut v);
    v
}

#[test]
fn tray_c12_one_status_call_in_flight_ticks_skip_while_busy() {
    assert_eq!(POLL_MS, 2_000);
    // Simulates ticks at 0..=10 s against a call of `duration` ms through the real gate.
    let simulate = |duration: i64| {
        let gate = PollGate::default();
        let mut busy_until: Option<i64> = None;
        let mut calls = Vec::new();
        let mut max_in_flight = 0;
        for t in (0..=10_000).step_by(POLL_MS as usize) {
            if busy_until.is_some_and(|end| end <= t) {
                gate.finish();
                busy_until = None;
            }
            if gate.try_start() {
                calls.push(t);
                if duration == 0 {
                    gate.finish();
                } else {
                    busy_until = Some(t + duration);
                }
            }
            max_in_flight = max_in_flight.max(busy_until.is_some() as i32);
        }
        (calls, max_in_flight)
    };
    assert_eq!(simulate(0).0, vec![0, 2_000, 4_000, 6_000, 8_000, 10_000]);
    let (calls, in_flight) = simulate(5_000);
    assert_eq!(calls, vec![0, 6_000]);
    assert!(in_flight <= 1);
}

#[test]
fn tray_c14_missing_config_is_not_set_up_with_six_entries() {
    let mut w = World::new();
    let m = w.poll(0, &config_invalid(false), None);
    assert_eq!(m.image, TrayImage::NotSetUp);
    assert_eq!(
        m.menu,
        vec![
            Entry::Info { text: "Not set up".into() },
            Entry::Info { text: "Nothing is routed yet.".into() },
            Entry::Separator,
            Entry::Action { id: "set_up".into(), text: "Set Up…".into(), enabled: true, accelerator: None },
            Entry::Separator,
            Entry::Action { id: "quit".into(), text: "Quit Social Tunnel".into(), enabled: true, accelerator: Some("CmdOrCtrl+Q".into()) },
        ]
    );
}

#[test]
fn tray_c15_invalid_existing_config_is_disconnected() {
    let m = World::new().poll(0, &config_invalid(true), None);
    assert_eq!((m.image, m.title.as_str()), (TrayImage::Disconnected, "Disconnected"));
    assert_eq!(texts(&m)[0], "Disconnected");
}

#[test]
fn tray_c16_connected_lists_the_allowlist_up_to_ten() {
    let m = World::new().poll(0, &connected(), None);
    assert_eq!(m.image, TrayImage::Connected);
    assert_eq!(&texts(&m)[..6], ["Connected", "—", "Through home", "instagram.com", "facebook.com", "threads.net"]);
    assert_eq!(texts(&m)[6], "—");

    let twelve: Vec<String> = (1..=12).map(|n| format!("site{n}.com")).collect();
    let status = read(0, &with(body("connected", Value::Null), |b| b["allowlist"] = json!(twelve)));
    let t = texts(&World::new().poll(0, &status, None));
    assert_eq!(&t[3..13], &twelve[..10]);
    assert_eq!(t[13], "2 more in Settings");
    assert_eq!(t[14], "—");
}

#[test]
fn tray_c17_retrying_under_sixty_seconds_is_reconnecting_with_next_try() {
    for status in [exit10("connecting", Value::Null), exit10("reconnecting", Value::Null), exit10("disconnected", json!("connection_lost"))] {
        let mut w = World::new();
        w.poll(0, &status, None);
        let m = w.poll(59_000, &status, None);
        assert_eq!((m.image, m.title.as_str()), (TrayImage::Reconnecting, "Reconnecting…"));
        assert_eq!(texts(&m)[1], "Trying now.");
    }
    let retry = |at: Option<i64>| {
        let b = with(body("reconnecting", Value::Null), |b| b["retryAt"] = at.map_or(Value::Null, |t| json!(iso(t))));
        let mut w = World::new();
        texts(&w.poll(0, &read(10, &b), None))[1].clone()
    };
    assert_eq!(retry(Some(T0 + 7_200)), "Next try in 8 s.");
    assert_eq!(retry(None), "Trying now.");
    assert_eq!(retry(Some(T0 - 3_000)), "Trying now.");
}

#[test]
fn tray_c18_sixty_seconds_of_downtime_is_disconnected_and_connected_restarts_it() {
    for status in [exit10("connecting", Value::Null), exit10("reconnecting", Value::Null), exit10("disconnected", json!("connection_lost"))] {
        let mut w = World::new();
        w.poll(0, &status, None);
        let m = w.poll(60_000, &status, None);
        assert_eq!((m.image, m.title.as_str()), (TrayImage::Disconnected, "Disconnected"));
        // A connected poll in between restarts the count.
        w.poll(62_000, &connected(), None);
        let m = w.poll(64_000, &status, None);
        assert_eq!(m.image, TrayImage::Reconnecting);
        let m = w.poll(121_000, &status, None);
        assert_eq!(m.image, TrayImage::Reconnecting);
        let m = w.poll(122_000, &status, None);
        assert_eq!(m.image, TrayImage::Disconnected);
    }
}

#[test]
fn tray_c19_auth_failed_is_disconnected_at_once() {
    let m = World::new().poll(0, &exit10("disconnected", json!("auth_failed")), None);
    assert_eq!((m.image, m.title.as_str()), (TrayImage::Disconnected, "Disconnected"));
}

#[test]
fn tray_c20_stopped_is_disconnected_except_five_seconds_after_a_spawn() {
    let stopped = exit10("stopped", Value::Null);
    let mut w = World::new();
    let m = w.poll(0, &stopped, None);
    assert_eq!(m.title, "Disconnected");
    let at = |since_spawn: i64| {
        let mut tracker = Tracker::default();
        tracker.observe(&stopped, T0 + since_spawn);
        model::view(
            &tracker,
            &Inputs { status: &stopped, doctor: None, child_pid: None, spawned_at: Some(T0), now: T0 + since_spawn, checking: false, open_at_login: false },
        )
    };
    assert_eq!(at(4_900).title, "Reconnecting…");
    assert_eq!(at(5_000).title, "Disconnected");
}

#[test]
fn tray_c21_stale_adds_stopped_reporting_row() {
    let s = read(10, &with(body("stopped", json!("stale")), |b| b["pid"] = json!(4242)));
    assert!(has(&World::new().poll(0, &s, None), "The tunnel stopped reporting."));
}

#[test]
fn tray_c22_config_changed_adds_older_config_row() {
    let s = read(10, &with(body("stopped", json!("config_changed")), |b| b["pid"] = json!(4242)));
    assert!(has(&World::new().poll(0, &s, None), "The running tunnel uses an older config."));
}

fn blocked_port() -> StatusRead {
    read(11, &with(body("blocked", json!("port_blocked")), |b| b["ok"] = json!(false)))
}

fn key_changed() -> StatusRead {
    read(13, &with(body("blocked", json!("host_key_mismatch")), |b| b["ok"] = json!(false)))
}

fn action_after_separator(m: &TrayModel) -> String {
    let t = texts(m);
    let sep = t.iter().position(|x| x == "—").unwrap();
    t[sep + 1].clone()
}

#[test]
fn tray_c23_port_blocked_rows_and_copy_fix() {
    let m = World::new().poll(0, &blocked_port(), None);
    assert_eq!(m.image, TrayImage::Blocked);
    assert_eq!(
        &texts(&m)[..3],
        ["Blocked at the server", "Tunnel port: the server refused port 8888", "Fix: free port 8888, allow it for the key"]
    );
    assert_eq!(action_after_separator(&m), "Copy Fix");
}

#[test]
fn tray_c24_host_key_mismatch_rows_and_review_even_with_lockdown_doctor() {
    for doctor in [None, Some(doctor(14, Some("lockdown"), T0))] {
        let m = World::new().poll(0, &key_changed(), doctor.as_ref());
        assert_eq!(m.image, TrayImage::Blocked);
        assert_eq!(
            &texts(&m)[..3],
            ["Server key changed", "Server: host key does not match the saved one", "Fix: do not connect until you know why"]
        );
        assert_eq!(action_after_separator(&m), "Review Server Key…");
    }
}

#[test]
fn tray_c25_lockdown_doctor_blocks_with_precedence() {
    let lock = doctor(14, Some("lockdown"), T0);
    for status in [connected(), exit10("reconnecting", Value::Null), blocked_port()] {
        let m = World::new().poll(0, &status, Some(&lock));
        assert_eq!(m.image, TrayImage::Blocked);
        assert_eq!(
            &texts(&m)[..3],
            ["Server allows too much", "Lock-down: the tunnel user can do more than forward", "Fix: restrict the tunnel user on the server"]
        );
        assert_eq!(action_after_separator(&m), "Copy Fix");
    }
    assert_eq!(World::new().poll(0, &key_changed(), Some(&lock)).title, "Server key changed");
    assert_eq!(World::new().poll(0, &config_invalid(false), Some(&lock)).title, "Not set up");
    assert_eq!(World::new().poll(0, &config_invalid(true), Some(&lock)).title, "Disconnected");
    let m = World::new().poll(0, &StatusRead::Unreadable, Some(&lock));
    assert!(has(&m, "Can't read the tunnel status.") && m.title == "Disconnected");
    // After a status change, or 10 minutes later, the result is no longer current.
    let mut w = World::new();
    w.poll(0, &exit10("reconnecting", Value::Null), None);
    let early = doctor(14, Some("lockdown"), T0 + 1_000);
    assert_eq!(w.poll(2_000, &connected(), Some(&early)).title, "Connected");
    let mut w = World::new();
    w.poll(0, &connected(), None);
    assert_eq!(w.poll(600_000, &connected(), Some(&lock)).title, "Connected");
    assert_eq!(World::new().poll(0, &connected(), Some(&doctor(0, None, T0))).title, "Connected");
}

#[test]
fn tray_c26_the_app_builds_no_domain_doctor_call() {
    // The only doctor call the app constructs in v0.2 (Run Check, automatic runs, run_check and
    // Check Again all go through it) carries no --domain.
    let args = social_tunnel_app_lib::sidecar::argv(&social_tunnel_app_lib::sidecar::SidecarCall::Doctor { domain: None }, None).unwrap();
    assert!(!args.iter().any(|a| a == "--domain"));
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs")).unwrap();
    assert!(!src.contains("domain: Some"));
}

#[test]
fn tray_c27_disconnected_shows_the_first_failing_hops_two_rows() {
    let pairs = [
        ("config", 2, ["This Mac: the config file needs a fix", "Fix: open Settings for the field to change"]),
        ("key", 2, ["This Mac: the tunnel key can't be used", "Fix: open Settings for the key fix"]),
        ("server_reachable", 10, ["Server: no connection to vps.example.com:22", "Fix: check the server is up and allows SSH"]),
        ("ssh_auth", 10, ["Server: SSH sign-in failed", "Fix: open Settings for the full fix"]),
        ("forward", 10, ["Tunnel port: the server did not answer", "Fix: run the check again"]),
        ("lockdown", 10, ["Lock-down: the server did not answer", "Fix: run the check again"]),
        ("egress", 10, ["This Mac: no internet connection to instagram.com", "Fix: check this Mac's internet and DNS"]),
    ];
    let stopped = exit10("stopped", Value::Null);
    for (hop, exit, rows) in pairs {
        let d = doctor(exit, Some(hop), T0);
        let m = World::new().poll(0, &stopped, Some(&d));
        assert_eq!(m.title, "Disconnected");
        assert_eq!(&texts(&m)[1..3], rows, "{hop}");
        assert!(rows.iter().all(|r| r.chars().count() <= 60));
    }
    let none = World::new().poll(0, &stopped, None);
    let ok = World::new().poll(0, &stopped, Some(&doctor(0, None, T0)));
    for m in [none, ok] {
        assert_eq!(texts(&m)[1], "3 domains paused. Nothing goes direct.");
    }
    let mut w = World::new();
    w.poll(0, &exit10("reconnecting", Value::Null), None);
    let old = doctor(10, Some("egress"), T0);
    let m = w.poll(61_000, &stopped, Some(&old));
    assert_eq!(texts(&m)[1], "3 domains paused. Nothing goes direct.");
}

#[test]
fn tray_c28_paused_row_counts_domains() {
    let count = |n: u64| read(10, &with(body("reconnecting", Value::Null), |b| b["domains"] = json!(n)));
    let m = World::new().poll(0, &count(5), None);
    assert!(has(&m, "5 domains paused. Nothing goes direct."));
    let m = World::new().poll(0, &count(1), None);
    assert!(has(&m, "1 domain paused. Nothing goes direct."));
    let m = World::new().poll(0, &read(10, &with(body("stopped", Value::Null), |b| b["domains"] = json!(5))), None);
    assert!(has(&m, "5 domains paused. Nothing goes direct."));
    let m = World::new().poll(0, &read(11, &with(body("blocked", json!("port_blocked")), |b| b["domains"] = json!(5))), None);
    assert!(has(&m, "5 domains paused. Nothing goes direct."));

    let mut w = World::new();
    w.poll(0, &read(0, &with(body("connected", Value::Null), |b| b["domains"] = json!(3))), None);
    assert!(has(&w.poll(2_000, &StatusRead::Unreadable, None), "3 domains paused. Nothing goes direct."));
    let paused = |m: &TrayModel| texts(m).iter().any(|t| t.contains("paused"));
    assert!(!paused(&World::new().poll(0, &StatusRead::Unreadable, None)));
    assert!(!paused(&World::new().poll(0, &connected(), None)));
    assert!(!paused(&World::new().poll(0, &config_invalid(false), None)));
}

#[test]
fn tray_c29_every_layout_ends_with_the_trailing_rows() {
    let lock = doctor(14, Some("lockdown"), T0);
    let layouts: Vec<(&str, StatusRead, Option<_>, Option<&str>)> = vec![
        ("Connected", connected(), None, None),
        ("Reconnecting…", exit10("reconnecting", Value::Null), None, None),
        ("Disconnected", exit10("disconnected", json!("auth_failed")), None, None),
        ("Blocked at the server", blocked_port(), None, Some("Copy Fix")),
        ("Server key changed", key_changed(), None, Some("Review Server Key…")),
        ("Server allows too much", connected(), Some(lock), Some("Copy Fix")),
    ];
    for (title, status, doctor, action) in layouts {
        for external in [false, true] {
            let status = match (&status, external) {
                (StatusRead::Run(r), true) => {
                    let mut r = r.clone();
                    r.pid = Some(4242);
                    StatusRead::Run(r)
                }
                _ => status.clone(),
            };
            let mut tracker = Tracker::default();
            tracker.observe(&status, T0);
            let m = model::view(
                &tracker,
                &Inputs { status: &status, doctor: doctor.as_ref(), child_pid: None, spawned_at: None, now: T0, checking: false, open_at_login: true },
            );
            assert_eq!(m.title, title);
            let mut expected: Vec<Entry> = Vec::new();
            if let Some(a) = action {
                let id = if a == "Copy Fix" { "copy_fix" } else { "review_key" };
                // Copy Fix is enabled only while a doctor result holds a fix (criterion 53).
                let enabled = a != "Copy Fix" || doctor.is_some();
                expected.push(Entry::Action { id: id.into(), text: a.into(), enabled, accelerator: None });
            }
            expected.push(Entry::Action { id: "run_check".into(), text: "Run Check".into(), enabled: true, accelerator: None });
            if !external {
                expected.push(Entry::Action { id: "reconnect".into(), text: "Reconnect".into(), enabled: true, accelerator: None });
            }
            expected.push(Entry::Action { id: "settings".into(), text: "Settings…".into(), enabled: true, accelerator: Some("CmdOrCtrl+,".into()) });
            expected.push(Entry::Check { id: "open_at_login".into(), text: "Open at Login".into(), checked: true });
            expected.push(Entry::Separator);
            expected.push(Entry::Action { id: "quit".into(), text: "Quit Social Tunnel".into(), enabled: true, accelerator: Some("CmdOrCtrl+Q".into()) });
            let tail = &m.menu[m.menu.len() - expected.len()..];
            assert_eq!(tail, &expected[..], "{title} external={external}");
            assert_eq!(m.menu[m.menu.len() - expected.len() - 1], Entry::Separator, "{title}");
            assert_eq!(has(&m, "Managed outside the app (pid 4242)."), external);
        }
    }
}

#[test]
fn tray_c30_rows_over_sixty_characters_are_cut() {
    let sixty_one = format!("{}.com", "a".repeat(57));
    assert_eq!(sixty_one.chars().count(), 61);
    let cut61 = cut(&sixty_one);
    assert_eq!(cut61.chars().count(), 60);
    assert_eq!(cut61, format!("{}…", &sixty_one[..59]));
    let sixty = format!("{}.com", "a".repeat(56));
    assert_eq!(cut(&sixty), sixty);
    let status = read(0, &with(body("connected", Value::Null), |b| b["allowlist"] = json!([sixty_one.clone(), sixty.clone()])));
    let t = texts(&World::new().poll(0, &status, None));
    assert_eq!(&t[3..5], [cut61, sixty]);
}

#[derive(Default)]
struct Sink {
    icons: Vec<Icon>,
    menus: usize,
    snapshots: usize,
    timers: i32,
    starts: usize,
    stops: usize,
}

impl TraySink for Sink {
    fn set_icon(&mut self, icon: Icon) {
        self.icons.push(icon);
    }
    fn set_menu(&mut self, _menu: &[Entry]) {
        self.menus += 1;
    }
    fn emit_snapshot(&mut self, _snapshot: &Snapshot) {
        self.snapshots += 1;
    }
    fn start_timer(&mut self) {
        self.timers += 1;
        self.starts += 1;
    }
    fn stop_timer(&mut self) {
        self.timers -= 1;
        self.stops += 1;
    }
}

fn apply(driver: &mut Driver, sink: &mut Sink, w: &mut World, at: i64, status: &StatusRead, reduce_motion: bool) {
    let m = w.poll(at, status, None);
    let snap = Snapshot::new(&m, status, None, None);
    driver.apply(&m, snap, reduce_motion, sink);
}

#[test]
fn tray_c32_reconnecting_cycles_eight_frames_at_150_ms() {
    assert_eq!(FRAME_MS, 150);
    let (mut d, mut sink, mut w) = (Driver::default(), Sink::default(), World::new());
    apply(&mut d, &mut sink, &mut w, 0, &exit10("reconnecting", Value::Null), false);
    assert_eq!(sink.icons, vec![Icon::Frame(0)]);
    assert_eq!(sink.timers, 1);
    // One tick per 150 ms: frames 1-7 at 150..1050 ms, frame 0 again at 1200 ms.
    for _ in (FRAME_MS..=1200).step_by(FRAME_MS as usize) {
        d.tick(&mut sink);
    }
    let frames: Vec<Icon> = (0..8).chain([0]).map(Icon::Frame).collect();
    assert_eq!(sink.icons, frames);
}

#[test]
fn tray_c33_reduce_motion_holds_frame_zero_and_no_timer() {
    let (mut d, mut sink, mut w) = (Driver::default(), Sink::default(), World::new());
    apply(&mut d, &mut sink, &mut w, 0, &exit10("reconnecting", Value::Null), true);
    d.tick(&mut sink);
    assert_eq!(sink.icons, vec![Icon::Frame(0)]);
    assert_eq!((sink.timers, sink.starts), (0, 0));
    assert!(!d.timer_running());
}

#[test]
fn tray_c34_leaving_reconnecting_stops_the_timer_and_sets_one_image() {
    let (mut d, mut sink, mut w) = (Driver::default(), Sink::default(), World::new());
    apply(&mut d, &mut sink, &mut w, 0, &exit10("reconnecting", Value::Null), false);
    d.tick(&mut sink);
    apply(&mut d, &mut sink, &mut w, 2_000, &connected(), false);
    assert_eq!((sink.timers, sink.stops), (0, 1));
    assert!(!d.timer_running());
    let connected_sets = sink.icons.iter().filter(|i| **i == Icon::State(TrayImage::Connected)).count();
    assert_eq!(connected_sets, 1);
    d.tick(&mut sink);
    apply(&mut d, &mut sink, &mut w, 4_000, &connected(), false);
    assert_eq!(sink.icons.last(), Some(&Icon::State(TrayImage::Connected)));
    assert_eq!(sink.icons.iter().filter(|i| **i == Icon::State(TrayImage::Connected)).count(), 1);
}

#[test]
fn tray_c35_identical_polls_build_the_menu_once() {
    let (mut d, mut sink, mut w) = (Driver::default(), Sink::default(), World::new());
    let status = exit10("reconnecting", Value::Null);
    for at in [0, 2_000, 4_000] {
        apply(&mut d, &mut sink, &mut w, at, &status, true);
    }
    assert_eq!((sink.menus, sink.snapshots), (1, 1));
    let changed = read(10, &with(body("reconnecting", Value::Null), |b| b["retryAt"] = json!(iso(T0 + 30_000))));
    apply(&mut d, &mut sink, &mut w, 6_000, &changed, true);
    assert_eq!((sink.menus, sink.snapshots), (2, 2));
}

#[test]
fn tray_c87_doctor_is_current_only_after_the_last_change_and_under_ten_minutes() {
    let lock = |started: i64| doctor(14, Some("lockdown"), T0 + started);
    let mut w = World::new();
    w.poll(0, &exit10("reconnecting", Value::Null), None);
    w.poll(1_000, &connected(), None); // status change at 1 s
    let before = lock(500);
    assert!(!w.tracker.is_current(&before, w.now));
    let m = w.view(&connected(), Some(&before));
    assert_eq!(m.title, "Connected");
    let snap = Snapshot::new(&m, &connected(), Some(&before), None);
    assert_eq!(snap.doctor.as_ref(), Some(&before), "Settings still gets the latest result");

    let after = lock(1_000);
    w.poll(1_000 + 599_000, &connected(), None);
    assert!(w.tracker.is_current(&after, w.now), "9 min 59 s old");
    assert_eq!(w.view(&connected(), Some(&after)).title, "Server allows too much");
    w.poll(1_000 + 600_000, &connected(), None);
    assert!(!w.tracker.is_current(&after, w.now), "10 minutes old");
    assert_eq!(w.view(&connected(), Some(&after)).title, "Connected");
}

#[test]
fn tray_c90_validity_table() {
    let blocked = |reason: &str| with(body("blocked", json!(reason)), |b| b["ok"] = json!(false));
    assert!(matches!(read(0, &body("connected", Value::Null)), StatusRead::Run(_)));
    assert!(matches!(read(10, &body("stopped", Value::Null)), StatusRead::Run(_)));
    assert!(matches!(read(11, &blocked("port_blocked")), StatusRead::Run(_)));
    assert!(matches!(read(13, &blocked("host_key_mismatch")), StatusRead::Run(_)));
    assert!(matches!(config_invalid(false), StatusRead::ConfigInvalid { .. }));

    let rejected = [
        read(0, &with(body("reconnecting", Value::Null), |b| b["ok"] = json!(true))),
        read(10, &with(body("connected", Value::Null), |b| b["ok"] = json!(false))),
        read(10, &body("paused", Value::Null)),
        read(0, &with(body("connected", Value::Null), |b| {
            b.as_object_mut().unwrap().remove("server");
        })),
        read(0, &with(body("connected", Value::Null), |b| b["pid"] = json!("4242"))),
        read(0, &with(body("connected", Value::Null), |b| b["domains"] = json!("5"))),
        read(0, &with(body("connected", Value::Null), |b| b["allowlist"] = json!("instagram.com"))),
        read(11, &blocked("host_key_mismatch")),
        read(2, &json!({ "ok": false, "command": "status", "configPath": "/c.json", "error": { "code": "internal", "message": "m" } })),
        read(2, &json!({ "ok": false, "command": "status", "error": { "code": "config_invalid", "message": "m" } })),
        read(14, &body("connected", Value::Null)),
    ];
    for (n, r) in rejected.iter().enumerate() {
        assert_eq!(r, &StatusRead::Unreadable, "case {n}");
    }
}

#[test]
fn tray_c84_settings_navigation_stays_on_the_app_origin() {
    let url = |s: &str| tauri::Url::parse(s).unwrap();
    assert!(!navigation_allowed(&url("https://example.com/")));
    assert!(!navigation_allowed(&url("file:///etc/hosts")));
    assert!(navigation_allowed(&url("tauri://localhost/index.html")));
    assert!(navigation_allowed(&url("http://tauri.localhost/")));
    let response = social_tunnel_app_lib::nav::new_window::<tauri::Wry>(url("https://example.com/"));
    assert!(matches!(response, tauri::webview::NewWindowResponse::Deny));
}
