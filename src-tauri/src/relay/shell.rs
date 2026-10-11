//! Per-process shell integration. No global shell profile or provider configuration is edited.
use super::{hooks, ledger, pty, types::*, Runtime};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareRequest {
    pub session_id: String,
    pub provider: String,
    pub cwd: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub provider_home: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub executable: String,
    pub args: Vec<String>,
    pub windows_arguments: String,
    pub cwd: String,
}
pub fn new_terminal(data: &mut LedgerData, group: &str) -> Result<String, String> {
    if !data.groups.iter().any(|g| g.id == group) {
        return Err("Group does not exist".into());
    }
    if !Path::new(&data.settings.default_cwd).is_dir() {
        return Err("Working folder no longer exists; update it in Settings".into());
    }
    let sid = id();
    data.sessions.push(Session {
        id: sid.clone(),
        group_id: group.into(),
        title: "Terminal".into(),
        title_locked: false,
        provider: "shell".into(),
        cwd: data.settings.default_cwd.clone(),
        shell_cwd: data.settings.default_cwd.clone(),
        model: String::new(),
        effort: String::new(),
        executable: data.settings.shell_executable.clone(),
        args: vec![],
        provider_session_id: None,
        status: "stopped".into(),
        unread: false,
        archived: false,
        created_at: now(),
        updated_at: now(),
        last_activity_at: now(),
        error: None,
        initial_prompt: String::new(),
        kind: "work".into(),
        shell_integrated: true,
    });
    data.active_session_id = Some(sid.clone());
    Ok(sid)
}
fn flag_value(args: &[String], names: &[&str]) -> Option<String> {
    for (i, arg) in args.iter().enumerate() {
        if arg == "--" {
            break;
        }
        if names.contains(&arg.as_str()) {
            return args.get(i + 1).filter(|v| !v.starts_with('-')).cloned();
        }
        for name in names {
            if let Some(value) = arg.strip_prefix(&format!("{name}=")) {
                return Some(value.into());
            }
        }
    }
    None
}
fn has_flag(args: &[String], names: &[&str]) -> bool {
    args.iter()
        .take_while(|a| a.as_str() != "--")
        .any(|a| names.contains(&a.split('=').next().unwrap_or(a)))
}
// Keep repeatable launch options, excluding identity, provider hooks and the initial prompt.
// Unknown options are retained as flags; documented value-taking options retain their values.
pub fn recovery_options(args: &[String], provider: &str) -> Vec<String> {
    let managed = [
        "--resume",
        "-r",
        "--session-id",
        "--model",
        "-m",
        "--effort",
        "--settings",
    ];
    let valued = [
        "-c",
        "--config",
        "--profile",
        "--sandbox",
        "--ask-for-approval",
        "-a",
        "--permission-mode",
        "--allowedTools",
        "--allowed-tools",
        "--disallowedTools",
        "--disallowed-tools",
        "--tools",
        "--system-prompt",
        "--append-system-prompt",
        "--mcp-config",
        "--add-dir",
        "--agent",
        "--agents",
        "--debug-file",
        "--output-format",
        "--input-format",
        "--max-turns",
        "--max-budget-usd",
    ];
    let mut result = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        let key = arg.split('=').next().unwrap_or(arg);
        if arg == "--" {
            break;
        }
        if provider == "claude" && key == "-c" {
        } else if managed.contains(&key) {
            if !arg.contains('=') && args.get(i + 1).is_some_and(|a| !a.starts_with('-')) {
                i += 1;
            }
        } else if matches!(key, "--continue" | "--last" | "--fork-session") {
        } else if provider == "codex" && matches!(key, "resume" | "fork") {
            if args.get(i + 1).is_some_and(|a| !a.starts_with('-')) {
                i += 1;
            }
        } else if key.starts_with('-') {
            if matches!(key, "-c" | "--config")
                && !arg.contains('=')
                && args.get(i + 1).is_some_and(|a| {
                    a.starts_with("notify=")
                        || a.starts_with("model_reasoning_effort=")
                        || a.starts_with("model=")
                })
            {
                i += 1;
            } else {
                result.push(arg.clone());
                if valued.contains(&key) && !arg.contains('=') {
                    if let Some(value) = args.get(i + 1) {
                        result.push(value.clone());
                        i += 1;
                    }
                }
            }
        } else {
            break;
        }
        i += 1;
    }
    result
}
fn insert_options(args: &mut Vec<String>, options: Vec<String>) {
    let at = args.iter().position(|a| a == "--").unwrap_or(args.len());
    args.splice(at..at, options);
}
fn windows_quote(arg: &str) -> String {
    let mut out = String::from("\"");
    let mut slashes = 0;
    for ch in arg.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        if ch == '"' {
            out.push_str(&"\\".repeat(slashes * 2 + 1));
            out.push('"');
        } else {
            out.push_str(&"\\".repeat(slashes));
            out.push(ch);
        }
        slashes = 0;
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}
fn prepared(program: &str, args: Vec<String>, cwd: &str) -> Result<Prepared, String> {
    let (exe, args) = pty::resolve_command(program, args)?;
    Ok(Prepared {
        executable: exe.to_string_lossy().into(),
        windows_arguments: args
            .iter()
            .map(|a| windows_quote(a))
            .collect::<Vec<_>>()
            .join(" "),
        args,
        cwd: cwd.into(),
    })
}
fn merge_settings(target: &mut serde_json::Value, extra: serde_json::Value) {
    match (target, extra) {
        (serde_json::Value::Object(target), serde_json::Value::Object(extra)) => {
            for (key, value) in extra {
                if let Some(old) = target.get_mut(&key) {
                    merge_settings(old, value);
                } else {
                    target.insert(key, value);
                }
            }
        }
        (serde_json::Value::Array(target), serde_json::Value::Array(extra)) => target.extend(extra),
        (target, extra) => *target = extra,
    }
}
impl Runtime {
    pub fn prepare_provider(&self, request: PrepareRequest) -> Result<Prepared, String> {
        if !matches!(request.provider.as_str(), "claude" | "codex") {
            return Err("Unknown shell provider".into());
        }
        if request.args.len() > 256
            || request
                .args
                .iter()
                .any(|a| a.len() > 200000 || a.contains('\0'))
            || !Path::new(&request.cwd).is_dir()
        {
            return Err("Invalid provider launch arguments or folder".into());
        }
        let session = self.session(&request.session_id)?;
        if !session.shell_integrated || session.archived {
            return Err("Provider preparation requires an integrated terminal".into());
        }
        let mut args = request.args.clone();
        let binary = std::env::current_exe().map_err(|e| e.to_string())?;
        let path = self
            .data_dir
            .join("hooks")
            .join(format!("{}.json", session.id));
        let program = pty::default_executable(&request.provider);
        if has_flag(&args, &["--help", "-h", "--version", "-v"])
            || args.first().is_some_and(|a| {
                matches!(
                    a.as_str(),
                    "update"
                        | "config"
                        | "doctor"
                        | "install"
                        | "setup-token"
                        | "plugin"
                        | "plugins"
                        | "login"
                        | "logout"
                        | "auth"
                        | "mcp"
                        | "features"
                        | "completion"
                        | "app-server"
                        | "exec"
                        | "review"
                )
            })
        {
            return prepared(&program, args, &request.cwd);
        }
        let resume_requested = has_flag(&args, &["--resume", "-r", "--continue", "--last"])
            || (request.provider == "claude" && has_flag(&args, &["-c"]))
            || (request.provider == "codex" && args.iter().any(|a| a == "resume" || a == "fork"));
        let mut provider_id = flag_value(&args, &["--session-id", "--resume", "-r"]);
        if request.provider == "codex" {
            provider_id = args
                .iter()
                .position(|a| a == "resume" || a == "fork")
                .and_then(|i| args.get(i + 1))
                .filter(|v| !v.starts_with('-'))
                .cloned();
        }
        if has_flag(&args, &["--fork-session"])
            || (request.provider == "codex" && args.iter().any(|a| a == "fork"))
        {
            provider_id = None;
        }
        if request.provider == "claude" && !resume_requested && provider_id.is_none() {
            let assigned = id();
            insert_options(&mut args, vec!["--session-id".into(), assigned.clone()]);
            provider_id = Some(assigned);
        }
        let explicit_model = flag_value(&args, &["--model", "-m"]).unwrap_or_default();
        let explicit_effort = flag_value(&args, &["--effort"]).unwrap_or_default();
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Connection lock poisoned")?
            .clone();
        hooks::private_write(
            &path.with_extension("connection.json"),
            &serde_json::to_vec(&connection).map_err(|e| e.to_string())?,
        )?;
        if request.provider == "claude" {
            let mut settings = serde_json::json!({});
            let mut clean = Vec::new();
            let mut i = 0;
            while i < args.len() {
                let arg = &args[i];
                if arg == "--" {
                    clean.extend_from_slice(&args[i..]);
                    break;
                }
                let value = if arg == "--settings" {
                    i += 1;
                    Some(args.get(i).ok_or("--settings requires a value")?.clone())
                } else {
                    arg.strip_prefix("--settings=").map(str::to_owned)
                };
                if let Some(value) = value {
                    let text = if value.trim_start().starts_with('{') {
                        value
                    } else {
                        let user_path = Path::new(&value);
                        std::fs::read_to_string(if user_path.is_absolute() {
                            user_path.to_path_buf()
                        } else {
                            Path::new(&request.cwd).join(user_path)
                        })
                        .map_err(|e| format!("Cannot read Claude settings: {e}"))?
                    };
                    merge_settings(
                        &mut settings,
                        serde_json::from_str(&text)
                            .map_err(|e| format!("Invalid Claude settings: {e}"))?,
                    );
                } else {
                    clean.push(arg.clone());
                }
                i += 1;
            }
            merge_settings(&mut settings, hooks::claude_settings(&binary));
            hooks::private_write(
                &path,
                &serde_json::to_vec(&settings).map_err(|e| e.to_string())?,
            )?;
            args = clean;
            insert_options(
                &mut args,
                vec!["--settings".into(), path.to_string_lossy().into()],
            );
        } else {
            let notify = serde_json::to_string(&vec![
                binary.to_string_lossy().into_owned(),
                "--relay-hook".into(),
                "ready".into(),
                "--connection-file".into(),
                path.with_extension("connection.json")
                    .to_string_lossy()
                    .into_owned(),
                "--session-id".into(),
                session.id.clone(),
            ])
            .unwrap();
            insert_options(&mut args, vec!["-c".into(), format!("notify={notify}")]);
        }
        let result = prepared(&program, args, &request.cwd)?;
        self.ledger
            .lock()
            .map_err(|_| "Ledger lock poisoned")?
            .change(|d| {
                if let Some(pid) = &provider_id {
                    ledger::ensure_provider_id(d, &session.id, &request.provider, pid)?;
                }
                let same = resume_requested
                    && session.provider == request.provider
                    && (provider_id.is_none() || provider_id == session.provider_session_id);
                let s = ledger::session_mut(d, &session.id)?;
                s.provider = request.provider.clone();
                s.cwd = request.cwd.clone();
                s.shell_cwd = request.cwd.clone();
                s.provider_session_id = provider_id.clone();
                s.args = recovery_options(&request.args, &request.provider);
                if !same {
                    s.model = explicit_model.clone();
                    s.effort = explicit_effort.clone();
                    if !s.title_locked {
                        s.title = request.provider.clone();
                    }
                } else {
                    if !explicit_model.is_empty() {
                        s.model = explicit_model.clone();
                    }
                    if !explicit_effort.is_empty() {
                        s.effort = explicit_effort.clone();
                    }
                }
                s.status = "running".into();
                s.error = None;
                s.updated_at = now();
                d.provider_executables
                    .insert(session.id.clone(), program.clone());
                if let Some(home) = &request.provider_home {
                    d.provider_homes.insert(session.id.clone(), home.clone());
                } else {
                    d.provider_homes.remove(&session.id);
                }
                d.transcripts.remove(&session.id);
                d.conversation_started.remove(&session.id);
                if resume_requested && provider_id.is_some() {
                    d.conversation_started.insert(session.id.clone());
                }
                Ok(())
            })?;
        self.emit_state();
        Ok(result)
    }
}
pub fn run_prepare_cli(args: &[String]) {
    let mut format = "json";
    let mut cwd = std::env::current_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let provider = args.get(2).cloned().unwrap_or_default();
    let mut cursor = 3;
    while let Some(arg) = args.get(cursor) {
        match arg.as_str() {
            "--cwd" => {
                cwd = args.get(cursor + 1).cloned().unwrap_or_default();
                cursor += 2;
            }
            "--format" => {
                format = args.get(cursor + 1).map(String::as_str).unwrap_or("json");
                cursor += 2;
            }
            "--" => {
                cursor += 1;
                break;
            }
            _ => break,
        }
    }
    let forwarded = if format == "json" && cursor == args.len() {
        let mut input = String::new();
        let _ = std::io::stdin()
            .take(hooks::MAX_BODY as u64)
            .read_to_string(&mut input);
        serde_json::from_str::<Vec<String>>(&input).unwrap_or_default()
    } else {
        args[cursor..].to_vec()
    };
    let request = PrepareRequest {
        session_id: std::env::var("RELAY_SESSION_ID").unwrap_or_default(),
        provider: provider.clone(),
        cwd,
        args: forwarded,
        provider_home: std::env::var(if provider == "codex" {
            "CODEX_HOME"
        } else {
            "CLAUDE_CONFIG_DIR"
        })
        .ok(),
    };
    let result = hooks::post_local("prepare", &request)
        .and_then(|v| serde_json::from_value::<Prepared>(v).map_err(|e| e.to_string()));
    match result {
        Ok(value) => {
            if format == "nul" {
                let mut out = std::io::stdout().lock();
                for arg in std::iter::once(&value.executable).chain(value.args.iter()) {
                    let _ = out.write_all(arg.as_bytes());
                    let _ = out.write_all(&[0]);
                }
            } else {
                println!("{}", serde_json::to_string(&value).unwrap());
            }
        }
        Err(error) => {
            eprintln!("Relay provider preparation failed: {error}");
            std::process::exit(1);
        }
    }
}
fn ps_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}
fn sh_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}
pub fn bootstrap(
    runtime: &Arc<Runtime>,
    session: &Session,
    resume: bool,
    hook_path: &Path,
) -> Result<(PathBuf, Vec<String>, Option<PathBuf>), String> {
    let binary = std::env::current_exe().map_err(|e| e.to_string())?;
    let program = if session.executable.is_empty() {
        default_shell()
    } else {
        session.executable.clone()
    };
    let exe = pty::resolve_program(&program)?;
    let name = exe
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let startup_path = hook_path.with_extension("startup.json");
    let startup = if resume && matches!(session.provider.as_str(), "claude" | "codex") {
        if session.provider == "claude" {
            let mut settings: serde_json::Value = std::fs::read(hook_path)
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or_else(|| serde_json::json!({}));
            if let Some(groups) = settings
                .get_mut("hooks")
                .and_then(serde_json::Value::as_object_mut)
            {
                for matchers in groups
                    .values_mut()
                    .filter_map(serde_json::Value::as_array_mut)
                {
                    for matcher in matchers {
                        if let Some(commands) = matcher
                            .get_mut("hooks")
                            .and_then(serde_json::Value::as_array_mut)
                        {
                            commands.retain(|h| {
                                !h.get("command")
                                    .and_then(serde_json::Value::as_str)
                                    .is_some_and(|c| c.contains("--relay-hook"))
                            });
                        }
                    }
                }
            }
            merge_settings(&mut settings, hooks::claude_settings(&binary));
            hooks::private_write(
                hook_path,
                &serde_json::to_vec(&settings).map_err(|e| e.to_string())?,
            )?;
        }
        let saved = runtime
            .ledger
            .lock()
            .map_err(|_| "Ledger lock poisoned")?
            .data
            .provider_executables
            .get(&session.id)
            .cloned()
            .unwrap_or_else(|| pty::default_executable(&session.provider));
        Some(prepared(
            &saved,
            pty::provider_args(session, true, &binary, hook_path)?,
            &session.cwd,
        )?)
    } else {
        None
    };
    if let Some(startup) = &startup {
        hooks::private_write(
            &startup_path,
            &serde_json::to_vec(startup).map_err(|e| e.to_string())?,
        )?;
    }
    if matches!(name.as_str(), "powershell" | "pwsh") {
        let script = hook_path.with_extension("shell.ps1");
        let text = format!(
            r#"
$script:RelayBinary = {binary}
function Invoke-RelayPrepared($Launch) {{
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $Launch.executable
    $info.Arguments = $Launch.windowsArguments
    $info.WorkingDirectory = $Launch.cwd
    $info.UseShellExecute = $false
    $proc = [System.Diagnostics.Process]::Start($info)
    $proc.WaitForExit()
    $global:LASTEXITCODE = $proc.ExitCode
}}
function Invoke-RelayAgent([string]$Provider, [string[]]$Forwarded) {{
    $json = ConvertTo-Json -InputObject @($Forwarded) -Compress
    $raw = $json | & $script:RelayBinary --relay-prepare $Provider --cwd $PWD.ProviderPath
    if ($LASTEXITCODE -ne 0 -or !$raw) {{ return }}
    Invoke-RelayPrepared ($raw | ConvertFrom-Json)
    $agentExitCode = $global:LASTEXITCODE
    & $script:RelayBinary --relay-shell $PWD.ProviderPath
    $global:LASTEXITCODE = $agentExitCode
}}
foreach ($name in @('claude','claude-code','codex')) {{ Remove-Item -LiteralPath "Alias:$name" -Force -ErrorAction SilentlyContinue }}
function global:claude {{ Invoke-RelayAgent 'claude' @($args) }}
function global:claude-code {{ Invoke-RelayAgent 'claude' @($args) }}
function global:codex {{ Invoke-RelayAgent 'codex' @($args) }}
$script:RelayOriginalPrompt = $function:prompt
function global:prompt {{
    $priorExitCode = $global:LASTEXITCODE
    & $script:RelayBinary --relay-shell $PWD.ProviderPath
    $global:LASTEXITCODE = $priorExitCode
    if ($script:RelayOriginalPrompt) {{ & $script:RelayOriginalPrompt }} else {{ "PS $PWD> " }}
}}
{startup}
"#,
            binary = ps_quote(&binary.to_string_lossy()),
            startup = if startup.is_some() {
                format!(
                    "Invoke-RelayPrepared (Get-Content -Raw -LiteralPath {} | ConvertFrom-Json)",
                    ps_quote(&startup_path.to_string_lossy())
                )
            } else {
                String::new()
            }
        );
        hooks::private_write(&script, text.as_bytes())?;
        return Ok((
            exe,
            vec![
                "-NoLogo".into(),
                "-NoExit".into(),
                "-Command".into(),
                format!(". {}", ps_quote(&script.to_string_lossy())),
            ],
            None,
        ));
    }
    let integration = hook_path.with_extension("shell.sh");
    let start = startup
        .as_ref()
        .map(|p| {
            format!(
                "( cd {} && {} {} )",
                sh_quote(&p.cwd),
                sh_quote(&p.executable),
                p.args
                    .iter()
                    .map(|a| sh_quote(a))
                    .collect::<Vec<_>>()
                    .join(" ")
            )
        })
        .unwrap_or_default();
    let text = format!(
        r#"
__relay_binary={binary}
__relay_agent() {{
    local provider="$1"; shift
    local -a relay_command; local relay_arg; local relay_status=1
    while IFS= read -r -d '' relay_arg; do relay_command+=("$relay_arg"); done < <("$__relay_binary" --relay-prepare "$provider" --cwd "$PWD" --format nul -- "$@")
    if (( ${{#relay_command[@]}} )); then "${{relay_command[@]}}"; relay_status=$?; fi
    "$__relay_binary" --relay-shell "$PWD"
    return "$relay_status"
}}
unalias claude claude-code codex 2>/dev/null || true
claude() {{ __relay_agent claude "$@"; }}
claude-code() {{ __relay_agent claude "$@"; }}
codex() {{ __relay_agent codex "$@"; }}
__relay_prompt() {{ local relay_status=$?; "$__relay_binary" --relay-shell "$PWD"; return "$relay_status"; }}
{prompt}
{startup}
"#,
        binary = sh_quote(&binary.to_string_lossy()),
        prompt = if name == "zsh" {
            "precmd_functions+=(__relay_prompt)"
        } else {
            "PROMPT_COMMAND=\"__relay_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}\""
        },
        startup = start
    );
    hooks::private_write(&integration, text.as_bytes())?;
    match name.as_str() {
        "bash" => {
            let rc = hook_path.with_extension("bashrc");
            let rc_text = format!(
                "[[ -f ~/.bashrc ]] && source ~/.bashrc\nsource {}\n",
                sh_quote(&integration.to_string_lossy())
            );
            hooks::private_write(&rc, rc_text.as_bytes())?;
            Ok((
                exe,
                vec!["--rcfile".into(), rc.to_string_lossy().into(), "-i".into()],
                None,
            ))
        }
        "zsh" => {
            let dir = hook_path.with_extension("zsh");
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let original = std::env::var_os("ZDOTDIR")
                .map(PathBuf::from)
                .or_else(|| directories::BaseDirs::new().map(|d| d.home_dir().into()))
                .ok_or("Cannot find shell home")?;
            for file in [".zshenv", ".zshrc"] {
                let mut text = format!(
                    "[[ -f {original} ]] && source {original}\n",
                    original = sh_quote(&original.join(file).to_string_lossy())
                );
                if file == ".zshenv" {
                    text.push_str(&format!(
                        "export ZDOTDIR={}\n",
                        sh_quote(&dir.to_string_lossy())
                    ));
                } else {
                    text.push_str(&format!(
                        "source {}\n",
                        sh_quote(&integration.to_string_lossy())
                    ));
                }
                hooks::private_write(&dir.join(file), text.as_bytes())?;
            }
            Ok((exe, vec!["-i".into()], Some(dir)))
        }
        _ => Err(
            "Scoped agent integration supports PowerShell, Bash and Zsh. Choose one in Settings."
                .into(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_options_keep_permission_flags_without_repeating_prompt_or_stale_settings() {
        let args = [
            "resume",
            "thread-1",
            "--model",
            "old-model",
            "-c",
            "model_reasoning_effort=\"low\"",
            "-c",
            "model=\"old\"",
            "--sandbox",
            "read-only",
            "-c",
            "network_access=false",
            "--",
            "a previous prompt",
        ]
        .map(String::from);
        assert_eq!(
            recovery_options(&args, "codex"),
            ["--sandbox", "read-only", "-c", "network_access=false"]
        );
        let args = [
            "--resume=old-id",
            "--effort",
            "high",
            "--settings",
            "user.json",
            "--permission-mode",
            "default",
            "initial prompt",
        ]
        .map(String::from);
        assert_eq!(
            recovery_options(&args, "claude"),
            ["--permission-mode", "default"]
        );
        assert!(recovery_options(&["-c".into(), "previous prompt".into()], "claude").is_empty());
    }
    #[test]
    fn windows_arguments_protect_embedded_json_and_trailing_slashes() {
        assert_eq!(
            windows_quote("notify=[\"C:\\Program Files\\Relay\\relay.exe\"]"),
            "\"notify=[\\\"C:\\Program Files\\Relay\\relay.exe\\\"]\""
        );
        assert_eq!(windows_quote("C:\\space dir\\"), "\"C:\\space dir\\\\\"");
    }
}
