//! The only process the app starts: the bundled `social-tunnel` CLI, with argv from a typed allowlist
//! (plan door 5).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidecarCall {
    Status,
    TrayStatus,
    Doctor { domain: Option<String> },
    Run,
    Domains(crate::domains::DomainCall, crate::domains::EnrollmentToken),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArgvError {
    InvalidHost,
    InvalidConfigPath,
    InvalidRevision,
    InvalidOperation,
}

/// The CLI's hostname grammar (`src/host.ts`): lower-cased, one trailing dot dropped, at most 253
/// characters of `[a-z0-9-]{1,63}` labels. A leading `-` is refused so no host reads as a flag.
pub fn valid_host(host: &str) -> bool {
    if host.is_empty() || host.starts_with('-') {
        return false;
    }
    let lower = host.to_ascii_lowercase();
    let host = lower.strip_suffix('.').unwrap_or(&lower);
    host.len() <= 253
        && host.split('.').all(|label| {
            (1..=63).contains(&label.len())
                && label.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

fn valid_config_path(path: &str) -> bool {
    !path.starts_with('-') && !path.contains('\0') && Path::new(path).is_absolute()
}

/// Builds the argument vector, or refuses before any process exists.
pub fn argv(call: &SidecarCall, config: Option<&str>) -> Result<Vec<String>, ArgvError> {
    let mut args: Vec<String> = match call {
        SidecarCall::Status => vec!["status".into(), "--json".into()],
        SidecarCall::TrayStatus => vec!["status".into(), "--json".into(), "--tray-scope".into()],
        SidecarCall::Run => vec!["run".into(), "--json".into()],
        SidecarCall::Doctor { domain: None } => vec!["doctor".into(), "--json".into()],
        SidecarCall::Doctor { domain: Some(host) } => {
            if !valid_host(host) {
                return Err(ArgvError::InvalidHost);
            }
            vec!["doctor".into(), "--json".into(), "--domain".into(), host.clone()]
        }
        SidecarCall::Domains(domain, enrollment) => {
            use crate::domains::{self, DomainCall, EditOperation};
            let mut args = vec!["domains".into()];
            match domain {
                DomainCall::List => args.push("list".into()),
                DomainCall::Edit(edit) => {
                    if !domains::valid_host(&edit.host) { return Err(ArgvError::InvalidHost); }
                    if edit.expected_revision > domains::MAX_SAFE_REVISION { return Err(ArgvError::InvalidRevision); }
                    args.push(match edit.operation { EditOperation::Add => "add", EditOperation::Remove => "remove" }.into());
                    args.extend([edit.host.clone(), "--expected-revision".into(), edit.expected_revision.to_string()]);
                }
                DomainCall::Retry(retry) => {
                    if !domains::valid_operation(&retry.operation_id) { return Err(ArgvError::InvalidOperation); }
                    args.extend(["retry".into(), retry.operation_id.clone()]);
                }
            }
            args.extend(["--json".into(), "--expected-enrollment".into(), enrollment.as_str().into()]);
            args
        }
    };
    if let Some(path) = config {
        if !valid_config_path(path) {
            return Err(ArgvError::InvalidConfigPath);
        }
        args.push("--config".into());
        args.push(path.into());
    }
    Ok(args)
}

/// The sidecar sits next to the app executable (`Contents/MacOS/social-tunnel` in the bundle,
/// `target/<profile>/social-tunnel` under `tauri dev`). No `PATH` lookup.
pub fn sidecar_path(executable: &Path) -> PathBuf {
    executable.parent().unwrap_or(Path::new("/")).join("social-tunnel")
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CallOutput {
    /// None when the process ended by a signal or never started.
    pub exit: Option<i32>,
    pub stdout: Vec<u8>,
    pub timed_out: bool,
    /// stdout went past the limit; what was kept is cut.
    pub overflow: bool,
}

pub trait Runner {
    fn run(&self, program: &Path, args: &[String], timeout: Duration, max_stdout: usize) -> CallOutput;
}

/// Builds argv first; an argv error starts no process.
pub fn call(
    runner: &dyn Runner,
    program: &Path,
    call: &SidecarCall,
    config: Option<&str>,
    timeout: Duration,
    max_stdout: usize,
) -> Result<CallOutput, ArgvError> {
    let args = argv(call, config)?;
    Ok(runner.run(program, &args, timeout, max_stdout))
}

/// Runs a short-lived call (status, doctor): stdin closed, stderr discarded, stdout kept up to the
/// limit and drained past it, killed at the timeout.
pub struct ProcessRunner;

impl Runner for ProcessRunner {
    fn run(&self, program: &Path, args: &[String], timeout: Duration, max_stdout: usize) -> CallOutput {
        run_process(program, args, timeout, max_stdout, None)
    }
}

/// A `ProcessRunner` whose calls are also killed once `cancel` is set (Quit, criterion 46).
pub struct CancellableRunner(pub Arc<AtomicBool>);

impl Runner for CancellableRunner {
    fn run(&self, program: &Path, args: &[String], timeout: Duration, max_stdout: usize) -> CallOutput {
        if self.0.load(Ordering::SeqCst) {
            return CallOutput::default();
        }
        run_process(program, args, timeout, max_stdout, Some(&self.0))
    }
}

fn run_process(
    program: &Path,
    args: &[String],
    timeout: Duration,
    max_stdout: usize,
    cancel: Option<&AtomicBool>,
) -> CallOutput {
    let mut child = match Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return CallOutput::default(),
    };
    let mut pipe = child.stdout.take().expect("stdout is piped");
    let reader = std::thread::spawn(move || {
        let mut kept = Vec::new();
        let mut overflow = false;
        let mut buf = [0u8; 16 * 1024];
        while let Ok(n) = pipe.read(&mut buf) {
            if n == 0 {
                break;
            }
            let room = (max_stdout + 1).saturating_sub(kept.len());
            kept.extend_from_slice(&buf[..n.min(room)]);
            if kept.len() > max_stdout {
                overflow = true;
            }
        }
        (kept, overflow)
    });
    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() >= timeout || cancel.is_some_and(|c| c.load(Ordering::SeqCst)) => {
                timed_out = true;
                // Our own live child, through its handle.
                let _ = child.kill();
                break child.wait().ok();
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => {
                let _ = child.kill();
                break child.wait().ok();
            }
        }
    };
    while !reader.is_finished() {
        if started.elapsed() >= timeout || cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
            // The child is already reaped. Do not wait for a different process holding stdout.
            return CallOutput { timed_out: true, ..CallOutput::default() };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let (stdout, overflow) = reader.join().unwrap_or_default();
    CallOutput { exit: status.and_then(|s| s.code()), stdout, timed_out, overflow }
}
