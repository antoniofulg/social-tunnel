mod common;

use common::{body, has, out, read, World};
use serde_json::{json, Value};
use social_tunnel_app_lib::domains::{self, DomainCall, DomainState, EnrollmentToken, ErrorCode, DOMAINS_STDOUT, DOMAINS_TIMEOUT};
use social_tunnel_app_lib::sidecar::{self, CallOutput, ProcessRunner, Runner, SidecarCall};
use std::path::Path;
use std::time::Duration;
use tauri::Url;

const ID: &str = "1.7.0123456789abcdef0123456789abcdef";
const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn enrollment() -> EnrollmentToken { EnrollmentToken::parse(TOKEN).unwrap() }

fn reply(state: &str, active: Value, pending: Value) -> Value {
    json!({ "ok": true, "command": "domains", "state": state, "active": active, "pending": pending })
}

#[test]
fn domains_c12_fixed_cli_arguments_and_structured_response_cross_the_runner() {
    struct CheckArgs<'a>(&'a [&'a str]);
    impl Runner for CheckArgs<'_> {
        fn run(&self, program: &Path, args: &[String], timeout: Duration, max_stdout: usize) -> CallOutput {
            assert_eq!(program, Path::new("/bundle/social-tunnel"));
            assert_eq!(args, self.0);
            assert_eq!(timeout, DOMAINS_TIMEOUT);
            assert_eq!(max_stdout, DOMAINS_STDOUT);
            out(0, &reply("ready", json!({ "revision": 7, "domains": [] }), Value::Null))
        }
    }
    let edit = |operation| DomainCall::Edit(domains::edit_request(&json!({
        "scope": 1, "operation": operation, "host": "WWW.Example.com.", "expectedRevision": 7,
    })).unwrap());
    let cases: [(DomainCall, &[&str]); 4] = [
        (DomainCall::List, &["domains", "list", "--json", "--expected-enrollment", TOKEN]),
        (edit("add"), &["domains", "add", "WWW.Example.com.", "--expected-revision", "7", "--json", "--expected-enrollment", TOKEN]),
        (edit("remove"), &["domains", "remove", "WWW.Example.com.", "--expected-revision", "7", "--json", "--expected-enrollment", TOKEN]),
        (DomainCall::Retry(domains::retry_request(&json!({ "operationId": ID, "scope": 1 })).unwrap()), &["domains", "retry", ID, "--json", "--expected-enrollment", TOKEN]),
    ];
    for (call, expected) in cases {
        let actual = domains::run(&CheckArgs(expected), Path::new("/bundle/social-tunnel"), call, enrollment()).unwrap();
        assert_eq!(actual.state, DomainState::Ready);
        assert_eq!(actual.active.unwrap().domains, Vec::<String>::new());
    }
}

#[cfg(unix)]
#[test]
fn domains_c12_real_sidecar_process_receives_literal_token_and_closed_stdin() {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("st-domains-argv-{}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    let fixture = dir.join("sidecar");
    fs::write(&fixture, concat!("#!/bin/sh\n",
        "[ $# = 8 ] && [ \"$1\" = domains ] && [ \"$2\" = remove ] && ",
        "[ \"$3\" = WWW.Example.com. ] && [ \"$4\" = --expected-revision ] && [ \"$5\" = 7 ] && [ \"$6\" = --json ] && ",
        "[ \"$7\" = --expected-enrollment ] && [ \"$8\" = 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef ] || exit 91\n",
        "if read -r line; then exit 92; fi\n",
        "printf '%s\\n' '{\"ok\":true,\"command\":\"domains\",\"state\":\"setup_required\",\"active\":null,\"pending\":null}'\n"
    )).unwrap();
    fs::set_permissions(&fixture, fs::Permissions::from_mode(0o700)).unwrap();
    let edit = domains::edit_request(&json!({ "operation": "remove", "host": "WWW.Example.com.", "expectedRevision": 7, "scope": 1 })).unwrap();
    let response = domains::run(&ProcessRunner, &fixture, DomainCall::Edit(edit), enrollment());
    fs::remove_dir_all(dir).unwrap();
    assert_eq!(response.unwrap().state, DomainState::SetupRequired);
}

#[test]
fn domains_c12_ipc_rejects_unknown_payload_fields_and_non_settings_origins() {
    for bad in ["-flag.com", "/tmp/a", "https://site.org", "foo.org:443", "host.org;cmd", "127.0.0.1", "a\0b.org", "*.site.org"] {
        let payload = json!({ "operation": "add", "host": bad, "expectedRevision": 1, "scope": 1 });
        assert_eq!(domains::edit_request(&payload).unwrap_err().code, ErrorCode::InvalidDomain);
    }
    let mut edit = json!({ "operation": "add", "host": "example.com", "expectedRevision": 1, "scope": 1 });
    for key in ["configPath", "key", "executable", "arguments", "stdin", "expectedEnrollment"] {
        edit[key] = json!("anything");
        assert!(domains::edit_request(&edit).is_err());
        edit.as_object_mut().unwrap().remove(key);
    }
    edit["expectedRevision"] = json!(9_007_199_254_740_992u64);
    assert_eq!(domains::edit_request(&edit).unwrap_err().code, ErrorCode::InvalidRevision);
    edit["expectedRevision"] = json!(1);
    edit["operation"] = json!("authorize_recovery");
    assert!(domains::edit_request(&edit).is_err());
    for bad in [json!({ "operationId": "--help", "scope": 1 }), json!({ "operationId": ID, "scope": 1, "path": "/tmp/x" })] {
        assert_eq!(domains::retry_request(&bad).unwrap_err().code, ErrorCode::UnknownOperation);
    }
    assert!(domains::retry_request(&json!({ "operationId": ID })).is_err());
    assert!(domains::retry_request(&json!({ "operationId": ID, "scope": TOKEN })).is_err());
    let retry = DomainCall::Retry(domains::RetryRequest { operation_id: "--help".into(), scope: 1 });
    assert!(sidecar::argv(&SidecarCall::Domains(retry, enrollment()), None).is_err());
    for (label, url, allow) in [
        ("settings", "tauri://localhost/index.html#domains", true),
        ("settings", "http://tauri.localhost/index.html#domains", true),
        ("settings", "https://example.com/index.html#domains", false),
        ("settings", "tauri://localhost/other.html", false),
        ("settings", "file:///tmp/index.html", false),
        ("other", "tauri://localhost/index.html#domains", false),
    ] {
        assert_eq!(domains::settings_sender(label, &Url::parse(url).unwrap()), allow, "{label} {url}");
    }
}

#[test]
fn domains_c12_scope_binding_is_not_serialized_to_settings() {
    let mut raw = body("connected", Value::Null);
    raw["trayEnrollment"] = json!(TOKEN);
    let social_tunnel_app_lib::status::StatusRead::Run(status) = read(0, &raw) else { panic!("not status") };
    let visible = serde_json::to_value(&status).unwrap();
    assert!(!visible.as_object().unwrap().contains_key("trayEnrollment"));
    assert!(!visible.to_string().contains(TOKEN));
}

#[test]
fn domains_c12_reply_keeps_pending_and_typed_errors_and_fails_closed_on_bad_output() {
    let pending = json!({ "operationId": ID, "operation": "add", "host": "example.com", "phase": "unconfirmed", "pendingMayGoDirect": true });
    let accepted = reply("activation_unknown", Value::Null, pending);
    let actual = domains::read_reply(&out(0, &accepted)).unwrap();
    assert_eq!(actual.state, DomainState::ActivationUnknown);
    assert!(actual.active.is_none());
    assert_eq!(actual.pending.unwrap().operation_id, ID);
    let conflict = json!({ "ok": false, "command": "domains", "error": { "code": "conflict", "message": "SECRET /tmp/private" } });
    let error = domains::read_reply(&out(10, &conflict)).unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert!(!error.message.contains("SECRET"));
    let invalid = reply("applied", Value::Null, Value::Null);
    let mut oversized = out(0, &accepted);
    oversized.stdout.resize(DOMAINS_STDOUT + 1, b' ');
    let mut timed = out(0, &accepted);
    timed.timed_out = true;
    for bad in [out(0, &conflict), out(0, &invalid), oversized, timed] {
        assert_eq!(domains::read_reply(&bad).unwrap_err().code, ErrorCode::Unavailable);
    }
}

#[test]
fn domains_c12_native_summary_never_uses_legacy_count_for_managed_routing() {
    let mut raw = body("connected", Value::Null);
    let mut world = World::new();
    assert!(has(&world.poll(0, &read(0, &raw), None), "instagram.com"));
    for value in [json!({ "state": "activation_unknown", "active": null, "pending": null }), json!("malformed")] {
        raw["managedDomains"] = value;
        let model = world.poll(1, &read(0, &raw), None);
        assert!(has(&model, "Managed domain routing isn't verified."));
        assert!(!has(&model, "Through home") && !has(&model, "instagram.com"));
    }
    raw["managedDomains"] = json!({ "state": "ready", "active": { "revision": 4, "domains": [] }, "pending": null });
    assert!(has(&world.poll(2, &read(0, &raw), None), "No domains use the tunnel."));
    raw["managedDomains"]["active"]["domains"] = json!(["wipo.int"]);
    let ready = world.poll(3, &read(0, &raw), None);
    assert!(has(&ready, "Through home") && has(&ready, "wipo.int") && !has(&ready, "instagram.com"));
    raw["state"] = json!("disconnected");
    raw["ok"] = json!(false);
    let down = world.poll(4, &read(10, &raw), None);
    assert!(has(&down, "Managed domain routing isn't verified."));
    assert!(!has(&down, "3 domains paused. Nothing goes direct."));
}
