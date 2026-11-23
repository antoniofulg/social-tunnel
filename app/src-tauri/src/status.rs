//! Reads one `status --json` call into what the tray may trust (plan criteria 13 and 90).

use crate::domains::{self, DomainView};
use crate::sidecar::CallOutput;
use serde::Serialize;
use serde_json::{Map, Value};

pub const STATUS_TIMEOUT_MS: u64 = 10_000;
pub const MAX_STDOUT: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub host: String,
    pub port: u64,
    pub user: Option<String>,
    pub host_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStatus {
    pub exit: i32,
    pub state: String,
    pub reason: Option<String>,
    pub pid: Option<u32>,
    pub retry_at: Option<String>,
    /// `retry_at` in ms since the epoch.
    #[serde(skip)]
    pub retry_at_ms: Option<i64>,
    pub server: Server,
    pub remote_port: u64,
    pub domains: u64,
    pub allowlist: Vec<String>,
    pub key_path: Option<String>,
    pub config_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub managed_domains: Option<DomainView>,
}

#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)] // one value per poll
pub enum StatusRead {
    Unreadable,
    /// Exit 2 `config_invalid`; `exists` says whether a file is at `config_path`.
    ConfigInvalid { config_path: String, exists: bool },
    Run(RunStatus),
}

/// Parses `YYYY-MM-DDTHH:MM:SS[.fff]Z` (what `Date.prototype.toISOString` prints) to ms since the epoch.
pub fn parse_iso_ms(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || *b.last()? != b'Z' {
        return None;
    }
    let num = |s: &str| -> Option<i64> { s.bytes().all(|c| c.is_ascii_digit()).then(|| s.parse().ok())? };
    let (y, mo, d) = (num(&text[0..4])?, num(&text[5..7])?, num(&text[8..10])?);
    let (h, mi, s) = (num(&text[11..13])?, num(&text[14..16])?, num(&text[17..19])?);
    let frac = &text[19..text.len() - 1];
    let ms = match frac {
        "" => 0,
        f if f.starts_with('.') && (2..=4).contains(&f.len()) => num(&f[1..])? * 10i64.pow(4 - f.len() as u32),
        _ => return None,
    };
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 60 {
        return None;
    }
    // Days from civil (Howard Hinnant).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + h) * 60 + mi) * 60_000 + s * 1000 + ms)
}

fn opt_string(o: &Map<String, Value>, key: &str) -> Option<Option<String>> {
    match o.get(key) {
        None | Some(Value::Null) => Some(None),
        Some(Value::String(s)) => Some(Some(s.clone())),
        _ => None,
    }
}

fn int(o: &Map<String, Value>, key: &str) -> Option<u64> {
    o.get(key)?.as_u64()
}

fn run_status(exit: i32, o: &Map<String, Value>) -> Option<RunStatus> {
    let state = o.get("state")?.as_str()?.to_string();
    let reason = opt_string(o, "reason")?;
    let ok = o.get("ok").and_then(Value::as_bool);
    let fits = match exit {
        0 => ok == Some(true) && state == "connected",
        10 => ok == Some(false) && ["connecting", "reconnecting", "disconnected", "stopped"].contains(&state.as_str()),
        11 => state == "blocked" && reason.as_deref() == Some("port_blocked"),
        13 => state == "blocked" && reason.as_deref() == Some("host_key_mismatch"),
        _ => false,
    };
    if !fits {
        return None;
    }
    let pid = match o.get("pid") {
        None | Some(Value::Null) => None,
        Some(v) => Some(u32::try_from(v.as_u64().filter(|&p| p > 0)?).ok()?),
    };
    let retry_at = opt_string(o, "retryAt")?;
    let retry_at_ms = match &retry_at {
        None => None,
        Some(t) => Some(parse_iso_ms(t)?),
    };
    let server = o.get("server")?.as_object()?;
    let allowlist = o
        .get("allowlist")?
        .as_array()?
        .iter()
        .map(|v| v.as_str().map(String::from))
        .collect::<Option<Vec<_>>>()?;
    Some(RunStatus {
        exit,
        state,
        reason,
        pid,
        retry_at,
        retry_at_ms,
        server: Server {
            host: server.get("host")?.as_str()?.to_string(),
            port: int(server, "port")?,
            user: opt_string(server, "user")?,
            host_key: opt_string(server, "hostKey")?,
        },
        remote_port: int(o, "remotePort")?,
        domains: int(o, "domains")?,
        allowlist,
        key_path: opt_string(o, "keyPath")?,
        config_path: opt_string(o, "configPath")?,
        managed_domains: o.get("managedDomains").map(|raw| {
            let view = domains::read_view(raw.clone()).unwrap_or_else(DomainView::unknown);
            if exit != 0 && view.active.is_some() { DomainView::unknown() } else { view }
        }),
    })
}

/// Accepts a result only when exit code and fields agree with criterion 90's table; everything
/// else, and a call that hung, overflowed or printed anything but one JSON object, is unreadable.
pub fn read_status(out: &CallOutput, exists: impl Fn(&str) -> bool) -> StatusRead {
    if out.timed_out || out.overflow || out.stdout.len() > MAX_STDOUT {
        return StatusRead::Unreadable;
    }
    let (Some(exit), Ok(Value::Object(o))) = (out.exit, serde_json::from_slice::<Value>(&out.stdout)) else {
        return StatusRead::Unreadable;
    };
    if exit == 2 {
        let code = o.get("error").and_then(Value::as_object).and_then(|e| e.get("code")).and_then(Value::as_str);
        return match (code, o.get("configPath").and_then(Value::as_str)) {
            (Some("config_invalid"), Some(path)) => {
                StatusRead::ConfigInvalid { config_path: path.to_string(), exists: exists(path) }
            }
            _ => StatusRead::Unreadable,
        };
    }
    run_status(exit, &o).map_or(StatusRead::Unreadable, StatusRead::Run)
}
