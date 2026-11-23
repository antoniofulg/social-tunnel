//! Bounded Settings-only adapter. The CLI is the sole domain and routing authority.

use crate::sidecar::{self, ArgvError, CallOutput, Runner, SidecarCall};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::time::Duration;
use tauri::Url;

pub const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;
pub const DOMAINS_TIMEOUT: Duration = Duration::from_secs(9);
pub const DOMAINS_STDOUT: usize = 64 * 1024;

/// Issued only by the bundled CLI status call; never deserialized from WebView IPC.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EnrollmentToken([u8; 64]);

impl EnrollmentToken {
    pub fn parse(value: &str) -> Option<Self> {
        let bytes: [u8; 64] = value.as_bytes().try_into().ok()?;
        bytes.iter().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b)).then_some(Self(bytes))
    }

    pub(crate) fn as_str(&self) -> &str {
        std::str::from_utf8(&self.0).expect("validated ASCII")
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EditOperation {
    Add,
    Remove,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditRequest {
    pub operation: EditOperation,
    pub host: String,
    pub expected_revision: u64,
    pub scope: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetryRequest {
    pub operation_id: String,
    pub scope: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DomainCall {
    List,
    Edit(EditRequest),
    Retry(RetryRequest),
}

pub(crate) fn displayed_scope(value: &Value) -> Result<u64, DomainError> {
    value["scope"].as_u64().filter(|&scope| (1..=MAX_SAFE_REVISION).contains(&scope))
        .ok_or_else(|| ErrorCode::Conflict.error())
}

pub fn edit_request(value: &Value) -> Result<EditRequest, DomainError> {
    let valid = value.as_object().is_some_and(|o| o.len() == 4 && o.contains_key("operation") &&
        o.contains_key("host") && o.contains_key("expectedRevision"));
    if !valid || !value["host"].as_str().is_some_and(valid_host) { return Err(ErrorCode::InvalidDomain.error()); }
    if !value["expectedRevision"].as_u64().is_some_and(|rev| rev <= MAX_SAFE_REVISION) {
        return Err(ErrorCode::InvalidRevision.error());
    }
    displayed_scope(value)?;
    EditRequest::deserialize(value).map_err(|_| ErrorCode::InvalidDomain.error())
}

pub fn retry_request(value: &Value) -> Result<RetryRequest, DomainError> {
    if !value.as_object().is_some_and(|o| o.len() == 2) ||
        !value["operationId"].as_str().is_some_and(valid_operation) {
        return Err(ErrorCode::UnknownOperation.error());
    }
    displayed_scope(value)?;
    RetryRequest::deserialize(value).map_err(|_| ErrorCode::UnknownOperation.error())
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DomainState {
    SetupRequired,
    Ready,
    Pending,
    ActivationUnknown,
    RecoveryRequired,
    Applied,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DomainRevision {
    pub revision: u64,
    pub domains: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PendingOperation {
    Add,
    Remove,
    Recovery,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DomainPhase {
    Claimed,
    Activating,
    Publishing,
    Published,
    Unconfirmed,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingDomain {
    pub operation_id: String,
    pub operation: PendingOperation,
    pub host: Option<String>,
    pub phase: DomainPhase,
    pub pending_may_go_direct: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_only: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DomainView {
    pub state: DomainState,
    pub active: Option<DomainRevision>,
    pub pending: Option<PendingDomain>,
    #[serde(default, rename = "queueBase", skip_serializing_if = "Option::is_none")]
    pub queue_base: Option<DomainRevision>,
    #[serde(default, rename = "completedOperationId", skip_serializing_if = "Option::is_none")]
    pub completed_operation_id: Option<String>,
}

impl DomainView {
    pub fn unknown() -> Self {
        Self { state: DomainState::ActivationUnknown, active: None, pending: None, queue_base: None, completed_operation_id: None }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidDomain,
    DuplicateDomain,
    DomainNotFound,
    InvalidRevision,
    UnknownOperation,
    OperationCancelled,
    Internal,
    NotReady,
    Conflict,
    Unavailable,
    RecoveryRequired,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct DomainError {
    pub code: ErrorCode,
    pub message: &'static str,
}

impl ErrorCode {
    pub fn error(self) -> DomainError {
        use ErrorCode::*;
        let message = match self {
            InvalidDomain => "Use a public DNS hostname without a scheme, port, path, or wildcard.",
            DuplicateDomain => "That hostname is already selected.",
            DomainNotFound => "That hostname is not a selected entry.",
            InvalidRevision => "An unsigned expected revision is required.",
            UnknownOperation => "The authority has no record of that operation.",
            OperationCancelled => "The authority cancelled that operation.",
            Internal => "Managed domains could not be read.",
            NotReady => "The managed tunnel and browser have not verified the same revision.",
            Conflict => "The managed revision changed or another operation is pending.",
            Unavailable => "The managed authority is unavailable.",
            RecoveryRequired => "The server administrator must reconcile this enrollment.",
        };
        DomainError { code: self, message }
    }

    const fn exit(self) -> i32 {
        use ErrorCode::*;
        match self {
            InvalidDomain | DuplicateDomain | DomainNotFound | InvalidRevision | UnknownOperation | OperationCancelled => 2,
            Internal => 1,
            NotReady | Conflict | Unavailable | RecoveryRequired => 10,
        }
    }
}

pub(crate) fn valid_host(host: &str) -> bool {
    let host = host.strip_suffix('.').unwrap_or(host);
    if host.len() > 253 || !host.contains('.') || host.rsplit('.').next().is_none_or(|last| last.bytes().all(|b| b.is_ascii_digit())) {
        return false;
    }
    host.split('.').all(|label| {
        (1..=63).contains(&label.len()) && !label.starts_with('-') && !label.ends_with('-') &&
            label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

pub(crate) fn valid_operation(id: &str) -> bool {
    if id.len() > 66 { return false; }
    let mut parts = id.split('.');
    let revision = |value: &str| {
        !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) &&
            value.parse::<u64>().is_ok_and(|n| n <= MAX_SAFE_REVISION)
    };
    parts.next().is_some_and(revision) && parts.next().is_some_and(revision) &&
        parts.next().is_some_and(|nonce| nonce.len() == 32 && nonce.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))) &&
        parts.next().is_none()
}

fn canonical(host: &str) -> bool {
    valid_host(host) && !host.ends_with('.') && !host.bytes().any(|b| b.is_ascii_uppercase())
}

pub fn read_view(raw: Value) -> Option<DomainView> {
    let o = raw.as_object()?;
    if !o.contains_key("active") || !o.contains_key("pending") { return None; }
    let view: DomainView = serde_json::from_value(raw).ok()?;
    if view.active.iter().chain(view.queue_base.iter()).any(|list| list.revision > MAX_SAFE_REVISION || list.domains.len() > 128 ||
        !list.domains.iter().all(|host| canonical(host)) || list.domains.windows(2).any(|d| d[0] >= d[1])) { return None; }
    if view.queue_base.is_some() && (view.state != DomainState::ActivationUnknown || view.active.is_some() || view.pending.is_some()) {
        return None;
    }
    if view.completed_operation_id.as_deref().is_some_and(|id| !valid_operation(id) ||
        view.state != DomainState::ActivationUnknown || view.active.is_some() || view.pending.is_some() ||
        view.queue_base.is_some()) { return None; }
    if let Some(pending) = &view.pending {
        if !valid_operation(&pending.operation_id) || pending.pending_may_go_direct != (pending.operation == PendingOperation::Add) ||
            pending.idle_only.is_some_and(|idle| !idle || pending.phase != DomainPhase::Claimed || pending.operation == PendingOperation::Recovery) ||
            match pending.operation {
                PendingOperation::Recovery => pending.host.is_some(),
                _ => !pending.host.as_deref().is_some_and(canonical),
            } { return None; }
    }
    match view.state {
        DomainState::Ready | DomainState::Applied if view.active.is_none() || view.pending.is_some() => None,
        DomainState::SetupRequired if view.active.is_some() || view.pending.is_some() => None,
        DomainState::RecoveryRequired | DomainState::ActivationUnknown if view.active.is_some() => None,
        _ => Some(view),
    }
}

pub fn read_reply(out: &CallOutput) -> Result<DomainView, DomainError> {
    let unavailable = || ErrorCode::Unavailable.error();
    if out.timed_out || out.overflow || out.stdout.len() > DOMAINS_STDOUT { return Err(unavailable()); }
    let (Some(exit), Ok(Value::Object(mut o))) = (out.exit, serde_json::from_slice::<Value>(&out.stdout)) else {
        return Err(unavailable());
    };
    if o.remove("command").and_then(|v| v.as_str().map(|cmd| cmd == "domains")) != Some(true) { return Err(unavailable()); }
    match o.remove("ok") {
        Some(Value::Bool(true)) if exit == 0 => read_view(Value::Object(o)).ok_or_else(unavailable),
        Some(Value::Bool(false)) if o.len() == 1 => {
            let parsed = o.remove("error").and_then(|v| serde_json::from_value::<WireError>(v).ok());
            Err(parsed.filter(|err| err.code.exit() == exit && err.message.len() <= 512)
                .map_or_else(unavailable, |err| err.code.error()))
        }
        _ => Err(unavailable()),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireError { code: ErrorCode, message: String }

pub fn settings_sender(label: &str, url: &Url) -> bool {
    label == crate::settings::LABEL && crate::nav::navigation_allowed(url) && url.username().is_empty() && url.password().is_none() &&
        matches!(url.path(), "/" | "/index.html")
}

pub fn run(runner: &dyn Runner, program: &Path, command: DomainCall, enrollment: EnrollmentToken) -> Result<DomainView, DomainError> {
    let out = sidecar::call(runner, program, &SidecarCall::Domains(command, enrollment), None, DOMAINS_TIMEOUT, DOMAINS_STDOUT).map_err(|e| match e {
        ArgvError::InvalidHost => ErrorCode::InvalidDomain,
        ArgvError::InvalidRevision => ErrorCode::InvalidRevision,
        ArgvError::InvalidOperation => ErrorCode::UnknownOperation,
        ArgvError::InvalidConfigPath => ErrorCode::Internal,
    }.error())?;
    read_reply(&out)
}
