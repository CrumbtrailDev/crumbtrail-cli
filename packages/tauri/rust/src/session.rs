use serde_json::Value;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::post_process;
use crate::writer;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub struct SessionState {
    output_dir: PathBuf,
    bugs_dir: PathBuf,
    write_lock: Mutex<()>,
}

impl SessionState {
    pub fn new(output_dir: PathBuf) -> Self {
        let bugs_dir = output_dir
            .parent()
            .unwrap_or(&output_dir)
            .join("crumbtrail-bugs");
        fs::create_dir_all(&output_dir).ok();
        fs::create_dir_all(&bugs_dir).ok();
        Self {
            output_dir,
            bugs_dir,
            write_lock: Mutex::new(()),
        }
    }

    fn session_dir(&self, session_id: &str) -> PathBuf {
        self.output_dir.join(session_id)
    }

    fn bug_dir(&self, bug_id: &str) -> io::Result<PathBuf> {
        if !bug_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
        {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid bug id"));
        }
        Ok(self.bugs_dir.join(bug_id))
    }

    pub fn create_session(&self, session_id: &str, metadata: &Value) -> io::Result<()> {
        let session_dir = self.session_dir(session_id);
        fs::create_dir_all(&session_dir)?;
        fs::create_dir_all(session_dir.join("frames"))?;

        let mut meta = match metadata {
            Value::Object(map) => Value::Object(map.clone()),
            _ => Value::Object(serde_json::Map::new()),
        };

        if let Value::Object(ref mut map) = meta {
            map.insert("id".to_string(), Value::String(session_id.to_string()));
            map.insert("start".to_string(), Value::Number(now_ms().into()));
        }

        let json = serde_json::to_string_pretty(&meta)?;
        fs::write(session_dir.join("meta.json"), json)?;

        Ok(())
    }

    pub fn append_events(&self, session_id: &str, events: &[Value]) -> io::Result<()> {
        let _lock = self.write_lock.lock().unwrap();
        let events_path = self.session_dir(session_id).join("events.ndjson");
        writer::append_ndjson(&events_path, events)
    }

    pub fn write_blob(
        &self,
        session_id: &str,
        name: &str,
        data: &[u8],
        _metadata: &Value,
    ) -> io::Result<()> {
        let blob_path = self.session_dir(session_id).join(name);
        writer::write_binary(&blob_path, data)
    }

    pub fn finalize_session(&self, session_id: &str) -> io::Result<()> {
        let session_dir = self.session_dir(session_id);
        let meta_path = session_dir.join("meta.json");

        if meta_path.exists() {
            let content = fs::read_to_string(&meta_path)?;
            let mut meta: Value = serde_json::from_str(&content)?;
            if let Value::Object(ref mut map) = meta {
                map.insert("end".to_string(), Value::Number(now_ms().into()));
            }
            let json = serde_json::to_string_pretty(&meta)?;
            fs::write(&meta_path, json)?;
        }

        post_process::process(&session_dir)?;

        Ok(())
    }

    pub fn flag_bug(&self, report: &Value, events: &[Value]) -> io::Result<()> {
        let bug_id = report
            .get("bugId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing bugId"))?;
        let bug_dir = self.bug_dir(bug_id)?;
        fs::create_dir_all(&bug_dir)?;
        fs::create_dir_all(bug_dir.join("frames"))?;

        let _lock = self.write_lock.lock().unwrap();
        writer::append_ndjson(&bug_dir.join("events.ndjson"), events)?;
        fs::write(
            bug_dir.join("report.json"),
            serde_json::to_string_pretty(report)?,
        )?;

        let flagged_at = report.get("flaggedAt").and_then(|v| v.as_u64()).unwrap_or(now_ms());
        let window_ms = report.get("windowMs").and_then(|v| v.as_u64()).unwrap_or(0);
        let meta = serde_json::json!({
            "id": bug_id,
            "start": flagged_at.saturating_sub(window_ms),
            "end": flagged_at
        });
        fs::write(bug_dir.join("meta.json"), serde_json::to_string_pretty(&meta)?)?;
        post_process::process(&bug_dir)?;
        Ok(())
    }

    pub fn write_bug_voice(&self, bug_id: &str, data: &[u8]) -> io::Result<()> {
        let bug_dir = self.bug_dir(bug_id)?;
        if !bug_dir.exists() {
            return Err(io::Error::new(io::ErrorKind::NotFound, "bug not found"));
        }
        writer::write_binary(&bug_dir.join("voice.webm"), data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn create_session_makes_dir_structure_and_meta() {
        let dir = TempDir::new().unwrap();
        let state = SessionState::new(dir.path().to_path_buf());

        state.create_session("ses_001", &json!({"app": "test"})).unwrap();

        let session_dir = dir.path().join("ses_001");
        assert!(session_dir.exists());
        assert!(session_dir.join("frames").exists());

        let meta: Value = serde_json::from_str(
            &fs::read_to_string(session_dir.join("meta.json")).unwrap()
        ).unwrap();
        assert_eq!(meta["id"], "ses_001");
        assert_eq!(meta["app"], "test");
        assert!(meta["start"].as_u64().unwrap() > 0);
    }

    #[test]
    fn append_events_writes_ndjson() {
        let dir = TempDir::new().unwrap();
        let state = SessionState::new(dir.path().to_path_buf());
        state.create_session("ses_001", &json!({})).unwrap();

        let events = vec![json!({"t": 1, "k": "con", "d": {}})];
        state.append_events("ses_001", &events).unwrap();

        let content = fs::read_to_string(dir.path().join("ses_001/events.ndjson")).unwrap();
        assert!(content.contains("\"k\":\"con\""));
    }

    #[test]
    fn write_blob_writes_binary() {
        let dir = TempDir::new().unwrap();
        let state = SessionState::new(dir.path().to_path_buf());
        state.create_session("ses_001", &json!({})).unwrap();

        state.write_blob("ses_001", "screenshot.png", &[0x89, 0x50], &json!({})).unwrap();

        let data = fs::read(dir.path().join("ses_001/screenshot.png")).unwrap();
        assert_eq!(data, vec![0x89, 0x50]);
    }

    #[test]
    fn finalize_session_updates_meta_end_time() {
        let dir = TempDir::new().unwrap();
        let state = SessionState::new(dir.path().to_path_buf());
        state.create_session("ses_001", &json!({})).unwrap();

        state.finalize_session("ses_001").unwrap();

        let meta: Value = serde_json::from_str(
            &fs::read_to_string(dir.path().join("ses_001/meta.json")).unwrap()
        ).unwrap();
        assert!(meta["end"].as_u64().unwrap() > 0);
    }

    #[test]
    fn finalize_session_generates_index_json() {
        let dir = TempDir::new().unwrap();
        let state = SessionState::new(dir.path().to_path_buf());
        state.create_session("ses_001", &json!({})).unwrap();

        let events = vec![json!({"t": 1000, "k": "con", "d": {}})];
        state.append_events("ses_001", &events).unwrap();

        state.finalize_session("ses_001").unwrap();

        let index: Value = serde_json::from_str(
            &fs::read_to_string(dir.path().join("ses_001/index.json")).unwrap()
        ).unwrap();
        assert_eq!(index["evts"], 1);
    }
}
