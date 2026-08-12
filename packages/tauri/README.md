# tauri-plugin-crumbtrail

The Rust half of [Crumbtrail](https://crumbtrail.ai)'s Tauri v2 support,
published to crates.io. It receives capture events over native IPC and writes
them to disk, so a desktop app needs no separate server process.

The JavaScript half is **`crumbtrail-core/tauri`**, a subpath of
[`crumbtrail-core`](../core). There is no `crumbtrail-tauri` npm package: the
transport is 58 lines and did not earn a package of its own.

## Setup

### 1. Rust side

Add the plugin to your `src-tauri/Cargo.toml`:

```toml
[dependencies]
tauri-plugin-crumbtrail = "0.1"
```

Register it in `src-tauri/src/lib.rs` (the Tauri v2 CLI scaffold's `run()`
entry point — `src-tauri/src/main.rs` just calls that `run()` and does not
build the `tauri::Builder` itself, so the plugin is registered here, not in
`main.rs`):

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_crumbtrail::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 2. Permissions

Add to `src-tauri/capabilities/default.json`:

```json
{
  "permissions": ["crumbtrail:default"]
}
```

Skip this and every Crumbtrail `invoke` fails.

### 3. JavaScript side

```bash
npm install crumbtrail-core
```

```typescript
import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";
import { TauriTransport } from "crumbtrail-core/tauri";

const logger = Crumbtrail.init({
  ...PRESET_PASSIVE,
  transportInstance: new TauriTransport(),
});

// Use as normal
logger.mark("app-ready");

// When done
await logger.stop();
```

Or let the wizard do all three steps it can:

```bash
npx crumbtrail
```

The wizard injects the JavaScript side and then prints the two Rust steps,
which it cannot perform for you.

## How it works

`TauriTransport` implements `CrumbtrailTransport` using Tauri's `invoke()` IPC
instead of HTTP `fetch()`. Events flow directly to the Rust backend, which
handles:

- **Session management** — creates session directories, writes `meta.json`
- **NDJSON writing** — appends events to `events.ndjson`
- **Blob storage** — writes binary files (screenshots, video chunks)
- **Post-processing** — generates `index.json` with error, request and
  navigation summaries

## Session storage

Sessions are stored at:

```
<app_data_dir>/crumbtrail-sessions/<session_id>/
├── meta.json
├── events.ndjson
├── index.json
├── frames/
└── (blobs)
```

On macOS: `~/Library/Application Support/<bundle-id>/crumbtrail-sessions/`

## MCP compatibility

The MCP server from `crumbtrail-node` reads session directories directly. Point
it at the same output path to use MCP tools with Tauri-captured sessions:

```bash
crumbtrail-server --output ~/Library/Application\ Support/<bundle-id>/crumbtrail-sessions
```

## Requirements

- Tauri v2
- Rust toolchain (rustup)

## Links

- **Website** — https://crumbtrail.ai
- **Docs** — https://crumbtrail.ai/docs
- **How it works** — https://crumbtrail.ai/how-it-works
- **Source** — https://github.com/CrumbtrailDev/crumbtrail-cli
- **Issues** — https://github.com/CrumbtrailDev/crumbtrail-cli/issues

## License

MIT
