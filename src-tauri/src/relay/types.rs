use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub title: String,
    pub collapsed: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub group_id: String,
    pub title: String,
    pub title_locked: bool,
    pub provider: String,
    pub cwd: String,
    pub model: String,
    pub effort: String,
    pub executable: String,
    pub args: Vec<String>,
    pub provider_session_id: Option<String>,
    pub status: String,
    pub unread: bool,
    pub archived: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_activity_at: i64,
    pub error: Option<String>,
    pub initial_prompt: String,
    pub kind: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub id: String,
    pub title: String,
    pub body: String,
    pub source: String,
    pub session_id: String,
    pub created_at: i64,
    pub dismissed: bool,
    pub dedupe_key: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    pub title: String,
    pub source: String,
    pub kind: String,
    pub enabled: bool,
    pub interval_minutes: f64,
    pub next_run_at: Option<i64>,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub body: String,
    pub session_id: Option<String>,
    pub last_run_at: Option<i64>,
    pub last_error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub auto_resume: bool,
    pub close_to_tray: bool,
    pub default_cwd: String,
    pub default_provider: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_resume: true,
            close_to_tray: true,
            default_cwd: directories::BaseDirs::new()
                .map(|d| d.home_dir().to_string_lossy().into())
                .unwrap_or_default(),
            default_provider: "claude".into(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerData {
    pub version: u64,
    pub groups: Vec<Group>,
    pub sessions: Vec<Session>,
    pub notifications: Vec<Notification>,
    pub rules: Vec<Rule>,
    pub settings: Settings,
    pub active_session_id: Option<String>,
    #[serde(default)]
    pub resume_on_launch: HashSet<String>,
    #[serde(default)]
    pub prompted: HashSet<String>,
    #[serde(default)]
    pub conversation_started: HashSet<String>,
    #[serde(default)]
    pub transcripts: std::collections::HashMap<String, String>,
}
impl Default for LedgerData {
    fn default() -> Self {
        Self {
            version: 0,
            groups: vec![Group {
                id: "work".into(),
                title: "Workspace".into(),
                collapsed: false,
            }],
            sessions: vec![],
            notifications: vec![],
            rules: vec![],
            settings: Settings::default(),
            active_session_id: None,
            resume_on_launch: HashSet::new(),
            prompted: HashSet::new(),
            conversation_started: HashSet::new(),
            transcripts: Default::default(),
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub version: u64,
    pub groups: Vec<Group>,
    pub sessions: Vec<Session>,
    pub notifications: Vec<Notification>,
    pub rules: Vec<Rule>,
    pub settings: Settings,
    pub active_session_id: Option<String>,
    pub data_dir: String,
    pub hook_endpoint: String,
    pub platform: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSession {
    pub group_id: String,
    pub provider: String,
    pub cwd: String,
    pub title: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub executable: Option<String>,
    pub args: Option<Vec<String>>,
    pub initial_prompt: Option<String>,
    pub kind: Option<String>,
    pub provider_session_id: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    CreateGroup {
        title: String,
    },
    UpdateGroup {
        id: String,
        title: Option<String>,
        collapsed: Option<bool>,
    },
    DeleteGroup {
        id: String,
    },
    CreateSession {
        session: CreateSession,
    },
    UpdateSession {
        id: String,
        title: Option<String>,
        model: Option<String>,
        effort: Option<String>,
        #[serde(rename = "providerSessionId")]
        provider_session_id: Option<String>,
    },
    MoveSession {
        id: String,
        #[serde(rename = "groupId")]
        group_id: String,
        #[serde(rename = "beforeId")]
        before_id: Option<String>,
    },
    StartSession {
        id: String,
    },
    StopSession {
        id: String,
    },
    ArchiveSession {
        id: String,
    },
    SelectSession {
        id: String,
    },
    DismissNotification {
        id: String,
    },
    OpenNotification {
        id: String,
    },
    SaveRule {
        rule: Rule,
    },
    DeleteRule {
        id: String,
    },
    RunRule {
        id: String,
    },
    Settings {
        settings: Settings,
    },
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
    pub session_id: String,
    pub sequence: u64,
    pub data: Vec<u8>,
}
#[derive(Clone, Debug, Serialize)]
pub struct TerminalReplay {
    pub sequence: u64,
    pub data: Vec<u8>,
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HookEvent {
    pub event: String,
    pub session_id: Option<String>,
    pub provider_session_id: Option<String>,
    pub title: Option<String>,
    pub body: Option<String>,
    pub prompt: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub source: Option<String>,
    pub dedupe_key: Option<String>,
    #[serde(default)]
    pub transcript_path: Option<String>,
}
pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn valid_provider(value: &str) -> bool {
    matches!(value, "claude" | "codex" | "shell" | "custom")
}
