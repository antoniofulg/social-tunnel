//! Open at Login against a fake login-item backend (plan criterion 78).

use social_tunnel_app_lib::login::{self, LoginItem};
use social_tunnel_app_lib::model::{self, Entry, Inputs, Tracker};
use social_tunnel_app_lib::status::StatusRead;
use std::cell::{Cell, RefCell};

#[derive(Default)]
struct FakeLogin {
    on: Cell<bool>,
    fail: bool,
    calls: RefCell<Vec<&'static str>>,
}

impl LoginItem for FakeLogin {
    fn enable(&self) -> Result<(), String> {
        self.calls.borrow_mut().push("enable");
        if self.fail {
            return Err("denied".into());
        }
        self.on.set(true);
        Ok(())
    }
    fn disable(&self) -> Result<(), String> {
        self.calls.borrow_mut().push("disable");
        self.on.set(false);
        Ok(())
    }
    fn is_enabled(&self) -> Result<bool, String> {
        Ok(self.on.get())
    }
}

fn checkmark(open_at_login: bool) -> bool {
    let model = model::view(
        &Tracker::default(),
        &Inputs {
            status: &StatusRead::Unreadable,
            doctor: None,
            child_pid: None,
            spawned_at: None,
            now: 0,
            checking: false,
            open_at_login,
        },
    );
    model.menu.iter().find_map(|entry| match entry {
        Entry::Check { id, checked, .. } if id == "open_at_login" => Some(*checked),
        _ => None,
    }).expect("the tray contains an Open at Login entry")
}

#[test]
fn tray_c78_switching_on_calls_enable_once_and_shows_the_read_back_state() {
    let item = FakeLogin::default();
    let enabled = login::set(&item, true).unwrap();
    assert_eq!(*item.calls.borrow(), ["enable"]);
    assert!(checkmark(enabled), "the checkmark shows the read-back state");
}

#[test]
fn tray_c78_a_failing_enable_stays_unchecked_and_returns_autostart_failed() {
    let item = FakeLogin { fail: true, ..Default::default() };
    assert_eq!(login::set(&item, true), Err("autostart_failed".to_string()));
    assert!(!checkmark(login::read(&item)));
}

#[test]
fn tray_c78_switching_off_calls_disable_and_shows_false() {
    let item = FakeLogin::default();
    item.on.set(true);
    let enabled = login::set(&item, false).unwrap();
    assert_eq!(*item.calls.borrow(), ["disable"]);
    assert!(!checkmark(enabled));
}

#[test]
fn tray_c78_the_login_label_is_not_the_users_launch_agent() {
    assert_ne!(login::LABEL, "tech.antoniofulg.social-tunnel");
    let lib = include_str!("../src/lib.rs");
    assert!(lib.contains(".plugin(login::plugin())"), "the app registers the login item with this label");
}

#[cfg(target_os = "macos")]
#[test]
fn tray_c78_enable_only_registers_the_canonical_installed_executable() {
    use std::fs::{create_dir_all, hard_link, remove_dir_all, remove_file, write};
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;
    use std::process::Command;

    let temp = Command::new("/usr/bin/mktemp")
        .arg("-d")
        .arg(std::env::temp_dir().join("tray-c78.XXXXXXXX"))
        .output()
        .unwrap();
    assert!(temp.status.success());
    let home = PathBuf::from(String::from_utf8(temp.stdout).unwrap().trim_end_matches('\n'));
    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            remove_dir_all(&self.0).unwrap();
        }
    }
    let scratch = Scratch(home);
    let home = scratch.0.as_path();
    let installed = home.join("Applications/social-tunnel.app/Contents/MacOS/social-tunnel-app");
    let build = home.join("build/social-tunnel.app/Contents/MacOS/social-tunnel-app");
    let dev = home.join("target/debug/social-tunnel-app");
    let copy = home.join("Desktop/social-tunnel.app/Contents/MacOS/social-tunnel-app");
    for executable in [&installed, &build, &dev, &copy] {
        create_dir_all(executable.parent().unwrap()).unwrap();
        write(executable, b"fixture").unwrap();
    }
    let alias = home.join("installed-alias");
    symlink(&installed, &alias).unwrap();
    let hard_alias = home.join("hard-alias");
    hard_link(&installed, &hard_alias).unwrap();
    let login = FakeLogin::default();
    for executable in [&installed, &alias] {
        assert_eq!(login::enable_installed(home, executable, || login.enable()), Ok(()));
    }
    for executable in [build.as_path(), &dev, &copy, &hard_alias, &home.join("missing")] {
        assert_eq!(
            login::enable_installed(home, executable, || login.enable()),
            Err("autostart_failed".into()),
        );
    }
    remove_file(&installed).unwrap();
    symlink(&build, &installed).unwrap();
    assert_eq!(
        login::enable_installed(home, &installed, || login.enable()),
        Err("autostart_failed".into()),
    );
    assert_eq!(*login.calls.borrow(), ["enable", "enable"]);
}
