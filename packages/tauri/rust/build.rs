const COMMANDS: &[&str] = &[
    "start_session",
    "end_session",
    "append_events",
    "write_blob",
    "flag_bug",
    "write_bug_voice",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
