//! Static policy over the shipped files (checks C5, C9, C31). Reads files, so it lives in tests/.

use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn capabilities() -> Vec<Value> {
    fs::read_dir(crate_dir().join("capabilities"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .map(|p| serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap())
        .collect()
}

const COMMANDS: [&str; 4] = ["get_snapshot", "run_check", "copy_fix", "set_open_at_login"];

fn names_in(text: &str, open: &str, close: char) -> BTreeSet<String> {
    let start = text.find(open).unwrap_or_else(|| panic!("{open} not found")) + open.len();
    let end = start + text[start..].find(close).unwrap();
    text[start..end]
        .split(',')
        .map(|s| s.trim().trim_matches('"').trim_matches('&').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

#[test]
fn tray_c5_webview_gets_core_events_and_four_commands_only() {
    let forbidden = ["shell:", "fs:", "http:", "opener:", "process:", "clipboard-manager:", "autostart:", "dialog:", "updater:"];
    let mut union = BTreeSet::new();
    for cap in capabilities() {
        for p in cap["permissions"].as_array().unwrap() {
            let id = p.as_str().map(String::from).unwrap_or_else(|| p["identifier"].as_str().unwrap().to_string());
            for prefix in forbidden {
                assert!(!id.starts_with(prefix), "forbidden permission {id}");
            }
            union.insert(id);
        }
    }
    let expected: BTreeSet<String> = [
        "core:event:allow-listen",
        "core:event:allow-unlisten",
        "allow-get-snapshot",
        "allow-run-check",
        "allow-copy-fix",
        "allow-set-open-at-login",
    ]
    .map(String::from)
    .into();
    assert_eq!(union, expected);

    let commands: BTreeSet<String> = COMMANDS.map(String::from).into();
    let build = fs::read_to_string(crate_dir().join("build.rs")).unwrap();
    assert!(build.contains("AppManifest::new().commands("));
    assert_eq!(names_in(&build, ".commands(&[", ']'), commands);
    let lib = fs::read_to_string(crate_dir().join("src/lib.rs")).unwrap();
    assert_eq!(lib.matches("generate_handler!").count(), 1);
    assert_eq!(names_in(&lib, "generate_handler![", ']'), commands);
}

#[test]
fn tray_c9_csp_global_tauri_frontend_and_no_remote_capability() {
    let conf: Value = serde_json::from_str(&fs::read_to_string(crate_dir().join("tauri.conf.json")).unwrap()).unwrap();
    assert_eq!(
        conf["app"]["security"]["csp"],
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    );
    assert_eq!(conf["app"]["withGlobalTauri"], Value::Bool(false));
    assert_eq!(conf["build"]["frontendDist"], "../dist");
    for cap in capabilities() {
        assert!(cap.get("remote").is_none(), "capability {} has a remote key", cap["identifier"]);
    }
}

fn pixels(path: &Path) -> (u32, u32, Vec<u8>) {
    let decoder = png::Decoder::new(fs::File::open(path).unwrap());
    let mut reader = decoder.read_info().unwrap();
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).unwrap();
    assert_eq!(info.color_type, png::ColorType::Rgba, "{}", path.display());
    buf.truncate(info.buffer_size());
    (info.width, info.height, buf)
}

#[test]
fn tray_c31_twelve_template_images_at_18_and_36_px_with_rgb_zero() {
    let dir = crate_dir().join("icons/tray");
    let mut names: Vec<String> = ["not-set-up", "connected", "disconnected", "blocked"].map(String::from).into();
    names.extend((0..8).map(|f| format!("reconnecting-{f}")));
    assert_eq!(names.len(), 12);
    for name in &names {
        for (file, size) in [(format!("{name}.png"), 18), (format!("{name}@2x.png"), 36)] {
            let (w, h, rgba) = pixels(&dir.join(&file));
            assert_eq!((w, h), (size, size), "{file}");
            assert!(rgba.chunks(4).all(|p| p[0] == 0 && p[1] == 0 && p[2] == 0), "{file} has a non-black pixel");
            assert!(rgba.chunks(4).any(|p| p[3] > 0), "{file} is empty");
        }
    }
    let pngs = fs::read_dir(&dir).unwrap().filter(|e| e.as_ref().unwrap().path().extension().is_some_and(|x| x == "png")).count();
    assert_eq!(pngs, 24);
    // Every image the tray sets is marked as a template.
    let lib = fs::read_to_string(crate_dir().join("src/lib.rs")).unwrap();
    assert_eq!(lib.matches("tray.set_icon(").count(), 1);
    let after = &lib[lib.find("tray.set_icon(").unwrap()..];
    assert!(after.lines().nth(1).unwrap().contains("set_icon_as_template(true)"));
    assert!(lib.contains(".icon_as_template(true)"));
    for name in &names {
        assert!(lib.contains(&format!("icons/tray/{name}@2x.png")), "{name} not wired");
    }
}
