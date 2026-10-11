use super::types::*;
use rusqlite::{Connection, OptionalExtension};
use std::path::Path;

pub struct Ledger {
    connection: Connection,
    pub data: LedgerData,
}
impl Ledger {
    pub fn open(path: &Path) -> Result<Self, String> {
        let connection = Connection::open(path).map_err(|e| e.to_string())?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS relay_state (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS event_dedupe (key TEXT PRIMARY KEY, created_at INTEGER NOT NULL);")
            .map_err(|e| e.to_string())?;
        let raw: Option<String> = connection
            .query_row("SELECT data FROM relay_state WHERE id=1", [], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        let missing = raw.is_none();
        let data = match raw {
            Some(raw) => serde_json::from_str(&raw)
                .map_err(|e| format!("Relay database is unreadable: {e}"))?,
            None => LedgerData::default(),
        };
        let mut ledger = Self { connection, data };
        if missing {
            ledger.change(|_| Ok(()))?;
        }
        Ok(ledger)
    }
    // Clone first: rejected actions and failed writes cannot partially alter live state.
    pub fn change<R>(
        &mut self,
        f: impl FnOnce(&mut LedgerData) -> Result<R, String>,
    ) -> Result<R, String> {
        self.change_event(None, f)
            .map(|r| r.expect("non-deduplicated change"))
    }
    pub fn change_event<R>(
        &mut self,
        dedupe: Option<&str>,
        f: impl FnOnce(&mut LedgerData) -> Result<R, String>,
    ) -> Result<Option<R>, String> {
        let tx = self.connection.transaction().map_err(|e| e.to_string())?;
        if let Some(key) = dedupe {
            let inserted = tx
                .execute(
                    "INSERT OR IGNORE INTO event_dedupe(key,created_at) VALUES(?1,?2)",
                    rusqlite::params![key, now()],
                )
                .map_err(|e| e.to_string())?;
            if inserted == 0 {
                return Ok(None);
            }
        }
        let mut data = self.data.clone();
        let result = f(&mut data)?;
        data.version = data.version.saturating_add(1);
        let json = serde_json::to_string(&data).map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO relay_state(id,schema_version,data) VALUES(1,1,?1) ON CONFLICT(id) DO UPDATE SET data=excluded.data", [json]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        self.data = data;
        Ok(Some(result))
    }
    pub fn checkpoint(&self) -> Result<(), String> {
        self.connection
            .execute_batch("PRAGMA wal_checkpoint(FULL)")
            .map_err(|e| e.to_string())
    }
}
pub fn session_mut<'a>(data: &'a mut LedgerData, id: &str) -> Result<&'a mut Session, String> {
    data.sessions
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or_else(|| "Session does not exist".into())
}
pub fn ensure_provider_id(
    data: &LedgerData,
    own: &str,
    provider: &str,
    id: &str,
) -> Result<(), String> {
    if id.is_empty() || id.len() > 256 || id.chars().any(|c| c.is_control()) {
        return Err("Invalid provider conversation ID".into());
    }
    if data.sessions.iter().any(|s| {
        s.id != own && s.provider == provider && s.provider_session_id.as_deref() == Some(id)
    }) {
        return Err("This conversation already belongs to another Relay tab".into());
    }
    Ok(())
}
pub fn add_notification(data: &mut LedgerData, event: &HookEvent) -> Result<String, String> {
    let timestamp = now();
    let title = event
        .title
        .clone()
        .unwrap_or_else(|| "Assistant notification".into());
    let body = event.body.clone().unwrap_or_default();
    let source = event.source.clone().unwrap_or_else(|| "local".into());
    let session_id = if let Some(session_id) = &event.session_id {
        session_mut(data, session_id)?;
        session_id.clone()
    } else {
        let group_id = match data.groups.iter().find(|g| g.id == "assistants") {
            Some(g) => g.id.clone(),
            None => {
                data.groups.push(Group {
                    id: "assistants".into(),
                    title: "Assistants".into(),
                    collapsed: false,
                });
                "assistants".into()
            }
        };
        let session_id = id();
        data.sessions.push(Session {
            id: session_id.clone(),
            group_id,
            title: title.clone(),
            title_locked: false,
            provider: if matches!(data.settings.default_provider.as_str(), "claude" | "codex") {
                data.settings.default_provider.clone()
            } else {
                "claude".into()
            },
            cwd: data.settings.default_cwd.clone(),
            model: String::new(),
            effort: String::new(),
            executable: String::new(),
            args: vec![],
            provider_session_id: None,
            status: "stopped".into(),
            unread: true,
            archived: false,
            created_at: timestamp,
            updated_at: timestamp,
            last_activity_at: timestamp,
            error: None,
            initial_prompt: format!("Notification from {source}\n\n{title}\n\n{body}"),
            kind: "assistant".into(),
        });
        session_id
    };
    let s = session_mut(data, &session_id)?;
    s.unread = true;
    s.last_activity_at = timestamp;
    s.updated_at = timestamp;
    data.notifications.push(Notification {
        id: id(),
        title,
        body,
        source,
        session_id: session_id.clone(),
        created_at: timestamp,
        dismissed: false,
        dedupe_key: event.dedupe_key.clone(),
    });
    Ok(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_retains_identity_settings_and_notifications() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("relay.db");
        let mut ledger = Ledger::open(&path).unwrap();
        ledger
            .change(|d| {
                d.settings.default_provider = "codex".into();
                add_notification(
                    d,
                    &HookEvent {
                        event: "notification".into(),
                        title: Some("Review ready".into()),
                        body: Some("Saved message".into()),
                        ..Default::default()
                    },
                )?;
                Ok(())
            })
            .unwrap();
        let session_id = ledger.data.sessions[0].id.clone();
        ledger
            .change(|d| {
                let s = session_mut(d, &session_id)?;
                s.provider_session_id = Some("opaque-thread-123".into());
                s.model = "custom-model".into();
                s.effort = "xhigh".into();
                Ok(())
            })
            .unwrap();
        drop(ledger);
        let reopened = Ledger::open(&path).unwrap();
        let s = &reopened.data.sessions[0];
        assert_eq!(s.id, session_id);
        assert_eq!(s.provider_session_id.as_deref(), Some("opaque-thread-123"));
        assert_eq!(s.model, "custom-model");
        assert_eq!(s.effort, "xhigh");
        assert_eq!(reopened.data.notifications[0].body, "Saved message");
    }
    #[test]
    fn dedupe_and_state_commit_share_transaction_and_survive_restart() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("db");
        let mut l = Ledger::open(&path).unwrap();
        assert!(l
            .change_event(Some("event-1"), |d| add_notification(
                d,
                &HookEvent::default()
            ))
            .unwrap()
            .is_some());
        drop(l);
        let mut l = Ledger::open(&path).unwrap();
        assert!(l
            .change_event(Some("event-1"), |_| Err::<(), _>("must not run".into()))
            .unwrap()
            .is_none());
        assert_eq!(l.data.notifications.len(), 1);
        let version = l.data.version;
        assert!(l
            .change_event(Some("event-2"), |d| {
                d.groups.clear();
                Err::<(), _>("rejected".into())
            })
            .is_err());
        assert_eq!(l.data.version, version);
        assert!(!l.data.groups.is_empty());
        assert!(l
            .change_event(Some("event-2"), |_| Ok(()))
            .unwrap()
            .is_some());
    }
}
