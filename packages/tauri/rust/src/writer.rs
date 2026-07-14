use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

/// Append events as NDJSON (one compact JSON object per line) to the given file.
/// Creates the file if it does not exist.
pub fn append_ndjson(path: &Path, events: &[Value]) -> io::Result<()> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;

    for event in events {
        serde_json::to_writer(&mut file, event)?;
        file.write_all(b"\n")?;
    }

    Ok(())
}

/// Write raw binary data to the given path.
pub fn write_binary(path: &Path, data: &[u8]) -> io::Result<()> {
    fs::write(path, data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn append_ndjson_creates_file_and_writes_lines() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("events.ndjson");

        let events = vec![
            json!({"t": 1000, "k": "con", "d": {"level": "log"}}),
            json!({"t": 1001, "k": "err", "d": {"msg": "fail"}}),
        ];

        append_ndjson(&path, &events).unwrap();

        let content = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("\"k\":\"con\""));
        assert!(lines[1].contains("\"k\":\"err\""));
    }

    #[test]
    fn append_ndjson_appends_to_existing_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("events.ndjson");

        let batch1 = vec![json!({"t": 1, "k": "a", "d": {}})];
        let batch2 = vec![json!({"t": 2, "k": "b", "d": {}})];

        append_ndjson(&path, &batch1).unwrap();
        append_ndjson(&path, &batch2).unwrap();

        let content = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("\"k\":\"a\""));
        assert!(lines[1].contains("\"k\":\"b\""));
    }

    #[test]
    fn append_ndjson_produces_compact_json() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("events.ndjson");

        let events = vec![json!({"t": 1, "k": "x", "d": {"nested": true}})];
        append_ndjson(&path, &events).unwrap();

        let content = fs::read_to_string(&path).unwrap();
        // Compact JSON has no extra whitespace
        assert!(!content.contains("  "));
        assert!(content.ends_with('\n'));
    }

    #[test]
    fn write_binary_creates_file_with_correct_content() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("screenshot.png");
        let data = vec![0x89, 0x50, 0x4e, 0x47];

        write_binary(&path, &data).unwrap();

        let read_back = fs::read(&path).unwrap();
        assert_eq!(read_back, data);
    }
}
