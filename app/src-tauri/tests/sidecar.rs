mod common;

use common::*;
use serde_json::json;
use social_tunnel_app_lib::model::TrayImage;
use social_tunnel_app_lib::sidecar::{self, argv, sidecar_path, ArgvError, CallOutput, ProcessRunner, Runner, SidecarCall};
use social_tunnel_app_lib::status::{read_status, StatusRead, MAX_STDOUT, STATUS_TIMEOUT_MS};
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Recorder(RefCell<Vec<Vec<String>>>);

impl Runner for Recorder {
    fn run(&self, _program: &Path, args: &[String], _timeout: Duration, _max: usize) -> CallOutput {
        self.0.borrow_mut().push(args.to_vec());
        CallOutput::default()
    }
}

fn v(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

#[test]
fn tray_c6_legacy_argv_shapes_stay_unchanged() {
    let doctor_domain = SidecarCall::Doctor { domain: Some("instagram.com".into()) };
    let cases = [
        (SidecarCall::Status, v(&["status", "--json"])),
        (SidecarCall::Doctor { domain: None }, v(&["doctor", "--json"])),
        (doctor_domain, v(&["doctor", "--json", "--domain", "instagram.com"])),
        (SidecarCall::Run, v(&["run", "--json"])),
    ];
    for (call, expected) in cases {
        assert_eq!(argv(&call, None).unwrap(), expected);
        let mut with_config = expected.clone();
        with_config.extend(v(&["--config", "/abs/config.json"]));
        assert_eq!(argv(&call, Some("/abs/config.json")).unwrap(), with_config);
    }
}

#[test]
fn tray_c7_bad_hosts_and_config_paths_are_refused_and_start_nothing() {
    let runner = Recorder::default();
    let program = Path::new("/X/social-tunnel");
    for host in ["", "-x.com", "a\0b.com", "a b.com", "exa_mple.com"] {
        let call = SidecarCall::Doctor { domain: Some(host.into()) };
        assert_eq!(argv(&call, None), Err(ArgvError::InvalidHost), "{host:?}");
        let r = sidecar::call(&runner, program, &call, None, Duration::from_secs(1), 10);
        assert_eq!(r, Err(ArgvError::InvalidHost));
    }
    for path in ["config.json", "-c", "/a\0b"] {
        for call in [SidecarCall::Status, SidecarCall::Run, SidecarCall::Doctor { domain: None }] {
            assert_eq!(argv(&call, Some(path)), Err(ArgvError::InvalidConfigPath), "{path:?}");
            let r = sidecar::call(&runner, program, &call, Some(path), Duration::from_secs(1), 10);
            assert_eq!(r, Err(ArgvError::InvalidConfigPath));
        }
    }
    assert!(runner.0.borrow().is_empty(), "a refused argv started a process");
}

#[test]
fn tray_c8_sidecar_resolves_next_to_the_executable_not_on_path() {
    let exe = Path::new("/X/social-tunnel.app/Contents/MacOS/social-tunnel-app");
    let expected = PathBuf::from("/X/social-tunnel.app/Contents/MacOS/social-tunnel");
    assert_eq!(sidecar_path(exe), expected);
    let decoy = std::env::temp_dir().join(format!("tray-c8-{}", std::process::id()));
    std::fs::create_dir_all(&decoy).unwrap();
    std::fs::write(decoy.join("social-tunnel"), "#!/bin/sh\n").unwrap();
    std::env::set_var("PATH", format!("{}:{}", decoy.display(), std::env::var("PATH").unwrap_or_default()));
    assert_eq!(sidecar_path(exe), expected);
    std::fs::remove_dir_all(decoy).unwrap();
}

fn unreadable_shows_disconnected(read: StatusRead) {
    assert_eq!(read, StatusRead::Unreadable);
    let mut w = World::new();
    let m = w.poll(0, &read, None);
    assert_eq!(m.image, TrayImage::Disconnected);
    assert_eq!(m.title, "Disconnected");
    assert!(has(&m, "Can't read the tunnel status."));
}

#[test]
fn tray_c13_hung_garbled_oversized_or_rejected_status_reads_as_unreadable() {
    // A call that hangs is killed at the 10 s limit.
    assert_eq!(STATUS_TIMEOUT_MS, 10_000);
    let hang = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/hang.sh");
    let started = Instant::now();
    let out = ProcessRunner.run(&hang, &[], Duration::from_millis(STATUS_TIMEOUT_MS), MAX_STDOUT);
    let took = started.elapsed();
    assert!(out.timed_out && took >= Duration::from_secs(10) && took < Duration::from_secs(15), "{took:?}");
    unreadable_shows_disconnected(read_status(&out, |_| true));

    let raw = |bytes: Vec<u8>| CallOutput { exit: Some(0), stdout: bytes, timed_out: false, overflow: false };
    unreadable_shows_disconnected(read_status(&raw(b"not json".to_vec()), |_| true));
    let one = serde_json::to_string(&body("connected", serde_json::Value::Null)).unwrap();
    unreadable_shows_disconnected(read_status(&raw(format!("{one}\n{one}\n").into_bytes()), |_| true));
    let mut big = one.clone().into_bytes();
    big.resize(MAX_STDOUT + 1, b' ');
    unreadable_shows_disconnected(read_status(&raw(big), |_| true));
    let mut rejected = body("connected", serde_json::Value::Null);
    rejected["domains"] = json!("5");
    unreadable_shows_disconnected(read(0, &rejected));
}

#[test]
fn tray_c13_runner_caps_stdout_at_the_limit() {
    let out = ProcessRunner.run(
        Path::new("/bin/sh"),
        &v(&["-c", "head -c 2000 /dev/zero"]),
        Duration::from_secs(5),
        1000,
    );
    assert!(out.overflow);
    assert_eq!(out.stdout.len(), 1001);
    assert_eq!(read_status(&out, |_| true), StatusRead::Unreadable);
}
