//! Run the real macOS LaunchAgent backend in a subprocess with an isolated HOME (C78/C79).

#![cfg(target_os = "macos")]

use sha2::{Digest, Sha256};
use social_tunnel_app_lib::login;
use std::io::ErrorKind;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::Command;

const USER_PLIST: &str = "Library/LaunchAgents/tech.antoniofulg.social-tunnel.plist";
const TEST: &str = "tray_c79_login_agent_on_and_off_leaves_the_users_launch_agent_plist_unchanged";

fn sha(path: &Path) -> Option<[u8; 32]> {
    match std::fs::read(path) {
        Ok(bytes) => Some(Sha256::digest(bytes).into()),
        Err(e) if e.kind() == ErrorKind::NotFound => None,
        Err(e) => panic!("could not read user plist: {e}"),
    }
}

fn plist_value(path: &Path, key: &str) -> String {
    let output = Command::new("/usr/bin/plutil")
        .args(["-extract", key, "raw", "-o", "-"])
        .arg(path)
        .output()
        .unwrap();
    assert!(output.status.success(), "could not read plist field {key}");
    String::from_utf8(output.stdout).unwrap().trim_end_matches('\n').to_owned()
}

#[test]
fn tray_c79_login_agent_on_and_off_leaves_the_users_launch_agent_plist_unchanged() {
    let home = PathBuf::from(std::env::var_os("HOME").unwrap());
    let harness = std::env::current_exe().unwrap();
    let override_exe = std::env::var_os("SOCIAL_TUNNEL_APP_EXE");
    let exe = override_exe.as_ref().map(PathBuf::from).unwrap_or_else(|| harness.clone()).canonicalize().unwrap();
    if let Some(scratch) = std::env::var_os("SOCIAL_TUNNEL_C79_HOME") {
        // Refuse even a caller-supplied marker unless this is the disposable fixture.
        assert_eq!(home, PathBuf::from(scratch));
        assert!(home.file_name().unwrap().to_string_lossy().starts_with("tray-c79."));
        assert_eq!(home.parent().unwrap().canonicalize().unwrap(), std::env::temp_dir().canonicalize().unwrap());
        assert_eq!(std::fs::read(home.join(USER_PLIST)).unwrap(), b"external fixture");
        let real_plist = PathBuf::from(std::env::var_os("SOCIAL_TUNNEL_C79_REAL_PLIST").unwrap());
        let before = sha(&real_plist);
        let installed = home.join("Applications/Social Tunnel.app/Contents/MacOS/social-tunnel-app");
        std::fs::create_dir_all(installed.parent().unwrap()).unwrap();
        std::fs::copy(&exe, &installed).unwrap();
        let installed = installed.canonicalize().unwrap();
        let dev = home.join("target/debug/social-tunnel-app");
        let build = home.join("build/Social Tunnel.app/Contents/MacOS/social-tunnel-app");
        let copy = home.join("Desktop/Social Tunnel.app/Contents/MacOS/social-tunnel-app");
        for executable in [&dev, &build, &copy] {
            std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
            std::fs::hard_link(&installed, executable).unwrap();
        }
        let alias = home.join("launcher");
        symlink(&build, &alias).unwrap();
        let rejected = login::MacLogin::new(Some(&home), &alias);
        std::fs::remove_file(&alias).unwrap();
        symlink(&installed, &alias).unwrap();
        let plist = home.join("Library/LaunchAgents").join(format!("{}.plist", login::LABEL));
        assert_eq!(login::set(&rejected, true), Err("autostart_failed".into()));
        for candidate in [&dev, &build, &copy, &home.join("missing")] {
            let other = login::MacLogin::new(Some(&home), candidate);
            assert_eq!(login::set(&other, true), Err("autostart_failed".into()));
        }
        assert!(!plist.exists());

        let agent = login::MacLogin::new(Some(&home), &alias);
        std::fs::remove_file(&alias).unwrap();
        symlink(&build, &alias).unwrap();
        assert_eq!(login::set(&agent, true), Ok(true));
        assert_eq!(plist_value(&plist, "Label"), login::LABEL);
        assert_ne!(login::LABEL, "tech.antoniofulg.social-tunnel");
        assert_eq!(PathBuf::from(plist_value(&plist, "ProgramArguments.0")), installed);
        assert_eq!(std::fs::read(home.join(USER_PLIST)).unwrap(), b"external fixture");
        assert_eq!(sha(&real_plist), before, "user plist unchanged while on");
        std::fs::remove_file(&installed).unwrap();
        symlink(&build, &installed).unwrap();
        assert_eq!(login::set(&agent, true), Err("autostart_failed".into()));
        assert!(login::read(&agent), "failed enable preserves read-back");
        assert_eq!(PathBuf::from(plist_value(&plist, "ProgramArguments.0")), installed);
        assert_eq!(login::set(&rejected, false), Ok(false));
        assert!(!plist.exists() && !login::read(&agent));
        assert_eq!(std::fs::read(home.join(USER_PLIST)).unwrap(), b"external fixture");
        assert_eq!(sha(&real_plist), before, "user plist unchanged after off");
        return;
    }

    let real_plist = home.join(USER_PLIST);
    let before = sha(&real_plist);
    if override_exe.is_some() {
        assert_eq!(exe, home.join("Applications/Social Tunnel.app/Contents/MacOS/social-tunnel-app").canonicalize().unwrap());
        assert!(before.is_some(), "installed smoke needs the existing user plist");
    }
    let scratch = Command::new("/usr/bin/mktemp")
        .arg("-d")
        .arg(std::env::temp_dir().join("tray-c79.XXXXXXXX"))
        .output()
        .unwrap();
    assert!(scratch.status.success(), "could not create temporary HOME");
    let scratch = PathBuf::from(String::from_utf8(scratch.stdout).unwrap().trim_end_matches('\n'));
    let run = (|| -> std::io::Result<_> {
        let fixture = scratch.join(USER_PLIST);
        std::fs::create_dir_all(fixture.parent().unwrap())?;
        std::fs::write(fixture, b"external fixture")?;
        Command::new(harness)
            .args(["--exact", TEST, "--test-threads=1"])
            .env("HOME", &scratch)
            .env("SOCIAL_TUNNEL_C79_HOME", &scratch)
            .env("SOCIAL_TUNNEL_C79_REAL_PLIST", &real_plist)
            .env("SOCIAL_TUNNEL_APP_EXE", &exe)
            .output()
    })();
    std::fs::remove_dir_all(&scratch).unwrap();
    let result = run.unwrap();
    assert!(result.status.success(), "isolated login test failed: {}", String::from_utf8_lossy(&result.stdout));
    assert!(String::from_utf8_lossy(&result.stdout).contains("1 passed;"));
    assert_eq!(sha(&real_plist), before, "user plist unchanged after toggling");
}
