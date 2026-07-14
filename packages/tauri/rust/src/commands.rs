use serde_json::Value;
use tauri::{command, State};

use crate::session::SessionState;

#[command]
pub async fn start_session(
    state: State<'_, SessionState>,
    session_id: String,
    metadata: Value,
) -> Result<(), String> {
    state
        .create_session(&session_id, &metadata)
        .map_err(|e| e.to_string())
}

#[command]
pub async fn end_session(
    state: State<'_, SessionState>,
    session_id: String,
) -> Result<(), String> {
    state
        .finalize_session(&session_id)
        .map_err(|e| e.to_string())
}

#[command]
pub async fn append_events(
    state: State<'_, SessionState>,
    session_id: String,
    events: Vec<Value>,
) -> Result<(), String> {
    state
        .append_events(&session_id, &events)
        .map_err(|e| e.to_string())
}

#[command]
pub async fn write_blob(
    state: State<'_, SessionState>,
    session_id: String,
    name: String,
    data: Vec<u8>,
    metadata: Value,
) -> Result<(), String> {
    state
        .write_blob(&session_id, &name, &data, &metadata)
        .map_err(|e| e.to_string())
}

#[command]
pub async fn flag_bug(
    state: State<'_, SessionState>,
    report: Value,
    events: Vec<Value>,
) -> Result<(), String> {
    state
        .flag_bug(&report, &events)
        .map_err(|e| e.to_string())
}

#[command]
pub async fn write_bug_voice(
    state: State<'_, SessionState>,
    bug_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    state
        .write_bug_voice(&bug_id, &data)
        .map_err(|e| e.to_string())
}
