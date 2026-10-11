use super::{types::*, Runtime};
use std::{
    io::Read,
    process::{Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};
const MAX_COMMAND_OUTPUT: usize = 1024 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
pub fn hide_command(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}
pub fn validate(rule: &Rule) -> Result<(), String> {
    if !matches!(
        rule.kind.as_str(),
        "reminder" | "interval" | "command" | "webhook"
    ) {
        return Err("Unknown rule kind".into());
    }
    if rule.title.trim().is_empty() || rule.title.len() > 300 {
        return Err("Give this rule a short title".into());
    }
    if !rule.interval_minutes.is_finite()
        || rule.interval_minutes < 0.0
        || rule.interval_minutes > 525600.0
    {
        return Err("Invalid rule interval".into());
    }
    if matches!(rule.kind.as_str(), "interval" | "command") && rule.interval_minutes < 0.1 {
        return Err("Repeated rules need an interval of at least six seconds".into());
    }
    if rule.kind == "command" && rule.command.trim().is_empty() {
        return Err("Choose a program for this command rule".into());
    }
    if rule.command.chars().any(|c| c == '\0') || rule.args.iter().any(|s| s.contains('\0')) {
        return Err("Invalid command argument".into());
    }
    if rule.args.len() > 100 || rule.args.iter().map(String::len).sum::<usize>() > 65536 {
        return Err("Command arguments exceed limit".into());
    }
    Ok(())
}
pub fn next_run(rule: &Rule, at: i64) -> Option<i64> {
    if rule.kind == "reminder" || rule.kind == "webhook" {
        None
    } else {
        Some(at.saturating_add((rule.interval_minutes * 60000.0).max(6000.0) as i64))
    }
}
pub fn start(runtime: &Arc<Runtime>) {
    let weak = Arc::downgrade(runtime);
    std::thread::spawn(move || {
        while let Some(runtime) = weak.upgrade() {
            if runtime.quitting.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            let now = now();
            let due: Vec<String> = runtime
                .ledger
                .lock()
                .map(|l| {
                    l.data
                        .rules
                        .iter()
                        .filter(|r| {
                            r.enabled
                                && r.kind != "webhook"
                                && r.next_run_at.is_some_and(|t| t <= now)
                        })
                        .map(|r| r.id.clone())
                        .collect()
                })
                .unwrap_or_default();
            for id in due {
                if let Err(error) = run(&runtime, &id, false) {
                    eprintln!("Relay rule error: {error}");
                }
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    });
}
pub fn run(runtime: &Arc<Runtime>, rule_id: &str, manual: bool) -> Result<(), String> {
    {
        let mut running = runtime
            .running_rules
            .lock()
            .map_err(|_| "Rules lock poisoned")?;
        if !running.insert(rule_id.into()) {
            return Err("This rule is already running".into());
        }
    }
    let result = (|| {
        let at = now();
        let rule = runtime
            .ledger
            .lock()
            .map_err(|_| "Ledger lock poisoned")?
            .change(|data| {
                let rule = data
                    .rules
                    .iter_mut()
                    .find(|r| r.id == rule_id)
                    .ok_or("Rule no longer exists")?;
                if !manual && (!rule.enabled || rule.next_run_at.is_none_or(|time| time > at)) {
                    return Err("Rule is no longer due".into());
                }
                let rule_copy = rule.clone();
                validate(&rule_copy)?;
                rule.last_run_at = Some(at);
                rule.last_error = None;
                rule.next_run_at = next_run(rule, at);
                if rule.kind == "reminder" {
                    rule.enabled = false;
                }
                if rule.kind != "command" {
                    super::ledger::add_notification(data, &notification_for(&rule_copy, at))?;
                }
                Ok(rule_copy)
            })?;
        runtime.emit_state();
        if rule.kind != "command" {
            runtime.native_notify(&rule.title, &rule.body);
            return Ok(false);
        }
        let runtime = runtime.clone();
        std::thread::spawn(move || {
            let result = execute(&runtime, &rule);
            if let Err(error) = result {
                let _ = runtime.ledger.lock().map(|mut l| {
                    l.change(|d| {
                        if let Some(r) = d.rules.iter_mut().find(|r| r.id == rule.id) {
                            r.last_error = Some(error.clone());
                        }
                        super::ledger::add_notification(
                            d,
                            &HookEvent {
                                event: "notification".into(),
                                session_id: rule.session_id.clone(),
                                title: Some(format!("{} failed", rule.title)),
                                body: Some(error.clone()),
                                source: Some(rule.source.clone()),
                                ..Default::default()
                            },
                        )?;
                        Ok(())
                    })
                });
            }
            if let Ok(mut running) = runtime.running_rules.lock() {
                running.remove(&rule.id);
            }
            runtime.emit_state();
        });
        Ok(true)
    })();
    if !matches!(result, Ok(true)) {
        if let Ok(mut running) = runtime.running_rules.lock() {
            running.remove(rule_id);
        }
    }
    result.map(|_| ())
}
fn notification_for(rule: &Rule, at: i64) -> HookEvent {
    HookEvent {
        event: "notification".into(),
        session_id: rule.session_id.clone(),
        title: Some(rule.title.clone()),
        body: Some(rule.body.clone()),
        source: Some(if rule.source.is_empty() {
            "rule".into()
        } else {
            rule.source.clone()
        }),
        dedupe_key: Some(format!("rule:{}:{at}", rule.id)),
        ..Default::default()
    }
}
fn kill_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        let mut kill = Command::new("taskkill");
        kill.args(["/PID", &child.id().to_string(), "/T", "/F"]);
        hide_command(&mut kill);
        let _ = kill.stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}
fn execute(runtime: &Arc<Runtime>, rule: &Rule) -> Result<(), String> {
    execute_limited(runtime, rule, COMMAND_TIMEOUT)
}
fn execute_limited(runtime: &Arc<Runtime>, rule: &Rule, timeout: Duration) -> Result<(), String> {
    let program = super::pty::resolve_program(&rule.command)?;
    #[cfg(windows)]
    if program
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
    {
        return Err("Choose an executable or interpreter, rather than a batch wrapper".into());
    }
    let mut command = Command::new(program);
    command
        .args(&rule.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_command(&mut command);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    if !rule.cwd.is_empty() {
        command.current_dir(&rule.cwd);
    }
    let connection = runtime
        .connection
        .lock()
        .map_err(|_| "Connection lock poisoned")?
        .clone();
    command
        .env("RELAY_ENDPOINT", connection.endpoint)
        .env("RELAY_TOKEN", connection.token);
    if let Some(session) = &rule.session_id {
        command.env("RELAY_SESSION_ID", session);
    } else {
        command.env_remove("RELAY_SESSION_ID");
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Cannot run rule: {e}"))?;
    let stdout = child.stdout.take().ok_or("No command output pipe")?;
    let (send, recv) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut output = Vec::new();
        let result = stdout
            .take((MAX_COMMAND_OUTPUT + 1) as u64)
            .read_to_end(&mut output)
            .map(|_| output);
        let _ = send.send(result);
    });
    let started = Instant::now();
    let mut received = None;
    let status = loop {
        if runtime.quitting.load(std::sync::atomic::Ordering::Relaxed)
            || started.elapsed() > timeout
        {
            kill_tree(&mut child);
            return Err("Command timed out or Relay is quitting".into());
        }
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status,
            None => std::thread::sleep(Duration::from_millis(50)),
        }
        if received.is_none() {
            if let Ok(result) = recv.try_recv() {
                match result {
                    Ok(output) if output.len() > MAX_COMMAND_OUTPUT => {
                        kill_tree(&mut child);
                        return Err("Command output exceeds 1 MiB".into());
                    }
                    Err(e) => {
                        kill_tree(&mut child);
                        return Err(e.to_string());
                    }
                    Ok(output) => received = Some(output),
                }
            }
        }
    };
    let output = if let Some(output) = received {
        output
    } else {
        recv.recv_timeout(Duration::from_secs(2))
            .map_err(|_| "Command left its output pipe open")?
            .map_err(|e| e.to_string())?
    };
    finish_output(runtime, rule, output, status.success())
}
fn finish_output(
    runtime: &Arc<Runtime>,
    rule: &Rule,
    output: Vec<u8>,
    success: bool,
) -> Result<(), String> {
    if !success {
        return Err("Command exited unsuccessfully".into());
    }
    if output.len() > MAX_COMMAND_OUTPUT {
        return Err("Command output exceeds 1 MiB".into());
    }
    let value: serde_json::Value = serde_json::from_slice(&output)
        .map_err(|e| format!("Command must return a JSON event or event array: {e}"))?;
    let values = if let Some(values) = value.as_array() {
        values.clone()
    } else {
        vec![value]
    };
    if values.len() > 100 {
        return Err("Command returned more than 100 events".into());
    }
    for value in values {
        let mut event: HookEvent = serde_json::from_value(value).map_err(|e| e.to_string())?;
        if event.event.is_empty() {
            event.event = "notification".into();
        }
        if event.source.is_none() {
            event.source = Some(rule.source.clone());
        }
        if event.session_id.is_none() {
            event.session_id = rule.session_id.clone();
        }
        runtime.apply_event(event)?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn rule() -> Rule {
        Rule {
            id: "rule1".into(),
            title: "Reminder".into(),
            source: "calendar".into(),
            kind: "interval".into(),
            enabled: true,
            interval_minutes: 10.0,
            next_run_at: Some(1),
            command: String::new(),
            args: vec![],
            cwd: String::new(),
            body: "Upcoming meeting".into(),
            session_id: None,
            last_run_at: None,
            last_error: None,
        }
    }
    #[test]
    fn missed_intervals_catch_up_once_without_replay_storm() {
        let r = rule();
        assert_eq!(next_run(&r, 10_000_000), Some(10_600_000));
        let mut one = r;
        one.kind = "reminder".into();
        assert_eq!(next_run(&one, 10_000_000), None);
    }
    #[test]
    fn commands_require_explicit_program_and_bounded_schedule() {
        let mut r = rule();
        r.kind = "command".into();
        assert!(validate(&r).is_err());
        r.command = "python".into();
        assert!(validate(&r).is_ok());
        r.interval_minutes = 0.0;
        assert!(validate(&r).is_err());
    }
    #[test]
    fn command_that_closes_stdout_still_has_a_timeout() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = Runtime::new(temp.path().into(), None).unwrap();
        let mut r = rule();
        #[cfg(windows)]
        {
            r.command = "powershell.exe".into();
            r.args = vec![
                "-NoProfile".into(),
                "-Command".into(),
                "[Console]::Out.Close(); Start-Sleep -Seconds 10".into(),
            ];
        }
        #[cfg(unix)]
        {
            r.command = "/bin/sh".into();
            r.args = vec!["-c".into(), "exec 1>&-; sleep 10".into()];
        }
        let started = Instant::now();
        let result = execute_limited(&runtime, &r, Duration::from_millis(250));
        assert!(result.unwrap_err().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
