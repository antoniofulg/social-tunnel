//! Bind managed CLI work to native configuration observations and drain it on Quit.
use crate::domains::{DomainError, EnrollmentToken, ErrorCode, DOMAINS_TIMEOUT};
use std::fs::{self, Metadata};
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

#[cfg(unix)]
type Stamp = (u64, u64, i64, i64);
#[cfg(not(unix))]
type Stamp = (u64, std::time::SystemTime, std::time::SystemTime);

fn stamp(metadata: Metadata) -> io::Result<Stamp> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok((metadata.dev(), metadata.ino(), metadata.ctime(), metadata.ctime_nsec()))
    }
    #[cfg(not(unix))]
    Ok((metadata.len(), metadata.created()?, metadata.modified()?))
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct ConfigStamp {
    path: String,
    config: Option<Stamp>,
    enrollment: Option<Stamp>,
}

impl ConfigStamp {
    pub(crate) fn read(path: &str) -> io::Result<Self> {
        fn optional(metadata: io::Result<Metadata>) -> io::Result<Option<Stamp>> {
            match metadata {
                Ok(value) => stamp(value).map(Some),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
                Err(error) => Err(error),
            }
        }
        Ok(Self {
            path: path.into(),
            config: optional(fs::metadata(path))?,
            enrollment: optional(fs::symlink_metadata(format!("{path}.domains.json")))?,
        })
    }

    fn unchanged(&self) -> bool {
        Self::read(&self.path).is_ok_and(|now| now == *self)
    }
}

#[derive(Default)]
struct State {
    config: Option<ConfigStamp>,
    enrollment: Option<EnrollmentToken>,
    last_enrollment: Option<EnrollmentToken>,
    scope: u64,
    readable: bool,
    closed: bool,
    running: bool,
    waiting_list: bool,
}

impl State {
    fn permits(&self, scope: u64) -> bool {
        !self.closed && self.readable && self.scope == scope
    }

    fn authorize(&self, scope: u64) -> Result<(), DomainError> {
        if self.closed || !self.readable { return Err(unavailable()); }
        if self.scope != scope { return Err(ErrorCode::Conflict.error()); }
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct DomainCalls {
    state: Mutex<State>,
    changed: Condvar,
}

impl DomainCalls {
    pub(crate) fn observe(&self, config: Option<ConfigStamp>, enrollment: Option<EnrollmentToken>) {
        let mut state = self.state.lock().unwrap();
        state.readable = config.is_some();
        state.enrollment = enrollment;
        // Missing status is not evidence of another configuration.
        if let Some(config) = config {
            if state.config.as_ref() != Some(&config) ||
                (enrollment.is_some() && state.last_enrollment != enrollment)
            {
                state.scope += 1;
                state.config = Some(config);
                state.last_enrollment = enrollment;
            }
        }
        self.changed.notify_all();
    }

    pub(crate) fn scope(&self) -> u64 {
        self.state.lock().unwrap().scope
    }

    pub(crate) fn ticket(&self, displayed: u64) -> Result<u64, DomainError> {
        self.state.lock().unwrap().authorize(displayed)?;
        Ok(displayed)
    }

    pub(crate) fn run<T>(&self, scope: u64, list: bool, call: impl FnOnce(EnrollmentToken) -> Result<T, DomainError>) -> Result<T, DomainError> {
        let mut state = self.state.lock().unwrap();
        state.authorize(scope)?;
        if state.running || state.waiting_list {
            // One fresh window can wait for a previous window's call to finish. Edits never queue.
            if !list || state.waiting_list { return Err(ErrorCode::Conflict.error()); }
            state.waiting_list = true;
            let (next, timeout) = self.changed.wait_timeout_while(state, DOMAINS_TIMEOUT + Duration::from_millis(250),
                |state| state.running && state.permits(scope)).unwrap();
            state = next;
            state.waiting_list = false;
            if timeout.timed_out() { return Err(unavailable()); }
            state.authorize(scope)?;
        }
        let config = state.config.clone().ok_or_else(unavailable)?;
        let enrollment = state.enrollment.ok_or_else(unavailable)?;
        state.running = true;
        let _lease = Running(self);
        drop(state);
        if !config.unchanged() { return Err(ErrorCode::Conflict.error()); }
        let result = call(enrollment);
        // A response read under a retired identity may not populate a new window.
        if !config.unchanged() || self.scope() != scope { return Err(ErrorCode::Conflict.error()); }
        result
    }

    pub(crate) fn close(&self, cancel: &AtomicBool) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        cancel.store(true, Ordering::SeqCst);
        self.changed.notify_all();
    }

    pub(crate) fn drained(&self) -> bool {
        !self.state.lock().unwrap().running
    }
}

fn unavailable() -> DomainError { ErrorCode::Unavailable.error() }

struct Running<'a>(&'a DomainCalls);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().running = false;
        self.0.changed.notify_all();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::sidecar::{CancellableRunner, Runner};
    use std::path::PathBuf;
    use std::sync::{mpsc, Arc};
    use std::time::Instant;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("st-tray-domains-{name}-{}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn domains_c12_native_scope_advances_before_settings_receives_equal_revision() {
        use crate::domains::{edit_request, retry_request};
        use serde_json::json;

        let dir = Fixture::new("displayed");
        let path = dir.0.join("config.json");
        let config = || ConfigStamp::read(path.to_str().unwrap()).unwrap();
        let original = EnrollmentToken::parse(&"a".repeat(64));
        let replacement = EnrollmentToken::parse(&"b".repeat(64));
        let calls = DomainCalls::default();
        fs::write(&path, r#"{"revision":7,"enrollment":"A"}"#).unwrap();
        calls.observe(Some(config()), original);
        let displayed = calls.scope();
        let edit = edit_request(&json!({ "scope": displayed, "operation": "add", "host": "wipo.int", "expectedRevision": 7 })).unwrap();
        let retry = retry_request(&json!({ "scope": displayed, "operationId": "1.7.0123456789abcdef0123456789abcdef" })).unwrap();
        let admitted = calls.ticket(displayed).unwrap();

        let next = dir.0.join("next");
        fs::write(&next, r#"{"revision":7,"enrollment":"B"}"#).unwrap();
        fs::rename(next, &path).unwrap();
        calls.observe(Some(config()), replacement);
        assert_eq!(calls.ticket(edit.scope), Err(ErrorCode::Conflict.error()));
        assert_eq!(calls.ticket(retry.scope), Err(ErrorCode::Conflict.error()));
        assert_eq!(calls.run::<()>(admitted, false, |_| panic!("retired edit launched a child")), Err(ErrorCode::Conflict.error()));
        assert_ne!(calls.scope(), displayed);
        assert_eq!(calls.run(calls.scope(), true, |token| Ok(Some(token))), Ok(replacement));
    }

    #[test]
    fn domains_c12_config_replacement_retires_inflight_and_queued_identity() {
        let dir = Fixture::new("scope");
        let path = dir.0.join("config.json");
        let config = || ConfigStamp::read(path.to_str().unwrap()).unwrap();
        fs::write(&path, "{}").unwrap();
        let calls = DomainCalls::default();
        let enrollment = EnrollmentToken::parse(&"a".repeat(64));
        calls.observe(Some(config()), enrollment);
        let a = calls.scope();
        calls.observe(None, None);
        assert_eq!(calls.scope(), a);
        assert!(calls.ticket(a).is_err());
        calls.observe(Some(config()), None);
        assert_eq!(calls.scope(), a);
        assert!(calls.run::<()>(a, false, |_| panic!("missing CLI binding started a child")).is_err());
        calls.observe(Some(config()), enrollment);
        assert_eq!(calls.ticket(a), Ok(a));

        let replacement = dir.0.join("replacement");
        fs::write(&replacement, r#"{"different":"enrollment"}"#).unwrap();
        assert_eq!(calls.run(a, true, |_| {
            fs::rename(&replacement, &path).unwrap();
            Ok("old reply")
        }), Err(ErrorCode::Conflict.error()));
        assert_eq!(calls.run::<()>(a, false, |_| panic!("stale config started a child")), Err(ErrorCode::Conflict.error()));
        calls.observe(Some(config()), enrollment);
        let b = calls.scope();
        assert_ne!(b, a);
        assert_eq!(calls.run::<()>(a, true, |_| panic!("retired ticket started a child")), Err(ErrorCode::Conflict.error()));
        assert_eq!(calls.run(b, true, |_| Ok("new reply")), Ok("new reply"));

        fs::write(dir.0.join("config.json.domains.json"), "{}").unwrap();
        calls.observe(Some(config()), enrollment);
        assert_ne!(calls.scope(), b);
    }

    #[test]
    fn domains_c12_quit_rejects_admission_and_cancels_and_reaps_the_owned_child() {
        let dir = Fixture::new("quit");
        let marker = dir.0.join("owned.pid");
        let calls = DomainCalls::default();
        let cancel = Arc::new(AtomicBool::new(false));
        calls.observe(Some(ConfigStamp::read(dir.0.join("config.json").to_str().unwrap()).unwrap()),
            EnrollmentToken::parse(&"a".repeat(64)));
        let ticket = calls.ticket(calls.scope()).unwrap();
        std::thread::scope(|threads| {
            let (reaped, result) = mpsc::channel();
            let child_cancel = cancel.clone();
            let child_marker = marker.clone();
            let gate = &calls;
            let job = threads.spawn(move || gate.run(ticket, false, |_| {
                let runner = CancellableRunner(child_cancel);
                let args = ["-c".into(), "printf '%s\\n' \"$$\" > \"$1\"; exec /bin/sleep 30".into(),
                    "owned-fixture".into(), child_marker.to_str().unwrap().into()];
                reaped.send(runner.run(std::path::Path::new("/bin/sh"), &args, DOMAINS_TIMEOUT, 64)).unwrap();
                Ok(())
            }));
            let deadline = Instant::now() + Duration::from_secs(3);
            let pid = loop {
                if let Ok(text) = fs::read_to_string(&marker) {
                    if let Ok(pid) = text.trim().parse::<i32>() { break pid; }
                }
                assert!(Instant::now() < deadline, "child did not publish its PID");
                std::thread::sleep(Duration::from_millis(5));
            };
            assert!(pid > 1);
            assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
            assert!(!calls.drained());
            let started = Instant::now();
            calls.close(&cancel);
            assert_eq!(calls.ticket(ticket), Err(unavailable()));
            for list in [true, false] {
                assert_eq!(calls.run::<()>(ticket, list, |_| panic!("Quit admitted work")), Err(unavailable()));
            }
            let output = result.recv_timeout(Duration::from_secs(2)).unwrap();
            assert!(output.timed_out && output.exit.is_none());
            assert!(job.join().unwrap().is_ok());
            assert!(calls.drained());
            assert!(started.elapsed() < DOMAINS_TIMEOUT);
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
            assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
        });
    }
}
