use serde_json::Value;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::post_process;
use crate::writer;

/// Longest accepted path segment. Comfortably above any id or blob name the SDK
/// produces, and below the 255 byte component limit every target filesystem enforces.
const MAX_SEGMENT_LEN: usize = 128;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Every id and file name reaching this module comes from the webview, so any
/// content or script running there chooses it. Validate each one as a single
/// path segment before it is joined onto a base directory, and reject anything
/// that fails: sanitising instead would silently map two distinct sessions onto
/// one directory.
///
/// A charset check alone is not enough. `..` is made only of accepted characters,
/// and `Path::join` with an absolute argument discards the base path entirely, so
/// an absolute string escapes with no `..` in it at all.
fn validate_segment(segment: &str, what: &str) -> io::Result<()> {
    let reject = |reason: &str| {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid {what}: {reason}"),
        ))
    };

    if segment.is_empty() {
        return reject("empty");
    }
    if segment.len() > MAX_SEGMENT_LEN {
        return reject("too long");
    }
    if segment == "." || segment == ".." {
        return reject("relative path segment");
    }
    if !segment
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return reject("disallowed character");
    }

    // Belt and braces: the charset above already excludes separators, drive
    // prefixes and NUL, but the parse is what actually proves the result is one
    // ordinary component rather than a root, a prefix, or a traversal.
    let path = Path::new(segment);
    if path.is_absolute() || path.has_root() {
        return reject("absolute path");
    }
    let mut components = path.components();
    match components.next() {
        Some(std::path::Component::Normal(_)) => {}
        _ => return reject("not a plain path segment"),
    }
    if components.next().is_some() {
        return reject("more than one path segment");
    }

    Ok(())
}

/// Take the write lock, recovering the guard if a previous holder panicked.
///
/// `lock().unwrap()` on a poisoned mutex panics, and because the poison is
/// permanent that turns one panicked write into every later write failing for
/// the life of the process. A poisoned lock guards no data of its own here, so
/// recovering it degrades capture for the panicked write only rather than
/// ending capture entirely.
fn write_guard(lock: &Mutex<()>) -> MutexGuard<'_, ()> {
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
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

    fn session_dir(&self, session_id: &str) -> io::Result<PathBuf> {
        validate_segment(session_id, "session id")?;
        Ok(self.output_dir.join(session_id))
    }

    fn bug_dir(&self, bug_id: &str) -> io::Result<PathBuf> {
        validate_segment(bug_id, "bug id")?;
        Ok(self.bugs_dir.join(bug_id))
    }

    pub fn create_session(&self, session_id: &str, metadata: &Value) -> io::Result<()> {
        let session_dir = self.session_dir(session_id)?;
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
        let events_path = self.session_dir(session_id)?.join("events.ndjson");
        let _lock = write_guard(&self.write_lock);
        writer::append_ndjson(&events_path, events)
    }

    pub fn write_blob(
        &self,
        session_id: &str,
        name: &str,
        data: &[u8],
        _metadata: &Value,
    ) -> io::Result<()> {
        validate_segment(name, "blob name")?;
        let blob_path = self.session_dir(session_id)?.join(name);
        writer::write_binary(&blob_path, data)
    }

    pub fn finalize_session(&self, session_id: &str) -> io::Result<()> {
        let session_dir = self.session_dir(session_id)?;
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

        let _lock = write_guard(&self.write_lock);
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

    // Path traversal regressions. Every id and blob name below is reachable from
    // the webview through the commands in `commands.rs`, all of which
    // `permissions/default.toml` grants by default.

    /// Ids and names that must never reach the filesystem. `..` and `.` pass a
    /// charset check unchanged; an absolute path escapes with no `..` at all,
    /// because `Path::join` with an absolute argument replaces the base entirely.
    fn escaping_segments() -> Vec<&'static str> {
        vec![
            "..",
            ".",
            "",
            "../evil",
            "../../etc/passwd",
            "..\\..\\windows",
            "/etc/passwd",
            "/tmp/evil",
            "C:\\Windows\\System32",
            "\\\\server\\share",
            "sub/dir",
            "ses\0null",
        ]
    }

    #[test]
    fn validate_segment_accepts_ordinary_ids() {
        for ok in ["ses_001", "ses-20260904.120000", "a", "bug_1.2.3-rc1"] {
            validate_segment(ok, "test").unwrap_or_else(|e| panic!("{ok} rejected: {e}"));
        }
    }

    #[test]
    fn validate_segment_rejects_every_escape_shape() {
        for bad in escaping_segments() {
            let err = validate_segment(bad, "test")
                .expect_err(&format!("{bad:?} was accepted"));
            assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        }
    }

    #[test]
    #[allow(clippy::join_absolute_paths)]
    fn validate_segment_rejects_absolute_path_specifically() {
        // Distinct from the traversal cases: no `..` anywhere, yet
        // `base.join("/tmp/evil")` yields `/tmp/evil` and abandons `base`.
        let base = PathBuf::from("/var/app/sessions");
        assert_eq!(base.join("/tmp/evil"), PathBuf::from("/tmp/evil"));
        validate_segment("/tmp/evil", "test").unwrap_err();
    }

    #[test]
    fn validate_segment_rejects_overlong_id() {
        let long = "a".repeat(MAX_SEGMENT_LEN + 1);
        validate_segment(&long, "test").unwrap_err();
        validate_segment(&"a".repeat(MAX_SEGMENT_LEN), "test").unwrap();
    }

    /// Nothing outside the session root may be created, whichever command is used.
    fn assert_nothing_escaped(root: &TempDir) {
        let outside = root.path().parent().unwrap();
        for stray in ["evil", "evil.ndjson", "pwned.png", "etc"] {
            assert!(
                !outside.join(stray).exists(),
                "{stray} was written outside the session root"
            );
        }
    }

    #[test]
    fn create_session_rejects_escaping_session_id() {
        let root = TempDir::new().unwrap();
        let state = SessionState::new(root.path().join("sessions"));
        for bad in escaping_segments() {
            state
                .create_session(bad, &json!({}))
                .expect_err(&format!("create_session accepted {bad:?}"));
        }
        assert_nothing_escaped(&root);
    }

    #[test]
    fn append_events_rejects_escaping_session_id() {
        let root = TempDir::new().unwrap();
        let state = SessionState::new(root.path().join("sessions"));
        let events = vec![json!({"t": 1, "k": "con", "d": {}})];
        for bad in escaping_segments() {
            state
                .append_events(bad, &events)
                .expect_err(&format!("append_events accepted {bad:?}"));
        }
        assert_nothing_escaped(&root);
    }

    #[test]
    fn finalize_session_rejects_escaping_session_id() {
        let root = TempDir::new().unwrap();
        let state = SessionState::new(root.path().join("sessions"));
        for bad in escaping_segments() {
            state
                .finalize_session(bad)
                .expect_err(&format!("finalize_session accepted {bad:?}"));
        }
        assert_nothing_escaped(&root);
    }

    #[test]
    fn write_blob_rejects_escaping_blob_name() {
        let root = TempDir::new().unwrap();
        let state = SessionState::new(root.path().join("sessions"));
        state.create_session("ses_001", &json!({})).unwrap();
        for bad in escaping_segments() {
            state
                .write_blob("ses_001", bad, b"pwned", &json!({}))
                .expect_err(&format!("write_blob accepted name {bad:?}"));
        }
        assert_nothing_escaped(&root);
    }

    #[test]
    fn write_blob_rejects_absolute_blob_name() {
        let root = TempDir::new().unwrap();
        let target = root.path().join("absolute-target.png");
        let state = SessionState::new(root.path().join("sessions"));
        state.create_session("ses_001", &json!({})).unwrap();

        // No `..` in this name. Without validation `session_dir.join(name)`
        // discards the session directory and writes straight to `target`.
        state
            .write_blob("ses_001", target.to_str().unwrap(), b"pwned", &json!({}))
            .unwrap_err();
        assert!(!target.exists());
    }

    #[test]
    fn write_blob_rejects_escaping_session_id() {
        let root = TempDir::new().unwrap();
        let state = SessionState::new(root.path().join("sessions"));
        for bad in escaping_segments() {
            state
                .write_blob(bad, "screenshot.png", b"pwned", &json!({}))
                .expect_err(&format!("write_blob accepted session id {bad:?}"));
        }
        assert_nothing_escaped(&root);
    }

    #[test]
    fn flag_bug_rejects_escaping_bug_id() {
        let root = TempDir::new().unwrap();
        let state = SessionState::new(root.path().join("sessions"));
        for bad in escaping_segments() {
            state
                .flag_bug(&json!({"bugId": bad}), &[])
                .expect_err(&format!("flag_bug accepted {bad:?}"));
        }
        assert_nothing_escaped(&root);
    }

    #[test]
    fn write_bug_voice_rejects_escaping_bug_id() {
        let root = TempDir::new().unwrap();
        let state = SessionState::new(root.path().join("sessions"));
        for bad in escaping_segments() {
            state
                .write_bug_voice(bad, b"pwned")
                .expect_err(&format!("write_bug_voice accepted {bad:?}"));
        }
        assert_nothing_escaped(&root);
    }

    #[test]
    fn valid_ids_still_write_inside_their_own_directories() {
        let root = TempDir::new().unwrap();
        let sessions = root.path().join("sessions");
        let state = SessionState::new(sessions.clone());

        state.create_session("ses_001", &json!({})).unwrap();
        state.write_blob("ses_001", "frames.0001.png", &[1, 2], &json!({})).unwrap();
        state.flag_bug(&json!({"bugId": "bug_1"}), &[]).unwrap();

        assert!(sessions.join("ses_001/frames.0001.png").exists());
        assert!(root.path().join("crumbtrail-bugs/bug_1/report.json").exists());
    }

    #[test]
    fn write_guard_recovers_from_a_poisoned_lock() {
        // A panic while holding the lock must degrade one write, not end capture
        // for the life of the process.
        let lock = std::sync::Arc::new(Mutex::new(()));
        let poisoner = std::sync::Arc::clone(&lock);
        let _ = std::thread::spawn(move || {
            let _held = poisoner.lock().unwrap();
            panic!("capture write panicked");
        })
        .join();

        assert!(lock.is_poisoned());
        let _recovered = write_guard(&lock);
    }

    #[test]
    fn capture_continues_after_a_poisoned_write_lock() {
        let dir = TempDir::new().unwrap();
        let state = std::sync::Arc::new(SessionState::new(dir.path().to_path_buf()));
        state.create_session("ses_001", &json!({})).unwrap();

        let poisoner = std::sync::Arc::clone(&state);
        let _ = std::thread::spawn(move || {
            let _held = write_guard(&poisoner.write_lock);
            panic!("capture write panicked");
        })
        .join();

        assert!(state.write_lock.is_poisoned());
        state
            .append_events("ses_001", &[json!({"t": 2, "k": "con", "d": {}})])
            .expect("capture must survive a poisoned write lock");

        let content = fs::read_to_string(dir.path().join("ses_001/events.ndjson")).unwrap();
        assert!(content.contains("\"k\":\"con\""));
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
