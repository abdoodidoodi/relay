pub mod hooks;
mod ledger;
mod pty;
mod rules;
mod shell;
mod types;

use ledger::{session_mut, Ledger};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Emitter, Manager};
use types::*;

pub struct Runtime {
    pub ledger: Mutex<Ledger>,
    pub data_dir: PathBuf,
    pub token: String,
    pub connection: Mutex<hooks::ConnectionInfo>,
    pub live: Mutex<HashMap<String, pty::Live>>,
    replays: Mutex<HashMap<String, Arc<Mutex<pty::Replay>>>>,
    pub running_rules: Mutex<HashSet<String>>,
    pub quitting: AtomicBool,
    app: Option<tauri::AppHandle>,
    actions: Mutex<()>,
}
impl Runtime {
    fn new(data_dir: PathBuf, app: Option<tauri::AppHandle>) -> Result<Arc<Self>, String> {
        let data_dir = if data_dir.is_absolute() {
            data_dir
        } else {
            std::env::current_dir()
                .map_err(|e| e.to_string())?
                .join(data_dir)
        };
        std::fs::create_dir_all(data_dir.join("hooks")).map_err(|e| e.to_string())?;
        let ledger = Ledger::open(&data_dir.join("relay.sqlite3"))?;
        use rand::RngCore;
        let mut random = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut random);
        let token = random.iter().map(|byte| format!("{byte:02x}")).collect();
        Ok(Arc::new(Self {
            ledger: Mutex::new(ledger),
            data_dir,
            token,
            connection: Mutex::new(hooks::ConnectionInfo {
                endpoint: String::new(),
                token: String::new(),
            }),
            live: Mutex::new(HashMap::new()),
            replays: Mutex::new(HashMap::new()),
            running_rules: Mutex::new(HashSet::new()),
            quitting: AtomicBool::new(false),
            app,
            actions: Mutex::new(()),
        }))
    }
    pub fn snapshot(&self) -> Result<Snapshot, String> {
        let l = self.ledger.lock().map_err(|_| "Ledger lock poisoned")?;
        let d = &l.data;
        Ok(Snapshot {
            version: d.version,
            groups: d.groups.clone(),
            sessions: d.sessions.clone(),
            notifications: d.notifications.clone(),
            rules: d.rules.clone(),
            settings: d.settings.clone(),
            active_session_id: d.active_session_id.clone(),
            data_dir: self.data_dir.to_string_lossy().into_owned(),
            hook_endpoint: self
                .connection
                .lock()
                .map_err(|_| "Connection lock poisoned")?
                .endpoint
                .clone(),
            platform: std::env::consts::OS.into(),
        })
    }
    pub fn emit_state(&self) {
        if let Some(app) = &self.app {
            if let Ok(snapshot) = self.snapshot() {
                let _ = app.emit("relay-state", snapshot);
            }
        }
    }
    pub fn emit_output(&self, output: TerminalOutput) {
        if let Some(app) = &self.app {
            let _ = app.emit("relay-output", output);
        }
    }
    pub fn native_notify(&self, title: &str, body: &str) {
        if self.app.is_none() {
            return;
        }
        let title = title.to_string();
        let body = body.chars().take(500).collect::<String>();
        std::thread::spawn(move || {
            let _ = notify_rust::Notification::new()
                .summary(&title)
                .body(&body)
                .show();
        });
    }
    pub fn replay_for(&self, id: &str) -> Result<Arc<Mutex<pty::Replay>>, String> {
        let mut replays = self.replays.lock().map_err(|_| "Replay lock poisoned")?;
        Ok(replays
            .entry(id.into())
            .or_insert_with(|| Arc::new(Mutex::new(pty::Replay::new())))
            .clone())
    }
    fn session(&self, id: &str) -> Result<Session, String> {
        self.ledger
            .lock()
            .map_err(|_| "Ledger lock poisoned")?
            .data
            .sessions
            .iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or_else(|| "Session does not exist".into())
    }
    fn start_session(self: &Arc<Self>, id: &str, recovering: bool) -> Result<(), String> {
        if self.quitting.load(Ordering::Relaxed) {
            return Err("Relay is quitting".into());
        }
        if self
            .live
            .lock()
            .map_err(|_| "PTY lock poisoned")?
            .contains_key(id)
        {
            return Ok(());
        }
        let mut session = self.session(id)?;
        if session.archived {
            return Err("Archived sessions cannot be started".into());
        }
        let transcript = exact_transcript(
            &session,
            self.ledger
                .lock()
                .map_err(|_| "Ledger lock poisoned")?
                .data
                .transcripts
                .get(id)
                .map(String::as_str),
        );
        let started = self
            .ledger
            .lock()
            .map_err(|_| "Ledger lock poisoned")?
            .data
            .conversation_started
            .contains(id);
        let resume = match session.provider.as_str() {
            "claude" => transcript.is_some() || started,
            "codex" => session.provider_session_id.is_some(),
            "custom" if session.provider_session_id.is_some() => {
                return Err(
                    "Custom agents need an explicit resume command in their arguments".into(),
                )
            }
            _ => false,
        };
        if recovering && !resume {
            let error="This tab has no verified saved conversation yet. Start it explicitly to begin a session.";
            self.ledger
                .lock()
                .map_err(|_| "Ledger lock poisoned")?
                .change(|d| {
                    let s = session_mut(d, id)?;
                    s.status = "stopped".into();
                    s.error = Some(error.into());
                    Ok(())
                })?;
            return Ok(());
        }
        if session.provider == "claude" && session.provider_session_id.is_none() {
            let assigned = types::id();
            self.ledger
                .lock()
                .map_err(|_| "Ledger lock poisoned")?
                .change(|d| {
                    session_mut(d, id)?.provider_session_id = Some(assigned.clone());
                    Ok(())
                })?;
            session.provider_session_id = Some(assigned);
        }
        if recovering {
            if let Some(path) = transcript {
                let updated = std::fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|m| m.as_millis() as i64)
                    .unwrap_or(0);
                if updated > session.updated_at {
                    if let Some(event) = transcript_settings(&path, &session) {
                        self.apply_event(event)?;
                        session = self.session(id)?;
                    }
                }
            }
        }
        self.ledger
            .lock()
            .map_err(|_| "Ledger lock poisoned")?
            .change(|d| {
                d.resume_on_launch.insert(id.into());
                let s = session_mut(d, id)?;
                s.status = "starting".into();
                s.error = None;
                s.updated_at = now();
                Ok(())
            })?;
        self.emit_state();
        let initial = !self
            .ledger
            .lock()
            .map_err(|_| "Ledger lock poisoned")?
            .data
            .prompted
            .contains(id)
            && !resume;
        match pty::spawn(self, &session, resume, initial) {
            Ok(_) => {
                self.ledger
                    .lock()
                    .map_err(|_| "Ledger lock poisoned")?
                    .change(|d| {
                        if initial && !session.initial_prompt.is_empty() {
                            d.prompted.insert(id.into());
                        }
                        let s = session_mut(d, id)?;
                        if s.status == "starting" {
                            s.status = "running".into();
                        }
                        s.updated_at = now();
                        Ok(())
                    })?;
                self.emit_state();
                Ok(())
            }
            Err(error) => {
                self.ledger
                    .lock()
                    .map_err(|_| "Ledger lock poisoned")?
                    .change(|d| {
                        let s = session_mut(d, id)?;
                        s.status = "error".into();
                        s.error = Some(error.clone());
                        s.updated_at = now();
                        Ok(())
                    })?;
                self.emit_state();
                Err(error)
            }
        }
    }
    fn stop_session(&self, id: &str, keep_resume: bool) -> Result<(), String> {
        self.ledger
            .lock()
            .map_err(|_| "Ledger lock poisoned")?
            .change(|d| {
                if !keep_resume {
                    d.resume_on_launch.remove(id);
                }
                let s = session_mut(d, id)?;
                s.status = "stopped".into();
                s.updated_at = now();
                Ok(())
            })?;
        if let Some(mut live) = self
            .live
            .lock()
            .map_err(|_| "PTY lock poisoned")?
            .remove(id)
        {
            let _ = live.child.kill();
            drop(live.writer);
            drop(live.master);
        }
        self.emit_state();
        Ok(())
    }
    pub fn pty_ended(&self, id: &str, generation: &str) {
        let mut code = None;
        // EOF can precede process termination. Give exit status a bounded grace
        // period without holding the shared PTY lock between polls.
        for _ in 0..20 {
            let Ok(mut lives) = self.live.lock() else {
                return;
            };
            let Some(live) = lives.get_mut(id) else {
                return;
            };
            if live.generation != generation {
                return;
            }
            code = live
                .child
                .try_wait()
                .ok()
                .flatten()
                .map(|status| status.exit_code());
            drop(lives);
            if code.is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        if let Ok(mut lives) = self.live.lock() {
            if lives
                .get(id)
                .is_some_and(|live| live.generation == generation)
            {
                if let Some(mut live) = lives.remove(id) {
                    if code.is_none() {
                        let _ = live.child.kill();
                    }
                    drop(live.writer);
                    drop(live.master);
                }
            } else {
                return;
            }
        }
        if self.quitting.load(Ordering::Relaxed) {
            return;
        }
        let error = match code {
            Some(0) => None,
            Some(code) => Some(format!("The process exited with code {code}")),
            None => {
                Some("The terminal stream closed before the process reported an exit status".into())
            }
        };
        let _ = self.ledger.lock().map(|mut l| {
            l.change(|d| {
                let s = session_mut(d, id)?;
                s.status = if error.is_some() { "error" } else { "stopped" }.into();
                s.error = error;
                s.updated_at = now();
                Ok(())
            })
        });
        self.emit_state();
    }
    pub fn apply_event(&self, mut event: HookEvent) -> Result<(), String> {
        if event.event == "shell_cwd" {
            let sid = event
                .session_id
                .as_deref()
                .ok_or("Shell event requires a tab ID")?;
            let cwd = event
                .cwd
                .as_deref()
                .ok_or("Shell event requires a folder")?;
            if cwd.len() > 16000 || !Path::new(cwd).is_dir() {
                return Err("Invalid shell folder".into());
            }
            let mut ledger = self.ledger.lock().map_err(|_| "Ledger lock poisoned")?;
            let s = ledger
                .data
                .sessions
                .iter()
                .find(|s| s.id == sid)
                .ok_or("Session does not exist")?;
            if !s.shell_integrated || s.archived {
                return Err("Not an integrated terminal".into());
            }
            if s.shell_cwd == cwd && s.status == "idle" {
                return Ok(());
            }
            ledger.change(|d| {
                let s = session_mut(d, sid)?;
                s.shell_cwd = cwd.into();
                if s.provider == "shell" {
                    s.cwd = cwd.into();
                }
                s.status = "idle".into();
                s.updated_at = now();
                Ok(())
            })?;
            drop(ledger);
            self.emit_state();
            return Ok(());
        }
        if !matches!(
            event.event.as_str(),
            "session_start" | "prompt" | "working" | "ready" | "notification" | "settings"
        ) {
            return Err("Unknown event type".into());
        }
        for value in [
            &event.title,
            &event.model,
            &event.effort,
            &event.provider_session_id,
            &event.source,
            &event.dedupe_key,
            &event.session_id,
            &event.provider,
        ] {
            if value
                .as_ref()
                .is_some_and(|s| s.len() > 1000 || s.contains('\0'))
            {
                return Err("Event field exceeds limit".into());
            }
        }
        // Codex notify identifies the conversation authoritatively. Only after
        // that binding may its exact transcript supply model/effort metadata.
        if event.event == "ready" {
            if let Some(sid) = event.session_id.as_deref() {
                if let Ok(mut s) = self.session(sid) {
                    if s.provider == "codex" || event.provider.as_deref() == Some("codex") {
                        s.provider = "codex".into();
                        let provider_home = self
                            .ledger
                            .lock()
                            .ok()
                            .and_then(|l| l.data.provider_homes.get(sid).cloned());
                        if let Some(pid) = &event.provider_session_id {
                            s.provider_session_id = Some(pid.clone());
                            let known = event.transcript_path.clone().or_else(|| {
                                self.ledger
                                    .lock()
                                    .ok()
                                    .and_then(|l| l.data.transcripts.get(sid).cloned())
                            });
                            let path = exact_transcript(&s, known.as_deref()).or_else(|| {
                                provider_home.as_ref().and_then(|home| {
                                    find_transcript(&Path::new(home).join("sessions"), pid, 5)
                                })
                            });
                            let attested = path.filter(|path| {
                                for attempt in 0..3 {
                                    if codex_completion_attested(
                                        path,
                                        pid,
                                        event.provider_turn_id.as_deref(),
                                    ) {
                                        return true;
                                    }
                                    if attempt < 2 {
                                        std::thread::sleep(std::time::Duration::from_millis(50));
                                    }
                                }
                                false
                            });
                            if attested.is_none() {
                                // Codex's temporary title threads also inherit notify. They
                                // have no durable root rollout; never bind or mark ready on
                                // their completion, regardless of prompt or answer content.
                                return Ok(());
                            }
                            event.transcript_path =
                                attested.map(|p| p.to_string_lossy().into_owned());
                        }
                        if let Some(path) = exact_transcript(&s, event.transcript_path.as_deref()) {
                            if let Some(settings) = transcript_settings(&path, &s) {
                                event.model = settings.model;
                                event.effort = settings.effort;
                                event.transcript_path = Some(path.to_string_lossy().into_owned());
                            }
                        }
                        if let Some(title) = codex_title(&s, provider_home.as_deref()) {
                            event.title = Some(title);
                        }
                    }
                }
            }
        }
        if event.body.as_ref().is_some_and(|s| s.len() > 200000)
            || event.prompt.as_ref().is_some_and(|s| s.len() > 200000)
        {
            return Err("Event text exceeds limit".into());
        }
        if event
            .cwd
            .as_ref()
            .is_some_and(|s| s.len() > 16000 || s.contains('\0'))
        {
            return Err("Invalid provider working folder".into());
        }
        let mut ledger = self.ledger.lock().map_err(|_| "Ledger lock poisoned")?;
        let sid = event.session_id.as_deref();
        if let Some(expected) = &event.expected_provider_session_id {
            let current = sid.and_then(|id| ledger.data.sessions.iter().find(|s| s.id == id));
            if current.is_none_or(|s| s.provider_session_id.as_ref() != Some(expected)) {
                return Ok(());
            }
        }
        if event.event == "settings" {
            let id = sid.ok_or("Settings event requires a Relay session ID")?;
            let s = ledger
                .data
                .sessions
                .iter()
                .find(|s| s.id == id)
                .ok_or("Session does not exist")?;
            let same = event
                .model
                .as_ref()
                .is_none_or(|m| m == &s.model || m.is_empty())
                && event
                    .effort
                    .as_ref()
                    .is_none_or(|e| e == &s.effort || e.is_empty())
                && event
                    .title
                    .as_ref()
                    .is_none_or(|t| s.title_locked || t == &s.title || t.is_empty())
                && event
                    .provider_session_id
                    .as_ref()
                    .is_none_or(|p| Some(p) == s.provider_session_id.as_ref())
                && event.cwd.as_ref().is_none_or(|p| p == &s.cwd)
                && event.provider.as_ref().is_none_or(|p| p == &s.provider);
            let same_transcript = event
                .transcript_path
                .as_ref()
                .is_none_or(|p| ledger.data.transcripts.get(id) == Some(p));
            if same && same_transcript {
                return Ok(());
            }
        }
        let dedupe = event
            .dedupe_key
            .as_ref()
            .map(|key| format!("{}:{key}", event.source.as_deref().unwrap_or("local")));
        let applied = ledger
            .change_event(dedupe.as_deref(), |data| {
                if let Some(id) = sid {
                    let provider = event.provider.clone().unwrap_or_else(|| {
                        data.sessions
                            .iter()
                            .find(|s| s.id == id)
                            .map(|s| s.provider.clone())
                            .unwrap_or_default()
                    });
                    if !valid_provider(&provider) {
                        return Err("Unknown event provider".into());
                    }
                    if !data.sessions.iter().any(|s| s.id == id) {
                        return Err("Session does not exist".into());
                    }
                    if let Some(provider_id) = &event.provider_session_id {
                        ledger::ensure_provider_id(data, id, &provider, provider_id)?;
                    }
                    if let Some(path) = &event.transcript_path {
                        if Path::new(path).is_file() {
                            data.transcripts.insert(id.into(), path.clone());
                        }
                    }
                    if matches!(event.event.as_str(), "prompt" | "ready") {
                        data.conversation_started.insert(id.into());
                    }
                    let s = session_mut(data, id)?;
                    s.provider = provider;
                    if let Some(cwd) = event.cwd.as_ref().filter(|p| Path::new(p).is_dir()) {
                        s.cwd = cwd.clone();
                    }
                    if let Some(provider_id) = &event.provider_session_id {
                        s.provider_session_id = Some(provider_id.clone());
                    }
                    if let Some(model) = &event.model {
                        if !model.is_empty() {
                            s.model = model.clone();
                        }
                    }
                    if let Some(effort) = &event.effort {
                        if !effort.is_empty() {
                            s.effort = effort.clone();
                        }
                    }
                    if !s.title_locked {
                        if let Some(title) = event.title.as_ref().filter(|t| !t.trim().is_empty()) {
                            s.title = title.chars().take(120).collect();
                        } else if matches!(event.event.as_str(), "prompt" | "ready")
                            && (s.title == "Terminal"
                                || s.title == "claude"
                                || s.title == "codex"
                                || s.title.ends_with(" session"))
                        {
                            if let Some(prompt) = &event.prompt {
                                s.title = prompt
                                    .split_whitespace()
                                    .collect::<Vec<_>>()
                                    .join(" ")
                                    .chars()
                                    .take(60)
                                    .collect();
                            }
                        }
                    }
                    s.updated_at = now();
                    s.last_activity_at = now();
                    s.error = None;
                    match event.event.as_str() {
                        "session_start" => s.status = "idle".into(),
                        "prompt" | "working" => {
                            s.status = "running".into();
                            if event.event == "prompt" {
                                s.unread = false;
                            }
                        }
                        "ready" => {
                            s.status = "ready".into();
                            s.unread = true;
                        }
                        _ => {}
                    }
                } else if event.event != "notification" {
                    return Err("This event requires a Relay session ID".into());
                }
                if matches!(event.event.as_str(), "notification" | "ready") {
                    let mut notification = event.clone();
                    if event.event == "ready" {
                        let name = sid
                            .and_then(|id| data.sessions.iter().find(|s| s.id == id))
                            .map(|s| s.title.clone())
                            .unwrap_or_else(|| "Session".into());
                        notification.title = Some(format!("{name} is ready"));
                    }
                    ledger::add_notification(data, &notification)?;
                }
                // Webhook rules only publish a local notification, never execute commands.
                let matching: Vec<Rule> = data
                    .rules
                    .iter()
                    .filter(|r| {
                        r.enabled
                            && r.kind == "webhook"
                            && event.source.as_deref() == Some(&r.source)
                    })
                    .cloned()
                    .collect();
                for rule in matching {
                    ledger::add_notification(
                        data,
                        &HookEvent {
                            event: "notification".into(),
                            session_id: rule.session_id.clone(),
                            title: Some(rule.title.clone()),
                            body: Some(if rule.body.is_empty() {
                                event.body.clone().unwrap_or_default()
                            } else {
                                rule.body.clone()
                            }),
                            source: Some(rule.source.clone()),
                            ..Default::default()
                        },
                    )?;
                    if let Some(r) = data.rules.iter_mut().find(|r| r.id == rule.id) {
                        r.last_run_at = Some(now());
                        r.last_error = None;
                    }
                }
                Ok(())
            })?
            .is_some();
        drop(ledger);
        if applied {
            self.emit_state();
            if matches!(event.event.as_str(), "notification" | "ready") {
                self.native_notify(
                    event.title.as_deref().unwrap_or("Relay · response ready"),
                    event
                        .body
                        .as_deref()
                        .unwrap_or("Open Relay to review the conversation."),
                );
            }
        }
        Ok(())
    }
    fn action(self: &Arc<Self>, action: Action) -> Result<Snapshot, String> {
        let _actions = self.actions.lock().map_err(|_| "Actions lock poisoned")?;
        if self.quitting.load(Ordering::Relaxed) {
            return Err("Relay is quitting".into());
        }
        if let Action::UpdateSession {
            id,
            model,
            effort,
            provider_session_id,
            ..
        } = &action
        {
            if (model.is_some() || effort.is_some() || provider_session_id.is_some())
                && self
                    .live
                    .lock()
                    .map_err(|_| "PTY lock poisoned")?
                    .contains_key(id)
            {
                return Err("Stop this session before editing its launch settings. Live CLI changes are captured automatically.".into());
            }
        }
        let mut start = None;
        let mut stop = None;
        let mut run = None;
        self.ledger
            .lock()
            .map_err(|_| "Ledger lock poisoned")?
            .change(|data| {
                match action {
                    Action::CompleteSetup { cwd } => {
                        if data.settings.setup_complete {
                            return Err("Working folder setup is already complete".into());
                        }
                        if !Path::new(&cwd).is_dir() {
                            return Err("Choose an existing working folder".into());
                        }
                        data.settings.default_cwd = cwd;
                        data.settings.setup_complete = true;
                        data.settings.auto_resume = false;
                        let group = data
                            .groups
                            .first()
                            .ok_or("Group does not exist")?
                            .id
                            .clone();
                        start = Some(shell::new_terminal(data, &group)?);
                    }
                    Action::NewTerminal { group_id } => {
                        if !data.settings.setup_complete {
                            return Err("Choose your working folder first".into());
                        }
                        let group = group_id.unwrap_or_else(|| data.groups[0].id.clone());
                        start = Some(shell::new_terminal(data, &group)?);
                    }
                    Action::CreateGroup { title } => {
                        let title = short_title(&title)?;
                        data.groups.push(Group {
                            id: id(),
                            title,
                            collapsed: false,
                        });
                    }
                    Action::UpdateGroup {
                        id,
                        title,
                        collapsed,
                    } => {
                        let g = data
                            .groups
                            .iter_mut()
                            .find(|g| g.id == id)
                            .ok_or("Group does not exist")?;
                        if let Some(title) = title {
                            g.title = short_title(&title)?;
                        }
                        if let Some(collapsed) = collapsed {
                            g.collapsed = collapsed;
                        }
                    }
                    Action::DeleteGroup { id } => {
                        if data.groups.len() <= 1 {
                            return Err("Keep at least one group".into());
                        }
                        data.groups.retain(|g| g.id != id);
                        let target = data.groups.first().unwrap().id.clone();
                        for s in &mut data.sessions {
                            if s.group_id == id {
                                s.group_id = target.clone();
                            }
                        }
                    }
                    Action::CreateSession { session: c } => {
                        if !valid_provider(&c.provider) {
                            return Err("Unknown provider".into());
                        }
                        if !data.groups.iter().any(|g| g.id == c.group_id) {
                            return Err("Group does not exist".into());
                        }
                        if !Path::new(&c.cwd).is_dir() {
                            return Err("Choose an existing working directory".into());
                        }
                        let sid = id();
                        let provider_id = if c.provider == "claude" {
                            Some(c.provider_session_id.clone().unwrap_or_else(id))
                        } else {
                            c.provider_session_id.clone()
                        };
                        if let Some(pid) = &provider_id {
                            ledger::ensure_provider_id(data, &sid, &c.provider, pid)?;
                            if c.provider == "claude" && uuid::Uuid::parse_str(pid).is_err() {
                                return Err("Claude conversation IDs must be UUIDs".into());
                            }
                        }
                        if c.provider_session_id.is_some() {
                            data.conversation_started.insert(sid.clone());
                        }
                        let timestamp = now();
                        let title = c
                            .title
                            .as_ref()
                            .filter(|s| !s.trim().is_empty())
                            .map(|s| short_title(s))
                            .transpose()?
                            .unwrap_or_else(|| format!("{} session", c.provider));
                        let kind = c.kind.unwrap_or_else(|| "work".into());
                        if !matches!(kind.as_str(), "work" | "assistant") {
                            return Err("Unknown session kind".into());
                        }
                        data.sessions.push(Session {
                            id: sid.clone(),
                            group_id: c.group_id,
                            title,
                            title_locked: c.title.is_some(),
                            provider: c.provider,
                            cwd: c.cwd,
                            model: c.model.unwrap_or_default(),
                            effort: c.effort.unwrap_or_default(),
                            executable: c.executable.unwrap_or_default(),
                            args: c.args.unwrap_or_default(),
                            provider_session_id: provider_id,
                            status: "stopped".into(),
                            unread: false,
                            archived: false,
                            created_at: timestamp,
                            updated_at: timestamp,
                            last_activity_at: timestamp,
                            error: None,
                            initial_prompt: c.initial_prompt.unwrap_or_default(),
                            kind: kind.clone(),
                            shell_integrated: false,
                            shell_cwd: String::new(),
                        });
                        data.active_session_id = Some(sid.clone());
                        if kind == "work" {
                            start = Some(sid);
                        }
                    }
                    Action::UpdateSession {
                        id,
                        title,
                        model,
                        effort,
                        provider_session_id,
                    } => {
                        if let Some(pid) = &provider_session_id {
                            let p = data
                                .sessions
                                .iter()
                                .find(|s| s.id == id)
                                .ok_or("Session does not exist")?
                                .provider
                                .clone();
                            ledger::ensure_provider_id(data, &id, &p, pid)?;
                        }
                        if provider_session_id.is_some() {
                            data.conversation_started.insert(id.clone());
                        }
                        let s = session_mut(data, &id)?;
                        if let Some(title) = title {
                            s.title = short_title(&title)?;
                            s.title_locked = true;
                        }
                        if let Some(model) = model {
                            s.model = model;
                        }
                        if let Some(effort) = effort {
                            s.effort = effort;
                        }
                        if let Some(pid) = provider_session_id {
                            s.provider_session_id = Some(pid);
                        }
                        s.updated_at = now();
                    }
                    Action::MoveSession {
                        id,
                        group_id,
                        before_id,
                    } => {
                        if !data.groups.iter().any(|g| g.id == group_id) {
                            return Err("Group does not exist".into());
                        }
                        let index = data
                            .sessions
                            .iter()
                            .position(|s| s.id == id)
                            .ok_or("Session does not exist")?;
                        let mut s = data.sessions.remove(index);
                        s.group_id = group_id;
                        s.updated_at = now();
                        let position = before_id
                            .as_ref()
                            .and_then(|id| data.sessions.iter().position(|s| &s.id == id))
                            .unwrap_or(data.sessions.len());
                        data.sessions.insert(position, s);
                    }
                    Action::StartSession { id } => {
                        session_mut(data, &id)?;
                        start = Some(id);
                    }
                    Action::StopSession { id } => {
                        session_mut(data, &id)?;
                        data.resume_on_launch.remove(&id);
                        stop = Some(id);
                    }
                    Action::ArchiveSession { id } => {
                        let s = session_mut(data, &id)?;
                        s.archived = true;
                        s.updated_at = now();
                        data.resume_on_launch.remove(&id);
                        if data.active_session_id.as_deref() == Some(&id) {
                            data.active_session_id = data
                                .sessions
                                .iter()
                                .find(|s| !s.archived)
                                .map(|s| s.id.clone());
                        }
                        stop = Some(id);
                    }
                    Action::SelectSession { id } => {
                        let s = session_mut(data, &id)?;
                        if s.archived {
                            return Err("Archived sessions cannot be selected".into());
                        }
                        s.unread = false;
                        start = Some(id.clone());
                        data.active_session_id = Some(id);
                    }
                    Action::DismissNotification { id } => {
                        data.notifications
                            .iter_mut()
                            .find(|n| n.id == id)
                            .ok_or("Notification does not exist")?
                            .dismissed = true;
                    }
                    Action::OpenNotification { id } => {
                        let sid = data
                            .notifications
                            .iter()
                            .find(|n| n.id == id)
                            .ok_or("Notification does not exist")?
                            .session_id
                            .clone();
                        let s = session_mut(data, &sid)?;
                        s.unread = false;
                        if s.archived {
                            return Err("This notification belongs to an archived tab".into());
                        }
                        start = Some(sid.clone());
                        data.active_session_id = Some(sid);
                    }
                    Action::SaveRule { mut rule } => {
                        rules::validate(&rule)?;
                        if let Some(sid) = &rule.session_id {
                            session_mut(data, sid)?;
                        }
                        if rule.id.is_empty() {
                            rule.id = id();
                        }
                        if rule.enabled && rule.kind != "webhook" && rule.next_run_at.is_none() {
                            rule.next_run_at = Some(
                                now()
                                    + if rule.kind == "reminder" {
                                        (rule.interval_minutes * 60000.0).max(1000.0) as i64
                                    } else {
                                        6000.max((rule.interval_minutes * 60000.0) as i64)
                                    },
                            );
                        }
                        if let Some(r) = data.rules.iter_mut().find(|r| r.id == rule.id) {
                            *r = rule;
                        } else {
                            data.rules.push(rule);
                        }
                    }
                    Action::DeleteRule { id } => {
                        data.rules.retain(|r| r.id != id);
                    }
                    Action::RunRule { id } => {
                        run = Some(id);
                    }
                    Action::Settings { settings } => {
                        if !valid_provider(&settings.default_provider) {
                            return Err("Unknown default provider".into());
                        }
                        data.settings = settings;
                    }
                }
                Ok(())
            })?;
        if let Some(id) = stop {
            self.stop_session(&id, false)?;
        }
        if let Some(id) = start {
            if let Err(error) = self.start_session(&id, false) {
                eprintln!("Relay start failed: {error}");
            }
        }
        if let Some(id) = run {
            rules::run(self, &id, true)?;
        }
        self.emit_state();
        self.snapshot()
    }
    fn restore(self: &Arc<Self>) -> Result<(), String> {
        self.ledger
            .lock()
            .map_err(|_| "Ledger lock poisoned")?
            .change(|d| {
                for s in &mut d.sessions {
                    s.status = "stopped".into();
                }
                d.resume_on_launch.clear();
                d.settings.auto_resume = false;
                Ok(())
            })?;
        self.emit_state();
        Ok(())
    }
    fn quit(&self) -> Result<(), String> {
        let _actions = self.actions.lock().map_err(|_| "Actions lock poisoned")?;
        self.quitting.store(true, Ordering::Relaxed);
        let ids = self
            .live
            .lock()
            .map_err(|_| "PTY lock poisoned")?
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for id in ids {
            self.stop_session(&id, true)?;
        }
        self.ledger
            .lock()
            .map_err(|_| "Ledger lock poisoned")?
            .checkpoint()?;
        let _ = std::fs::remove_file(self.data_dir.join("connection.json"));
        if let Some(app) = &self.app {
            app.exit(0);
        }
        Ok(())
    }
}
fn start_metadata_watch(runtime: &Arc<Runtime>) {
    let weak = Arc::downgrade(runtime);
    std::thread::spawn(move || {
        let mut observed: HashMap<String, std::time::SystemTime> = HashMap::new();
        let mut attempted: HashMap<String, std::time::Instant> = HashMap::new();
        let mut title_index_observed: HashMap<PathBuf, std::time::SystemTime> = HashMap::new();
        while let Some(runtime) = weak.upgrade() {
            if runtime.quitting.load(Ordering::Relaxed) {
                break;
            }
            let live = runtime
                .live
                .lock()
                .map(|l| l.keys().cloned().collect::<HashSet<_>>())
                .unwrap_or_default();
            let data = runtime.ledger.lock().map(|l| l.data.clone()).ok();
            if let Some(data) = data {
                for session in data.sessions.iter().filter(|s| {
                    s.provider == "codex" && s.provider_session_id.is_some() && live.contains(&s.id)
                }) {
                    let home = data.provider_homes.get(&session.id).map(String::as_str);
                    if let Some(index) = codex_index_path(home) {
                        if let Ok(modified) = std::fs::metadata(&index).and_then(|m| m.modified()) {
                            // Check each bound title; an index can serve multiple tabs.
                            if title_index_observed.get(&index) != Some(&modified) {
                                if let Some(title) = codex_title(session, home) {
                                    let _ = runtime.apply_event(HookEvent {
                                        event: "settings".into(),
                                        session_id: Some(session.id.clone()),
                                        expected_provider_session_id: session
                                            .provider_session_id
                                            .clone(),
                                        title: Some(title),
                                        ..Default::default()
                                    });
                                }
                            }
                        }
                    }
                    let known = data.transcripts.get(&session.id).map(String::as_str);
                    if known.is_none()
                        && attempted
                            .get(&session.id)
                            .is_some_and(|at| at.elapsed() < std::time::Duration::from_secs(30))
                    {
                        continue;
                    }
                    attempted.insert(session.id.clone(), std::time::Instant::now());
                    let Some(path) = exact_transcript(session, known) else {
                        continue;
                    };
                    let Ok(modified) = std::fs::metadata(&path).and_then(|m| m.modified()) else {
                        continue;
                    };
                    if observed.get(&session.id) == Some(&modified) {
                        continue;
                    }
                    observed.insert(session.id.clone(), modified);
                    if let Some(mut event) = transcript_settings(&path, session) {
                        event.transcript_path = Some(path.to_string_lossy().into_owned());
                        if let Err(error) = runtime.apply_event(event) {
                            eprintln!("Relay settings capture failed: {error}");
                        }
                    }
                }
                for home in std::iter::once(None)
                    .chain(data.provider_homes.values().map(|s| Some(s.as_str())))
                {
                    if let Some(path) = codex_index_path(home) {
                        if let Ok(modified) = std::fs::metadata(&path).and_then(|m| m.modified()) {
                            title_index_observed.insert(path, modified);
                        }
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    });
}

fn short_title(title: &str) -> Result<String, String> {
    let title = title.trim();
    if title.is_empty() || title.len() > 500 || title.contains('\0') {
        return Err("Choose a short, nonempty title".into());
    }
    Ok(title.into())
}

fn exact_transcript(session: &Session, known: Option<&str>) -> Option<PathBuf> {
    let sid = session.provider_session_id.as_deref()?;
    // A hook path is authoritative only if its filename identifies this bound conversation.
    if let Some(path) = known {
        let path = PathBuf::from(path);
        if path.is_file() && transcript_name_matches(&path, sid) {
            return Some(path);
        }
    }
    let home = directories::BaseDirs::new()?.home_dir().to_path_buf();
    let root = if session.provider == "claude" {
        std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".claude"))
            .join("projects")
    } else {
        std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"))
            .join("sessions")
    };
    find_transcript(&root, sid, 5)
}
fn find_transcript(root: &Path, sid: &str, depth: u8) -> Option<PathBuf> {
    if depth == 0 {
        return None;
    }
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let path = entry.path();
        if path.is_file()
            && path.extension().is_some_and(|e| e == "jsonl")
            && transcript_name_matches(&path, sid)
        {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(found) = find_transcript(&path, sid, depth - 1) {
                return Some(found);
            }
        }
    }
    None
}
fn transcript_name_matches(path: &Path, sid: &str) -> bool {
    path.file_name()
        .map(|name| {
            let name = name.to_string_lossy();
            name == format!("{sid}.jsonl") || name.ends_with(&format!("-{sid}.jsonl"))
        })
        .unwrap_or(false)
}
fn codex_completion_attested(path: &Path, sid: &str, turn: Option<&str>) -> bool {
    use std::io::{BufRead, Read, Seek, SeekFrom};
    let Some(turn) = turn else {
        return false;
    };
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut header = String::new();
    if std::io::BufReader::new((&mut file).take(4 * 1024 * 1024))
        .read_line(&mut header)
        .is_err()
    {
        return false;
    }
    let Ok(meta) = serde_json::from_str::<serde_json::Value>(&header) else {
        return false;
    };
    if meta.get("type").and_then(|v| v.as_str()) != Some("session_meta")
        || meta
            .pointer("/payload/id")
            .or_else(|| meta.pointer("/payload/session_id"))
            .and_then(|v| v.as_str())
            != Some(sid)
        || meta
            .pointer("/payload/source")
            .and_then(|v| v.as_str())
            .is_none_or(|v| !matches!(v, "cli" | "exec"))
        || meta
            .pointer("/payload/thread_source")
            .is_some_and(|v| v.as_str() != Some("user"))
    {
        return false;
    }
    let Ok(size) = file.metadata().map(|m| m.len()) else {
        return false;
    };
    if file
        .seek(SeekFrom::Start(size.saturating_sub(512 * 1024)))
        .is_err()
    {
        return false;
    }
    let mut tail = Vec::new();
    if file.take(512 * 1024).read_to_end(&mut tail).is_err() {
        return false;
    }
    String::from_utf8_lossy(&tail)
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .any(|v| {
            if v.get("type").and_then(|v| v.as_str()) != Some("event_msg") {
                return false;
            }
            let Some(payload) = v.get("payload") else {
                return false;
            };
            let same_turn = payload
                .get("turn_id")
                .or_else(|| payload.get("root_turn_id"))
                .and_then(|v| v.as_str())
                == Some(turn);
            same_turn
                && (payload.get("type").and_then(|v| v.as_str()) == Some("task_complete")
                    || (payload.get("thread_id").and_then(|v| v.as_str()) == Some(sid)
                        && payload.get("type").and_then(|v| v.as_str()) == Some("item_completed")))
        })
}
fn codex_index_path(home: Option<&str>) -> Option<PathBuf> {
    let home = home
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("CODEX_HOME").map(PathBuf::from))
        .or_else(|| directories::BaseDirs::new().map(|d| d.home_dir().join(".codex")))?;
    Some(home.join("session_index.jsonl"))
}
fn codex_title(session: &Session, home: Option<&str>) -> Option<String> {
    use std::io::{BufRead, Read};
    let sid = session.provider_session_id.as_deref()?;
    let file = std::fs::File::open(codex_index_path(home)?).ok()?;
    std::io::BufReader::new(file.take(32 * 1024 * 1024))
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(&line).ok())
        .filter(|v| v.get("id").and_then(|v| v.as_str()) == Some(sid))
        .filter_map(|v| {
            v.get("thread_name")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(str::to_owned)
        })
        .last()
}
fn transcript_settings(path: &Path, session: &Session) -> Option<HookEvent> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(size.saturating_sub(512 * 1024)))
        .ok()?;
    let mut bytes = Vec::new();
    file.take(512 * 1024).read_to_end(&mut bytes).ok()?;
    let tail = String::from_utf8_lossy(&bytes);
    let mut model = None;
    let mut effort = None;
    for line in tail.lines() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if session.provider == "claude" {
                if let Some(value) = v.pointer("/message/model").and_then(|m| m.as_str()) {
                    model = Some(value.to_string());
                }
            }
            if session.provider == "codex"
                && v.get("type").and_then(|t| t.as_str()) == Some("turn_context")
            {
                if let Some(value) = v.pointer("/payload/model").and_then(|m| m.as_str()) {
                    model = Some(value.to_string());
                }
                if let Some(value) = v
                    .pointer("/payload/effort")
                    .or_else(|| v.pointer("/payload/reasoning_effort"))
                    .and_then(|m| m.as_str())
                {
                    effort = Some(value.to_string());
                }
            }
        }
    }
    if model.is_none() && effort.is_none() {
        return None;
    }
    Some(HookEvent {
        event: "settings".into(),
        session_id: Some(session.id.clone()),
        expected_provider_session_id: session.provider_session_id.clone(),
        model,
        effort,
        ..Default::default()
    })
}

#[tauri::command]
fn relay_snapshot(state: tauri::State<'_, Arc<Runtime>>) -> Result<Snapshot, String> {
    state.snapshot()
}
#[tauri::command]
async fn relay_action(
    state: tauri::State<'_, Arc<Runtime>>,
    action: Action,
) -> Result<Snapshot, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.action(action))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn relay_write(
    state: tauri::State<'_, Arc<Runtime>>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    if data.len() > 1024 * 1024 {
        return Err("Terminal input exceeds 1 MiB".into());
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        let mut lives = state.live.lock().map_err(|_| "PTY lock poisoned")?;
        let live = lives
            .get_mut(&session_id)
            .ok_or("Session is stopped; start it first")?;
        live.writer
            .write_all(&data)
            .and_then(|_| live.writer.flush())
            .map_err(|e| e.to_string())?;
        drop(lives);
        let changed = state
            .ledger
            .lock()
            .map_err(|_| "Ledger lock poisoned")?
            .data
            .sessions
            .iter()
            .any(|s| s.id == session_id && (s.unread || s.status == "ready"));
        if changed {
            state
                .ledger
                .lock()
                .map_err(|_| "Ledger lock poisoned")?
                .change(|d| {
                    let s = session_mut(d, &session_id)?;
                    s.unread = false;
                    s.status = "running".into();
                    s.last_activity_at = now();
                    Ok(())
                })?;
            state.emit_state();
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn relay_resize(
    state: tauri::State<'_, Arc<Runtime>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let lives = state.live.lock().map_err(|_| "PTY lock poisoned")?;
    if let Some(live) = lives.get(&session_id) {
        live.master
            .resize(portable_pty::PtySize {
                cols: cols.clamp(2, 500),
                rows: rows.clamp(2, 300),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
fn relay_attach(
    state: tauri::State<'_, Arc<Runtime>>,
    session_id: String,
) -> Result<TerminalReplay, String> {
    state.session(&session_id)?;
    let replay = state.replay_for(&session_id)?;
    let result = replay
        .lock()
        .map_err(|_| "Replay lock poisoned")?
        .snapshot();
    Ok(result)
}
#[tauri::command]
fn relay_connection(
    state: tauri::State<'_, Arc<Runtime>>,
) -> Result<hooks::ConnectionInfo, String> {
    Ok(state
        .connection
        .lock()
        .map_err(|_| "Connection lock poisoned")?
        .clone())
}
#[tauri::command]
async fn relay_quit(state: tauri::State<'_, Arc<Runtime>>) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.quit())
        .await
        .map_err(|e| e.to_string())?
}

fn reveal(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
pub fn run() {
    let mut context = tauri::generate_context!();
    if let Some(data_dir) = std::env::var_os("RELAY_DATA_DIR") {
        context.config_mut().identifier =
            isolated_identifier(&context.config().identifier, Path::new(&data_dir));
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| reveal(app)))
        .setup(|app| {
            let data_dir = std::env::var_os("RELAY_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            let runtime = Runtime::new(data_dir, Some(app.handle().clone()))
                .map_err(std::io::Error::other)?;
            hooks::start(&runtime).map_err(std::io::Error::other)?;
            runtime.restore().map_err(std::io::Error::other)?;
            app.manage(runtime.clone());
            use tauri::{
                menu::{Menu, MenuItem},
                tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
            };
            let open = MenuItem::with_id(app, "open", "Open Relay", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Relay", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let mut tray = TrayIconBuilder::with_id("relay")
                .tooltip("Relay · terminal workspace")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => reveal(app),
                    "quit" => {
                        let runtime = app.state::<Arc<Runtime>>().inner().clone();
                        std::thread::spawn(move || {
                            if let Err(error) = runtime.quit() {
                                eprintln!("Relay quit failed: {error}");
                            }
                        });
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        reveal(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            let restore = runtime.clone();
            std::thread::spawn(move || {
                rules::start(&restore);
                start_metadata_watch(&restore);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            relay_snapshot,
            relay_action,
            relay_write,
            relay_resize,
            relay_attach,
            relay_connection,
            relay_quit
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let runtime = window.state::<Arc<Runtime>>();
                if runtime.quitting.load(Ordering::Relaxed) {
                    return;
                }
                let to_tray = runtime
                    .ledger
                    .lock()
                    .map(|l| l.data.settings.close_to_tray)
                    .unwrap_or(true);
                api.prevent_close();
                if to_tray {
                    let _ = window.hide();
                } else {
                    let runtime = runtime.inner().clone();
                    std::thread::spawn(move || {
                        let _ = runtime.quit();
                    });
                }
            }
        })
        .run(context)
        .expect("Relay could not start");
}

fn isolated_identifier(base: &str, directory: &Path) -> String {
    let absolute = if directory.is_absolute() {
        directory.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(directory)
    };
    let mut normalized = PathBuf::new();
    for part in absolute.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            part => normalized.push(part.as_os_str()),
        }
    }
    let key = normalized.to_string_lossy().into_owned();
    #[cfg(windows)]
    let key = key.to_lowercase();
    let hash = key
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        });
    format!("{base}.data{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn codex_rollout(dir: &Path, id: &str, turns: &[&str], feature: bool) -> PathBuf {
        let path = dir.join(format!("{id}.jsonl"));
        let mut text = serde_json::json!({"type":"session_meta","payload":{"id":id,"source":"cli","thread_source":if feature {serde_json::json!({"feature":"thread_title"})} else {serde_json::json!("user")}}}).to_string();
        for turn in turns {
            text.push('\n');
            text.push_str(&serde_json::json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":turn}}).to_string());
        }
        text.push('\n');
        std::fs::write(&path, text).unwrap();
        path
    }
    #[test]
    fn codex_hidden_title_completion_never_rebinds_but_genuine_new_root_does() {
        let temp = tempfile::tempdir().unwrap();
        let r = Runtime::new(temp.path().into(), None).unwrap();
        let sid = r
            .ledger
            .lock()
            .unwrap()
            .change(|d| {
                d.settings.default_cwd = temp.path().to_string_lossy().into();
                shell::new_terminal(d, "work")
            })
            .unwrap();
        let aux = codex_rollout(temp.path(), "hidden-title", &["aux-turn"], true);
        let auxiliary = hooks::map_payload(
            "ready",
            &serde_json::json!({"thread-id":"hidden-title","turn-id":"aux-turn","transcript_path":aux,"input-messages":["Generate a concise, single-line task title"],"last-assistant-message":"{\"title\":\"Internal title\"}"}),
            Some(sid.clone()),
        );
        r.apply_event(auxiliary.clone()).unwrap();
        assert!(r.session(&sid).unwrap().provider_session_id.is_none());
        assert!(r.snapshot().unwrap().notifications.is_empty());
        let root = codex_rollout(temp.path(), "root-thread", &["user-turn"], false);
        assert!(!codex_completion_attested(
            &root,
            "root-thread",
            Some("other-turn")
        ));
        // A genuine user can request title-shaped JSON; content must not be the filter.
        r.apply_event(hooks::map_payload("ready",&serde_json::json!({"thread-id":"root-thread","turn-id":"user-turn","transcript_path":root,"input-messages":["Generate a concise, single-line task title for my work"],"last-assistant-message":"{\"title\":\"Real answer\"}"}),Some(sid.clone()))).unwrap();
        let before = r.snapshot().unwrap();
        assert_eq!(
            before.sessions[0].provider_session_id.as_deref(),
            Some("root-thread")
        );
        assert_eq!(before.notifications.len(), 1);
        r.apply_event(auxiliary).unwrap();
        let after = r.snapshot().unwrap();
        assert_eq!(after.version, before.version);
        assert_eq!(after.sessions[0].title, before.sessions[0].title);
        assert_eq!(after.sessions[0].status, "ready");
        let new_root = codex_rollout(temp.path(), "new-root-thread", &["new-user-turn"], false);
        r.apply_event(hooks::map_payload("ready",&serde_json::json!({"thread-id":"new-root-thread","turn-id":"new-user-turn","transcript_path":new_root,"last-assistant-message":"New conversation answer"}),Some(sid.clone()))).unwrap();
        assert_eq!(
            r.session(&sid).unwrap().provider_session_id.as_deref(),
            Some("new-root-thread")
        );
        assert_eq!(r.snapshot().unwrap().notifications.len(), 2);
    }
    #[test]
    fn restart_is_dormant_and_selection_attempts_only_the_chosen_tab() {
        let temp = tempfile::tempdir().unwrap();
        let r = Runtime::new(temp.path().into(), None).unwrap();
        r.ledger
            .lock()
            .unwrap()
            .change(|d| {
                d.settings.setup_complete = true;
                d.settings.default_cwd = temp.path().to_string_lossy().into();
                for _ in 0..2 {
                    let sid = shell::new_terminal(d, "work")?;
                    d.resume_on_launch.insert(sid);
                }
                for s in &mut d.sessions {
                    s.status = "running".into();
                    s.executable = "relay-test-missing-shell".into();
                }
                Ok(())
            })
            .unwrap();
        r.restore().unwrap();
        let state = r.snapshot().unwrap();
        assert!(state.sessions.iter().all(|s| s.status == "stopped"));
        assert!(r.live.lock().unwrap().is_empty());
        let chosen = state.sessions[0].id.clone();
        let selected = r
            .action(Action::SelectSession { id: chosen.clone() })
            .unwrap();
        assert_eq!(selected.active_session_id.as_deref(), Some(chosen.as_str()));
        assert_eq!(selected.sessions[0].status, "error");
        assert_eq!(selected.sessions[1].status, "stopped");
        assert!(r.live.lock().unwrap().is_empty());
        assert!(r
            .action(Action::CompleteSetup {
                cwd: temp.path().to_string_lossy().into()
            })
            .is_err());
    }
    #[test]
    fn scoped_shell_cwd_does_not_overwrite_bound_provider_context() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let r = Runtime::new(temp.path().into(), None).unwrap();
        let sid = r
            .ledger
            .lock()
            .unwrap()
            .change(|d| {
                d.settings.default_cwd = temp.path().to_string_lossy().into();
                shell::new_terminal(d, "work")
            })
            .unwrap();
        let rollout = codex_rollout(temp.path(), "exact-thread", &["one", "two"], false);
        r.apply_event(hooks::map_payload("ready", &serde_json::json!({"thread-id":"exact-thread","turn-id":"one","transcript_path":rollout,"cwd":project,"input-messages":["Explain this code"],"last-assistant-message":"Done"}), Some(sid.clone()))).unwrap();
        let first = r.session(&sid).unwrap();
        assert_eq!(first.provider, "codex");
        assert_eq!(first.cwd, project.to_string_lossy());
        assert_eq!(first.title, "Explain this code");
        r.apply_event(HookEvent {
            event: "shell_cwd".into(),
            session_id: Some(sid.clone()),
            cwd: Some(temp.path().to_string_lossy().into()),
            ..Default::default()
        })
        .unwrap();
        let returned = r.session(&sid).unwrap();
        assert_eq!(returned.cwd, first.cwd);
        assert_eq!(returned.shell_cwd, temp.path().to_string_lossy());
        assert_eq!(returned.provider_session_id, first.provider_session_id);
        r.apply_event(hooks::map_payload("ready", &serde_json::json!({"thread-id":"exact-thread","turn-id":"two","input-messages":["A later question"],"last-assistant-message":"Done"}), Some(sid.clone()))).unwrap();
        assert_eq!(r.session(&sid).unwrap().title, "Explain this code");
    }
    #[test]
    fn isolated_identifiers_are_stable_and_separate_data_directories() {
        let base = "dev.relay.workspace";
        assert_eq!(
            isolated_identifier(base, Path::new("isolated/./one")),
            isolated_identifier(base, Path::new("isolated/one"))
        );
        assert_ne!(
            isolated_identifier(base, Path::new("isolated/one")),
            isolated_identifier(base, Path::new("isolated/two"))
        );
    }
    #[test]
    fn stale_transcript_observer_cannot_change_a_fresh_launch() {
        let temp = tempfile::tempdir().unwrap();
        let r = Runtime::new(temp.path().into(), None).unwrap();
        let sid = r
            .ledger
            .lock()
            .unwrap()
            .change(|d| {
                d.settings.default_cwd = temp.path().to_string_lossy().into();
                let sid = shell::new_terminal(d, "work")?;
                let s = session_mut(d, &sid)?;
                s.provider = "codex".into();
                s.provider_session_id = Some("new-thread".into());
                Ok(sid)
            })
            .unwrap();
        let before = r.snapshot().unwrap().version;
        r.apply_event(HookEvent {
            event: "settings".into(),
            session_id: Some(sid.clone()),
            expected_provider_session_id: Some("old-thread".into()),
            model: Some("stale-model".into()),
            effort: Some("stale-effort".into()),
            ..Default::default()
        })
        .unwrap();
        assert!(r.session(&sid).unwrap().model.is_empty());
        assert_eq!(r.snapshot().unwrap().version, before);
    }
    #[test]
    fn notifications_have_durable_own_tabs_read_is_not_dismissal_and_settings_are_noop() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = Runtime::new(temp.path().into(), None).unwrap();
        runtime
            .apply_event(HookEvent {
                event: "notification".into(),
                title: Some("Calendar reminder".into()),
                body: Some("Meeting starts soon".into()),
                source: Some("calendar".into()),
                dedupe_key: Some("meeting1".into()),
                ..Default::default()
            })
            .unwrap();
        let s = runtime.snapshot().unwrap();
        assert_eq!(s.sessions.len(), 1);
        assert_eq!(s.sessions[0].kind, "assistant");
        assert!(s.sessions[0].initial_prompt.contains("Meeting starts soon"));
        runtime
            .ledger
            .lock()
            .unwrap()
            .change(|d| {
                d.sessions[0].executable = "relay-test-missing-cli".into();
                Ok(())
            })
            .unwrap();
        runtime
            .action(Action::OpenNotification {
                id: s.notifications[0].id.clone(),
            })
            .unwrap();
        assert!(!runtime.snapshot().unwrap().notifications[0].dismissed);
        runtime
            .apply_event(HookEvent {
                event: "notification".into(),
                source: Some("calendar".into()),
                dedupe_key: Some("meeting1".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(runtime.snapshot().unwrap().notifications.len(), 1);
        let version = runtime.snapshot().unwrap().version;
        runtime
            .apply_event(HookEvent {
                event: "settings".into(),
                session_id: Some(s.sessions[0].id.clone()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(runtime.snapshot().unwrap().version, version);
        drop(runtime);
        let reopened = Runtime::new(temp.path().into(), None).unwrap();
        assert_eq!(
            reopened.snapshot().unwrap().sessions[0].id,
            s.sessions[0].id
        );
    }
    #[test]
    fn authoritative_binding_rejects_two_tabs_claiming_same_conversation() {
        let temp = tempfile::tempdir().unwrap();
        let r = Runtime::new(temp.path().into(), None).unwrap();
        for title in ["a", "b"] {
            r.apply_event(HookEvent {
                event: "notification".into(),
                title: Some(title.into()),
                ..Default::default()
            })
            .unwrap();
        }
        let sessions = r.snapshot().unwrap().sessions;
        r.apply_event(HookEvent {
            event: "session_start".into(),
            session_id: Some(sessions[0].id.clone()),
            provider_session_id: Some("provider-exact".into()),
            ..Default::default()
        })
        .unwrap();
        assert!(r
            .apply_event(HookEvent {
                event: "session_start".into(),
                session_id: Some(sessions[1].id.clone()),
                provider_session_id: Some("provider-exact".into()),
                ..Default::default()
            })
            .is_err());
        assert!(r.snapshot().unwrap().sessions[1]
            .provider_session_id
            .is_none());
    }
    #[test]
    fn real_pty_streams_output_and_replay_keeps_the_stable_tab_id() {
        let temp = tempfile::tempdir().unwrap();
        let r = Runtime::new(temp.path().into(), None).unwrap();
        #[cfg(windows)]
        let (exe, args) = (
            "powershell.exe",
            vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-Command".into(),
                "[Console]::Write('RELAY_PTY_PROOF'); Start-Sleep -Milliseconds 100; exit 0".into(),
            ],
        );
        #[cfg(unix)]
        let (exe, args) = (
            "/bin/sh",
            vec!["-c".into(), "printf RELAY_PTY_PROOF".into()],
        );
        let snapshot = r
            .action(Action::CreateSession {
                session: CreateSession {
                    group_id: "work".into(),
                    provider: "shell".into(),
                    cwd: temp.path().to_string_lossy().into(),
                    title: Some("PTY test".into()),
                    model: None,
                    effort: None,
                    executable: Some(exe.into()),
                    args: Some(args),
                    initial_prompt: None,
                    kind: None,
                    provider_session_id: None,
                },
            })
            .unwrap();
        let sid = &snapshot.sessions[0].id;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let replay = r.replay_for(sid).unwrap().lock().unwrap().snapshot();
            if String::from_utf8_lossy(&replay.data).contains("RELAY_PTY_PROOF") {
                assert!(replay.sequence > 0);
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "No PTY output; snapshot: {:?}, replay {:?}",
                r.snapshot().unwrap(),
                String::from_utf8_lossy(&replay.data)
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        r.stop_session(sid, false).unwrap();
        assert_eq!(r.snapshot().unwrap().sessions[0].id, *sid);
        assert!(
            r.replay_for(sid)
                .unwrap()
                .lock()
                .unwrap()
                .snapshot()
                .data
                .len()
                > 0
        );
    }
}
