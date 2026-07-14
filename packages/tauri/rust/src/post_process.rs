use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{self, BufRead};
use std::path::Path;

#[derive(Serialize)]
struct ErrorEntry {
    t: u64,
    msg: String,
}

#[derive(Serialize)]
struct FailedReqEntry {
    t: u64,
    m: String,
    url: String,
    st: u64,
}

#[derive(Serialize)]
struct NavEntry {
    t: u64,
    to: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionIndex {
    id: String,
    start: u64,
    end: u64,
    dur: u64,
    evts: usize,
    errs: Vec<ErrorEntry>,
    failed_reqs: Vec<FailedReqEntry>,
    navs: Vec<NavEntry>,
    stats: HashMap<String, usize>,
}

pub fn process(session_dir: &Path) -> io::Result<()> {
    let events_path = session_dir.join("events.ndjson");

    if !events_path.exists() {
        return write_empty_index(session_dir);
    }

    let file = fs::File::open(&events_path)?;
    let reader = io::BufReader::new(file);

    let mut events: Vec<Value> = Vec::new();
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(val) = serde_json::from_str::<Value>(&line) {
            events.push(val);
        }
        // skip malformed lines silently (matching TS behavior)
    }

    if events.is_empty() {
        return write_empty_index(session_dir);
    }

    let mut errs: Vec<ErrorEntry> = Vec::new();
    let mut failed_reqs: Vec<FailedReqEntry> = Vec::new();
    let mut navs: Vec<NavEntry> = Vec::new();
    let mut stats: HashMap<String, usize> = HashMap::new();
    let mut net_reqs: HashMap<String, (String, String)> = HashMap::new();

    for event in &events {
        let k = event.get("k").and_then(|v| v.as_str()).unwrap_or("");
        let t = event.get("t").and_then(|v| v.as_u64()).unwrap_or(0);
        let d = event.get("d").unwrap_or(&Value::Null);

        *stats.entry(k.to_string()).or_insert(0) += 1;

        if k == "err" || k == "rej" {
            errs.push(ErrorEntry {
                t,
                msg: d.get("msg").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            });
        }

        if k == "net.req" {
            let id = d.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let m = d.get("m").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let url = d.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
            net_reqs.insert(id, (m, url));
        }

        if k == "net.res" {
            let st = d.get("st").and_then(|v| v.as_u64()).unwrap_or(0);
            if st >= 400 {
                let id = d.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let (m, url) = net_reqs.get(id).cloned().unwrap_or_default();
                failed_reqs.push(FailedReqEntry { t, m, url, st });
            }
        }

        if k == "nav" {
            navs.push(NavEntry {
                t,
                to: d.get("to").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            });
        }
    }

    let start = events.first()
        .and_then(|e| e.get("t"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let end = events.last()
        .and_then(|e| e.get("t"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let session_id = session_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    let index = SessionIndex {
        id: session_id,
        start,
        end,
        dur: end.saturating_sub(start),
        evts: events.len(),
        errs,
        failed_reqs,
        navs,
        stats,
    };

    let json = serde_json::to_string(&index)?;
    fs::write(session_dir.join("index.json"), json)?;

    Ok(())
}

fn write_empty_index(session_dir: &Path) -> io::Result<()> {
    let session_id = session_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    let index = SessionIndex {
        id: session_id,
        start: 0,
        end: 0,
        dur: 0,
        evts: 0,
        errs: Vec::new(),
        failed_reqs: Vec::new(),
        navs: Vec::new(),
        stats: HashMap::new(),
    };

    let json = serde_json::to_string(&index)?;
    fs::write(session_dir.join("index.json"), json)?;
    Ok(())
}

// TODO: Port audio transcription (ffmpeg + whisper) in a future iteration.
// The TS version shells out to ffmpeg and whisper-cpp; the same approach
// can be used here with std::process::Command.

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn write_events(dir: &Path, events: &[Value]) {
        let lines: Vec<String> = events.iter().map(|e| serde_json::to_string(e).unwrap()).collect();
        fs::write(dir.join("events.ndjson"), lines.join("\n") + "\n").unwrap();
    }

    #[test]
    fn generates_index_from_events() {
        let dir = TempDir::new().unwrap();
        let session_dir = dir.path().join("ses_20260328_101530");
        fs::create_dir_all(&session_dir).unwrap();

        let events = vec![
            json!({"t": 1000, "k": "con", "d": {"level": "log"}}),
            json!({"t": 1050, "k": "err", "d": {"msg": "something broke"}}),
            json!({"t": 1100, "k": "nav", "d": {"to": "/dashboard"}}),
        ];
        write_events(&session_dir, &events);

        process(&session_dir).unwrap();

        let index: Value = serde_json::from_str(
            &fs::read_to_string(session_dir.join("index.json")).unwrap()
        ).unwrap();

        assert_eq!(index["id"], "ses_20260328_101530");
        assert_eq!(index["start"], 1000);
        assert_eq!(index["end"], 1100);
        assert_eq!(index["dur"], 100);
        assert_eq!(index["evts"], 3);
        assert_eq!(index["errs"].as_array().unwrap().len(), 1);
        assert_eq!(index["errs"][0]["msg"], "something broke");
        assert_eq!(index["navs"].as_array().unwrap().len(), 1);
        assert_eq!(index["navs"][0]["to"], "/dashboard");
    }

    #[test]
    fn correlates_failed_network_responses() {
        let dir = TempDir::new().unwrap();
        let session_dir = dir.path().join("ses_test");
        fs::create_dir_all(&session_dir).unwrap();

        let events = vec![
            json!({"t": 1000, "k": "net.req", "d": {"id": "r1", "m": "POST", "url": "/api/save"}}),
            json!({"t": 1050, "k": "net.res", "d": {"id": "r1", "st": 500}}),
        ];
        write_events(&session_dir, &events);

        process(&session_dir).unwrap();

        let index: Value = serde_json::from_str(
            &fs::read_to_string(session_dir.join("index.json")).unwrap()
        ).unwrap();

        let failed = index["failedReqs"].as_array().unwrap();
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0]["m"], "POST");
        assert_eq!(failed[0]["url"], "/api/save");
        assert_eq!(failed[0]["st"], 500);
    }

    #[test]
    fn handles_rejection_events() {
        let dir = TempDir::new().unwrap();
        let session_dir = dir.path().join("ses_test");
        fs::create_dir_all(&session_dir).unwrap();

        let events = vec![
            json!({"t": 1000, "k": "rej", "d": {"msg": "unhandled promise"}}),
        ];
        write_events(&session_dir, &events);

        process(&session_dir).unwrap();

        let index: Value = serde_json::from_str(
            &fs::read_to_string(session_dir.join("index.json")).unwrap()
        ).unwrap();

        assert_eq!(index["errs"].as_array().unwrap().len(), 1);
        assert_eq!(index["errs"][0]["msg"], "unhandled promise");
    }

    #[test]
    fn handles_empty_events_file() {
        let dir = TempDir::new().unwrap();
        let session_dir = dir.path().join("ses_test");
        fs::create_dir_all(&session_dir).unwrap();
        fs::write(session_dir.join("events.ndjson"), "").unwrap();

        process(&session_dir).unwrap();

        let index: Value = serde_json::from_str(
            &fs::read_to_string(session_dir.join("index.json")).unwrap()
        ).unwrap();

        assert_eq!(index["evts"], 0);
        assert_eq!(index["start"], 0);
    }

    #[test]
    fn handles_missing_events_file() {
        let dir = TempDir::new().unwrap();
        let session_dir = dir.path().join("ses_test");
        fs::create_dir_all(&session_dir).unwrap();

        process(&session_dir).unwrap();

        let index: Value = serde_json::from_str(
            &fs::read_to_string(session_dir.join("index.json")).unwrap()
        ).unwrap();

        assert_eq!(index["evts"], 0);
    }

    #[test]
    fn skips_malformed_json_lines() {
        let dir = TempDir::new().unwrap();
        let session_dir = dir.path().join("ses_test");
        fs::create_dir_all(&session_dir).unwrap();

        let content = "{\"t\":1000,\"k\":\"con\",\"d\":{}}\nthis is not json\n{\"t\":1001,\"k\":\"err\",\"d\":{\"msg\":\"x\"}}\n";
        fs::write(session_dir.join("events.ndjson"), content).unwrap();

        process(&session_dir).unwrap();

        let index: Value = serde_json::from_str(
            &fs::read_to_string(session_dir.join("index.json")).unwrap()
        ).unwrap();

        assert_eq!(index["evts"], 2);
    }
}
