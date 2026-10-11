// PTY lifecycle and streaming are derived from Agentrium's MIT-licensed
// terminal.rs (Copyright 2026 ADE-1). Relay adds stable IDs, bounded replay,
// direct argv spawning and authoritative per-invocation provider hooks.
use super::{hooks, types::*, Runtime};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::{
    collections::VecDeque,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

pub const REPLAY_LIMIT: usize = 2 * 1024 * 1024;
pub struct Replay {
    pub sequence: u64,
    pub bytes: VecDeque<u8>,
}
impl Replay {
    pub fn new() -> Self {
        Self {
            sequence: 0,
            bytes: VecDeque::new(),
        }
    }
    pub fn push(&mut self, data: &[u8]) -> u64 {
        self.sequence += 1;
        if data.len() >= REPLAY_LIMIT {
            self.bytes.clear();
            self.bytes.extend(&data[data.len() - REPLAY_LIMIT..]);
        } else {
            let remove = (self.bytes.len() + data.len()).saturating_sub(REPLAY_LIMIT);
            self.bytes.drain(..remove);
            self.bytes.extend(data);
        }
        self.sequence
    }
    pub fn snapshot(&self) -> TerminalReplay {
        TerminalReplay {
            sequence: self.sequence,
            data: self.bytes.iter().copied().collect(),
        }
    }
}
pub struct Live {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub child: Box<dyn Child + Send + Sync>,
    pub generation: String,
}
pub fn default_executable(provider: &str) -> String {
    match provider {
        "claude" => "claude".into(),
        "codex" => "codex".into(),
        "shell" => {
            #[cfg(windows)]
            {
                "powershell.exe".into()
            }
            #[cfg(not(windows))]
            {
                std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
            }
        }
        _ => String::new(),
    }
}
pub fn search_directories() -> Vec<PathBuf> {
    let mut directories: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Some(base) = directories::BaseDirs::new() {
        let home = base.home_dir();
        directories.extend([
            home.join(".local/bin"),
            home.join(".cargo/bin"),
            home.join(".npm-global/bin"),
        ]);
        #[cfg(windows)]
        directories.extend([
            home.join("AppData/Roaming/npm"),
            home.join("AppData/Local/Programs/OpenAI/Codex/bin"),
        ]);
        #[cfg(target_os = "macos")]
        directories.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ]);
    }
    directories
}
pub fn resolve_program(program: &str) -> Result<PathBuf, String> {
    if program.trim().is_empty() {
        return Err("Choose an executable for this session".into());
    }
    let path = Path::new(program);
    if path.is_absolute() || path.components().count() > 1 {
        if path.is_file() {
            return Ok(path.to_path_buf());
        }
        return Err(format!("Executable does not exist: {program}"));
    }
    for directory in search_directories() {
        #[cfg(windows)]
        for extension in [".exe", ".com", "", ".cmd", ".bat"] {
            let candidate = directory.join(if path.extension().is_some() {
                program.to_string()
            } else {
                format!("{program}{extension}")
            });
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        #[cfg(not(windows))]
        {
            let candidate = directory.join(program);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(format!(
        "{program} is not installed or is not on PATH. Install the CLI, then start this tab again."
    ))
}
pub fn resolve_command(program: &str, args: Vec<String>) -> Result<(PathBuf, Vec<String>), String> {
    let path = resolve_program(program)?;
    #[cfg(windows)]
    if path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
    {
        // npm shims parse argv through cmd.exe a second time. Run their known
        // JS entry directly instead, so quotes in TOML notify arrays survive.
        let package=match path.file_stem().and_then(|s|s.to_str()).unwrap_or_default(){
            "claude"=>"node_modules/@anthropic-ai/claude-code/cli.js",
            "codex"=>"node_modules/@openai/codex/bin/codex.js",
            _=>return Err("Batch wrappers are unsupported. Choose the native executable or interpreter and script arguments.".into()),
        };
        let script = path.parent().unwrap_or(Path::new(".")).join(package);
        if !script.is_file() {
            return Err(format!(
                "Cannot resolve npm entry behind {}",
                path.display()
            ));
        }
        let mut argv = vec![script.to_string_lossy().into_owned()];
        argv.extend(args);
        return Ok((resolve_program("node")?, argv));
    }
    Ok((path, args))
}
pub fn provider_args(
    session: &Session,
    resume: bool,
    hook_binary: &Path,
    settings_file: &Path,
) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    for arg in &session.args {
        let key = arg.split('=').next().unwrap_or(arg);
        let invalid = match session.provider.as_str() {
            "claude" => matches!(
                key,
                "--continue"
                    | "-c"
                    | "--resume"
                    | "-r"
                    | "--session-id"
                    | "--fork-session"
                    | "--settings"
                    | "--model"
                    | "--effort"
                    | "--bare"
                    | "--safe-mode"
            ),
            "codex" => matches!(
                key,
                "resume" | "fork" | "--last" | "--model" | "-m" | "--remote"
            ),
            _ => false,
        };
        if invalid {
            return Err(format!("{key} is managed by Relay. Use the conversation, model and effort controls instead."));
        }
    }
    match session.provider.as_str() {
        "claude" => {
            let sid = session
                .provider_session_id
                .as_deref()
                .ok_or("Claude session has no assigned conversation ID")?;
            if resume {
                args.push(format!("--resume={sid}"));
            } else {
                args.extend(["--session-id".into(), sid.into()]);
            }
            if !session.model.is_empty() {
                args.extend(["--model".into(), session.model.clone()]);
            }
            if !session.effort.is_empty() {
                args.extend(["--effort".into(), session.effort.clone()]);
            }
            args.extend([
                "--settings".into(),
                settings_file.to_string_lossy().into_owned(),
            ]);
        }
        "codex" => {
            if resume {
                args.extend([
                    "resume".into(),
                    session
                        .provider_session_id
                        .clone()
                        .ok_or("Codex conversation has not been bound yet")?,
                ]);
            }
            if !session.shell_integrated {
                args.push("--no-alt-screen".into());
            }
            if !session.model.is_empty() {
                args.extend(["--model".into(), session.model.clone()]);
            }
            if !session.effort.is_empty() {
                args.extend([
                    "-c".into(),
                    format!(
                        "model_reasoning_effort={}",
                        serde_json::to_string(&session.effort).unwrap()
                    ),
                ]);
            }
            let notify = serde_json::to_string(&vec![
                hook_binary.to_string_lossy().into_owned(),
                "--relay-hook".into(),
                "ready".into(),
                "--connection-file".into(),
                settings_file
                    .with_extension("connection.json")
                    .to_string_lossy()
                    .into_owned(),
                "--session-id".into(),
                session.id.clone(),
            ])
            .unwrap();
            args.extend(["-c".into(), format!("notify={notify}")]);
        }
        _ => {}
    }
    args.extend(session.args.clone());
    Ok(args)
}
pub fn spawn(
    runtime: &Arc<Runtime>,
    session: &Session,
    resume: bool,
    initial_prompt: bool,
) -> Result<String, String> {
    if !Path::new(&session.cwd).is_dir() {
        return Err("The session's working directory no longer exists".into());
    }
    let hook_binary = std::env::current_exe().map_err(|e| e.to_string())?;
    let hook_path = runtime
        .data_dir
        .join("hooks")
        .join(format!("{}.json", session.id));
    let connection = runtime
        .connection
        .lock()
        .map_err(|_| "Connection lock poisoned")?
        .clone();
    hooks::private_write(
        &hook_path.with_extension("connection.json"),
        &serde_json::to_vec(&connection).map_err(|e| e.to_string())?,
    )?;
    if session.provider == "claude" && !session.shell_integrated {
        hooks::private_write(
            &hook_path,
            &serde_json::to_vec(&hooks::claude_settings(&hook_binary))
                .map_err(|e| e.to_string())?,
        )?;
    }
    let mut args = if session.shell_integrated {
        vec![]
    } else {
        provider_args(session, resume, &hook_binary, &hook_path)?
    };
    if initial_prompt
        && !session.initial_prompt.is_empty()
        && matches!(session.provider.as_str(), "claude" | "codex")
    {
        let prompt = if !session.initial_prompt.chars().any(char::is_whitespace)
            || session.initial_prompt.len() > 16000
        {
            let prompt_path = runtime
                .data_dir
                .join("hooks")
                .join(format!("{}.prompt.md", session.id));
            hooks::private_write(&prompt_path, session.initial_prompt.as_bytes())?;
            format!(
                "Read the task instructions in {} and respond to them.",
                prompt_path.display()
            )
        } else {
            session.initial_prompt.clone()
        };
        append_prompt(&mut args, prompt);
    }
    if session.provider == "shell" && args.is_empty() {
        #[cfg(windows)]
        {
            args.extend(["-NoLogo".into(), "-NoProfile".into()]);
        }
        #[cfg(not(windows))]
        {
            args.push("-l".into());
        }
    }
    let executable = if session.executable.is_empty() {
        default_executable(&session.provider)
    } else {
        session.executable.clone()
    };
    let (program, args, zdotdir) = if session.shell_integrated {
        super::shell::bootstrap(runtime, session, resume, &hook_path)?
    } else {
        let (program, args) = resolve_command(&executable, args)?;
        (program, args, None)
    };
    let pty = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Cannot open PTY: {e}"))?;
    let mut command = CommandBuilder::new(&program);
    command.args(&args);
    command.cwd(
        if session.shell_integrated && !session.shell_cwd.is_empty() {
            &session.shell_cwd
        } else {
            &session.cwd
        },
    );
    if let Some(zdotdir) = zdotdir {
        command.env("ZDOTDIR", zdotdir);
    }
    if let Ok(path) = std::env::join_paths(search_directories()) {
        command.env("PATH", path);
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("RELAY_ENDPOINT", connection.endpoint);
    command.env("RELAY_TOKEN", connection.token);
    command.env("RELAY_SESSION_ID", &session.id);
    let child = pty
        .slave
        .spawn_command(command)
        .map_err(|e| format!("Cannot start {executable}: {e}"))?;
    drop(pty.slave);
    let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pty.master.take_writer().map_err(|e| e.to_string())?;
    let generation = id();
    let replay = runtime.replay_for(&session.id)?;
    runtime
        .live
        .lock()
        .map_err(|_| "PTY lock poisoned")?
        .insert(
            session.id.clone(),
            Live {
                master: pty.master,
                writer,
                child,
                generation: generation.clone(),
            },
        );
    let weak = Arc::downgrade(runtime);
    let session_id = session.id.clone();
    let generation_for_reader = generation.clone();
    std::thread::Builder::new()
        .name(format!(
            "relay-pty-{}",
            &session.id[..8.min(session.id.len())]
        ))
        .spawn(move || {
            let mut buffer = [0u8; 32768];
            let mut pending = Vec::new();
            let mut handshake_pending = cfg!(windows);
            let mut scanned = 0usize;
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        let Some(runtime) = weak.upgrade() else {
                            break;
                        };
                        let mut data = buffer[..n].to_vec();
                        if handshake_pending {
                            pending.extend(data);
                            data = std::mem::take(&mut pending);
                            scanned += n;
                            if let Some(at) = data.windows(4).position(|bytes| bytes == b"\x1b[6n")
                            {
                                // ConPTY inherits a cursor before the child starts.
                                // Answer even when no React terminal is mounted, and
                                // strip this request so xterm doesn't answer twice.
                                if let Ok(mut lives) = runtime.live.lock() {
                                    if let Some(live) = lives.get_mut(&session_id) {
                                        let _ = live.writer.write_all(b"\x1b[1;1R");
                                        let _ = live.writer.flush();
                                    }
                                }
                                data.drain(at..at + 4);
                                handshake_pending = false;
                            } else {
                                let query = b"\x1b[6n";
                                let keep = (1..=3.min(data.len()))
                                    .rev()
                                    .find(|&len| data.ends_with(&query[..len]))
                                    .unwrap_or(0);
                                pending = data.split_off(data.len() - keep);
                                if scanned > 65536 {
                                    data.append(&mut pending);
                                    handshake_pending = false;
                                }
                            }
                        }
                        if data.is_empty() {
                            continue;
                        }
                        let sequence = match replay.lock() {
                            Ok(mut replay) => replay.push(&data),
                            Err(_) => break,
                        };
                        runtime.emit_output(TerminalOutput {
                            session_id: session_id.clone(),
                            sequence,
                            data,
                        });
                    }
                    Err(_) => break,
                }
            }
            if let Some(runtime) = weak.upgrade() {
                runtime.pty_ended(&session_id, &generation_for_reader);
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(generation)
}

fn append_prompt(args: &mut Vec<String>, prompt: String) {
    args.push("--".into());
    args.push(prompt);
}

#[cfg(test)]
mod tests {
    use super::*;
    fn session(provider: &str) -> Session {
        Session {
            id: "tab".into(),
            group_id: "work".into(),
            title: "Task".into(),
            title_locked: false,
            provider: provider.into(),
            cwd: "/project".into(),
            model: "exact-model".into(),
            effort: "xhigh".into(),
            executable: String::new(),
            args: vec![],
            provider_session_id: Some("opaque-conversation".into()),
            status: "stopped".into(),
            unread: false,
            archived: false,
            created_at: 0,
            updated_at: 0,
            last_activity_at: 0,
            error: None,
            initial_prompt: String::new(),
            kind: "work".into(),
            shell_integrated: false,
            shell_cwd: String::new(),
        }
    }
    #[test]
    fn recovery_uses_exact_ids_and_explicit_settings_without_latest_fallback() {
        let s = session("codex");
        let args = provider_args(&s, true, Path::new("/relay"), Path::new("/hooks.json")).unwrap();
        assert_eq!(&args[..2], ["resume", "opaque-conversation"]);
        assert!(args.contains(&"exact-model".into()));
        assert!(args.contains(&"model_reasoning_effort=\"xhigh\"".into()));
        assert!(!args.iter().any(|a| a == "--last" || a == "--continue"));
        let mut s = session("claude");
        let first =
            provider_args(&s, false, Path::new("/relay"), Path::new("/hooks.json")).unwrap();
        assert_eq!(&first[..2], ["--session-id", "opaque-conversation"]);
        let resume =
            provider_args(&s, true, Path::new("/relay"), Path::new("/hooks.json")).unwrap();
        assert_eq!(resume[0], "--resume=opaque-conversation");
        s.args.push("--continue".into());
        assert!(provider_args(&s, true, Path::new("/relay"), Path::new("/hooks.json")).is_err());
    }
    #[test]
    fn output_replay_has_monotonic_sequence_and_bounded_memory() {
        let mut r = Replay::new();
        assert_eq!(r.push(&vec![1; REPLAY_LIMIT]), 1);
        assert_eq!(r.push(&[2, 3]), 2);
        let replay = r.snapshot();
        assert_eq!(replay.sequence, 2);
        assert_eq!(replay.data.len(), REPLAY_LIMIT);
        assert_eq!(&replay.data[REPLAY_LIMIT - 2..], [2, 3]);
    }
    #[test]
    fn prompt_cannot_become_an_option() {
        let mut args = vec!["--model".into(), "exact".into()];
        append_prompt(&mut args, "--dangerously-skip-permissions do a task".into());
        assert_eq!(args[2], "--");
        assert_eq!(args.len(), 4);
    }
}
