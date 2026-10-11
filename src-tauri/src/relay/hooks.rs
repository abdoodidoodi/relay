use super::{types::*, Runtime};
use serde_json::Value;
use std::{
    io::Read,
    path::Path,
    sync::{Arc, Weak},
    time::Duration,
};

pub const MAX_BODY: usize = 256 * 1024;
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct ConnectionInfo {
    pub endpoint: String,
    pub token: String,
}

pub fn private_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
        // User-specific app-data alone is insufficient on machines with broad ACLs.
        // Lock token and generated hook files to the signed-in account and SYSTEM.
        let name =
            std::env::var("USERNAME").map_err(|_| "Cannot determine local account".to_string())?;
        let domain = std::env::var("USERDOMAIN").unwrap_or_default();
        let account = if domain.is_empty() {
            name
        } else {
            format!("{domain}\\{name}")
        };
        let mut cmd = std::process::Command::new("icacls");
        cmd.arg(path).args([
            "/inheritance:r",
            "/grant:r",
            &format!("{account}:(F)"),
            "*S-1-5-18:(F)",
            "/Q",
        ]);
        super::rules::hide_command(&mut cmd);
        let status = cmd
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("Cannot protect Relay's private connection file".into());
        }
    }
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}
pub fn start(runtime: &Arc<Runtime>) -> Result<(), String> {
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let address = server.server_addr().to_ip().ok_or("No loopback address")?;
    let endpoint = format!("http://{address}/events");
    *runtime
        .connection
        .lock()
        .map_err(|_| "Connection lock poisoned")? = ConnectionInfo {
        endpoint,
        token: runtime.token.clone(),
    };
    private_write(
        &runtime.data_dir.join("connection.json"),
        &serde_json::to_vec(
            &*runtime
                .connection
                .lock()
                .map_err(|_| "Connection lock poisoned")?,
        )
        .map_err(|e| e.to_string())?,
    )?;
    let weak = Arc::downgrade(runtime);
    std::thread::Builder::new()
        .name("relay-events".into())
        .spawn(move || {
            while let Some(runtime) = weak.upgrade() {
                if runtime.quitting.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }
                match server.recv_timeout(Duration::from_millis(500)) {
                    Ok(Some(request)) => handle_request(request, &weak, address.port()),
                    Ok(None) => {}
                    Err(e) => {
                        eprintln!("Relay hook listener stopped: {e}");
                        break;
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn valid_request(host: &str, origin: Option<&str>, auth: &str, token: &str, port: u16) -> bool {
    let expected = format!("127.0.0.1:{port}");
    if host != expected && host != format!("localhost:{port}") {
        return false;
    }
    if let Some(origin) = origin {
        if origin != format!("http://{expected}") && origin != format!("http://localhost:{port}") {
            return false;
        }
    }
    let supplied = auth.strip_prefix("Bearer ").unwrap_or_default().as_bytes();
    let wanted = token.as_bytes();
    if supplied.len() != wanted.len() {
        return false;
    }
    supplied
        .iter()
        .zip(wanted)
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}
fn handle_request(mut request: tiny_http::Request, weak: &Weak<Runtime>, port: u16) {
    let Some(runtime) = weak.upgrade() else {
        return;
    };
    let header = |name: &'static str| {
        request
            .headers()
            .iter()
            .find(|h| h.field.equiv(name))
            .map(|h| h.value.as_str())
    };
    let authorized = valid_request(
        header("Host").unwrap_or_default(),
        header("Origin"),
        header("Authorization").unwrap_or_default(),
        &runtime.token,
        port,
    );
    let result = if !authorized {
        Err((403, "Unauthorized local event".into()))
    } else if request.method() != &tiny_http::Method::Post || request.url() != "/events" {
        Err((404, "Use POST /events".into()))
    } else if request.body_length().is_none() || request.body_length().unwrap_or(0) > MAX_BODY {
        Err((
            413,
            "Event body exceeds limit or has no Content-Length".into(),
        ))
    } else {
        let mut body = Vec::new();
        match request
            .as_reader()
            .take((MAX_BODY + 1) as u64)
            .read_to_end(&mut body)
        {
            Ok(_) if body.len() <= MAX_BODY => match serde_json::from_slice::<HookEvent>(&body) {
                Ok(event) => runtime.apply_event(event).map(|_| ()).map_err(|e| (400, e)),
                Err(e) => Err((400, e.to_string())),
            },
            Ok(_) => Err((413, "Event body exceeds limit".into())),
            Err(e) => Err((400, e.to_string())),
        }
    };
    let (status, body) = match result {
        Ok(()) => (200, serde_json::json!({"ok":true}).to_string()),
        Err((status, error)) => (status, serde_json::json!({"error":error}).to_string()),
    };
    let _ = request.respond(
        tiny_http::Response::from_string(body)
            .with_status_code(status)
            .with_header(
                tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap(),
            ),
    );
}

pub fn map_payload(event: &str, payload: &Value, session_id: Option<String>) -> HookEvent {
    let get = |key: &str| payload.get(key).and_then(Value::as_str).map(str::to_owned);
    let provider_session_id = get("session_id").or_else(|| get("thread-id")).or_else(|| {
        payload
            .pointer("/session/id")
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    let model = payload
        .pointer("/model/id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| get("model"))
        .or_else(|| get("to_model"));
    let effort = payload
        .pointer("/effort/level")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| get("effort"))
        .or_else(|| get("reasoning_effort"));
    let title = get("session_name").or_else(|| get("title"));
    let body = get("last-assistant-message")
        .or_else(|| get("last_assistant_message"))
        .or_else(|| get("message"));
    let is_codex = payload.get("thread-id").is_some();
    let mut hook = HookEvent {
        event: event.into(),
        session_id,
        provider_session_id,
        model,
        effort,
        title,
        body,
        prompt: get("prompt").or_else(|| get("user_prompt")),
        source: Some(if is_codex { "codex" } else { "claude" }.into()),
        transcript_path: get("transcript_path"),
        ..Default::default()
    };
    if event == "ready" {
        if let (Some(thread), Some(turn)) = (&hook.provider_session_id, get("turn-id")) {
            hook.dedupe_key = Some(format!("codex:{thread}:{turn}:ready"));
        } else if let Some(path) = &hook.transcript_path {
            if let Ok(meta) = std::fs::metadata(path) {
                hook.dedupe_key = Some(format!(
                    "claude:{}:{}:ready",
                    hook.provider_session_id.as_deref().unwrap_or_default(),
                    meta.len()
                ));
            }
        }
    }
    hook
}
pub fn local_endpoint(endpoint: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(endpoint) else {
        return false;
    };
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some()
        && url.path() == "/events"
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
}
pub fn run_cli_mode() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("--relay-hook") {
        return false;
    }
    let mode = args.get(2).map(String::as_str).unwrap_or("notification");
    let event = if mode == "statusline" {
        "settings"
    } else {
        mode
    };
    let mut endpoint = std::env::var("RELAY_ENDPOINT").unwrap_or_default();
    let mut token = std::env::var("RELAY_TOKEN").unwrap_or_default();
    let mut session_id = std::env::var("RELAY_SESSION_ID").ok();
    let mut cursor = 3;
    while let Some(flag) = args.get(cursor) {
        match flag.as_str() {
            "--connection-file" => {
                if let Some(path) = args.get(cursor + 1) {
                    if let Ok(file) = std::fs::read(path) {
                        if let Ok(connection) = serde_json::from_slice::<ConnectionInfo>(&file) {
                            endpoint = connection.endpoint;
                            token = connection.token;
                        }
                    }
                }
                cursor += 2;
            }
            "--session-id" => {
                session_id = args.get(cursor + 1).cloned();
                cursor += 2;
            }
            _ => break,
        }
    }
    let raw = if let Some(json) = args.get(cursor) {
        json.clone()
    } else {
        let mut raw = String::new();
        let _ = std::io::stdin()
            .take(MAX_BODY as u64)
            .read_to_string(&mut raw);
        raw
    };
    let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let hook = map_payload(event, &payload, session_id);
    if mode == "statusline" {
        // Claude statusLine consumes stdout; preserve a useful compact status line.
        println!(
            "{}{}",
            hook.model.as_deref().unwrap_or("Claude"),
            hook.effort
                .as_deref()
                .map(|e| format!(" · {e}"))
                .unwrap_or_default()
        );
    }
    if !local_endpoint(&endpoint) || token.is_empty() {
        return true;
    }
    let result = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3))
        .build()
        .and_then(|client| client.post(endpoint).bearer_auth(token).json(&hook).send());
    if let Err(error) = result {
        eprintln!("Relay hook delivery failed: {error}");
    }
    true
}

pub fn hook_command(binary: &Path, event: &str) -> String {
    // Claude command hooks execute through a platform shell. Keep only the
    // executable path in shell syntax; event names are fixed application constants.
    let path = binary.to_string_lossy();
    #[cfg(windows)]
    {
        format!("\"{}\" --relay-hook {event}", path.replace('"', ""))
    }
    #[cfg(not(windows))]
    {
        format!("'{}' --relay-hook {event}", path.replace('\'', "'\\''"))
    }
}
pub fn claude_settings(binary: &Path) -> Value {
    let mut hooks = serde_json::Map::new();
    for (provider, event) in [
        ("SessionStart", "session_start"),
        ("UserPromptSubmit", "prompt"),
        ("PreToolUse", "working"),
        ("Stop", "ready"),
        ("Notification", "notification"),
        ("PostModelSwitch", "settings"),
    ] {
        hooks.insert(provider.into(),serde_json::json!([{"matcher":"","hooks":[{"type":"command","command":hook_command(binary,event),"timeout":5}]}]));
    }
    serde_json::json!({"hooks":hooks,"statusLine":{"type":"command","command":hook_command(binary,"statusline")}})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn auth_blocks_cross_site_and_remote_destinations() {
        assert!(valid_request(
            "127.0.0.1:4567",
            None,
            "Bearer abc",
            "abc",
            4567
        ));
        assert!(!valid_request(
            "127.0.0.1:4567",
            Some("https://evil.example"),
            "Bearer abc",
            "abc",
            4567
        ));
        assert!(!valid_request(
            "evil.example:4567",
            None,
            "Bearer abc",
            "abc",
            4567
        ));
        assert!(!valid_request(
            "127.0.0.1:4567",
            None,
            "Bearer abd",
            "abc",
            4567
        ));
        assert!(local_endpoint("http://127.0.0.1:4567/events"));
        assert!(!local_endpoint("https://example.com/events"));
    }
    #[test]
    fn provider_events_preserve_full_identity_and_live_settings() {
        let e = map_payload(
            "ready",
            &serde_json::json!({"thread-id":"opaque-full-id","turn-id":"t1","last-assistant-message":"Done"}),
            Some("tab1".into()),
        );
        assert_eq!(e.provider_session_id.as_deref(), Some("opaque-full-id"));
        assert_eq!(
            e.dedupe_key.as_deref(),
            Some("codex:opaque-full-id:t1:ready")
        );
        let e = map_payload(
            "settings",
            &serde_json::json!({"session_id":"sid","session_name":"New title","model":{"id":"opus-live"},"effort":{"level":"max"}}),
            None,
        );
        assert_eq!(e.model.as_deref(), Some("opus-live"));
        assert_eq!(e.effort.as_deref(), Some("max"));
        assert_eq!(e.title.as_deref(), Some("New title"));
    }
}
