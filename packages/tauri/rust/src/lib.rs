use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod commands;
mod post_process;
mod session;
mod writer;

pub use session::SessionState;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("crumbtrail")
        .invoke_handler(tauri::generate_handler![
            commands::start_session,
            commands::end_session,
            commands::append_events,
            commands::write_blob,
            commands::flag_bug,
            commands::write_bug_voice,
        ])
        .setup(|app, _api| {
            let output_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir")
                .join("crumbtrail-sessions");

            app.manage(session::SessionState::new(output_dir));
            Ok(())
        })
        .build()
}
