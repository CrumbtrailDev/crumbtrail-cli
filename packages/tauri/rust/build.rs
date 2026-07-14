fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .plugin("crumbtrail", tauri_build::InlinedPlugin::default()),
    )
    .expect("failed to run tauri-build");
}
