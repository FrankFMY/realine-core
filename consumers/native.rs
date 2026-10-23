use realine_core::*;
use serde_json::{Value, json};
use std::{cell::Cell, fs, path::PathBuf, rc::Rc, time::Instant};
mod lists;

struct Authority {
    allowed: Rc<Cell<bool>>,
    grant: Grant,
}
impl PresenceAuthority for Authority {
    fn current(&mut self, scope: &Scope, key: &PresenceKey, _: u64) -> Result<Grant, ErrorCode> {
        if !self.allowed.get()
            || scope != &self.grant.scope
            || key.actor_id != self.grant.actor_id
            || key.session_id != self.grant.session_id
        {
            return Err(ErrorCode::Denied);
        }
        Ok(self.grant.clone())
    }
}

struct FileStorage {
    path: PathBuf,
    allowed: Rc<Cell<bool>>,
    lose_ack: bool,
}
impl PresenceStorage for FileStorage {
    fn store(&mut self, grant: &Grant, observation: &PreparedPresence) -> Result<(), ErrorCode> {
        if !self.allowed.get() || grant.scope != observation.view.scope {
            return Err(ErrorCode::Denied);
        }
        let mut entries: Vec<PreparedPresence> = if self.path.exists() {
            serde_json::from_slice(&fs::read(&self.path).map_err(|_| ErrorCode::Storage)?)
                .map_err(|_| ErrorCode::Storage)?
        } else {
            vec![]
        };
        if let Some(previous) = entries
            .iter()
            .find(|entry| entry.ticket == observation.ticket)
        {
            if previous != observation {
                return Err(ErrorCode::Storage);
            }
        } else {
            entries.push(observation.clone());
        }
        let bytes = serde_json::to_vec(&entries).map_err(|_| ErrorCode::Storage)?;
        let next = self.path.with_extension("next");
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&next)
            .map_err(|_| ErrorCode::Storage)?;
        file.write_all(&bytes).map_err(|_| ErrorCode::Storage)?;
        file.sync_all().map_err(|_| ErrorCode::Storage)?;
        fs::rename(next, &self.path).map_err(|_| ErrorCode::Storage)?;
        if self.lose_ack {
            self.lose_ack = false;
            return Err(ErrorCode::Storage);
        }
        Ok(())
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert_eq!(args.len(), 3, "scenario path and owned directory required");
    let owned = PathBuf::from(&args[2]);
    assert!(
        owned.join(".realine-owned").is_file(),
        "owned fixture marker required"
    );
    let fixture: Value = serde_json::from_slice(&fs::read(&args[1]).unwrap()).unwrap();
    let list_trace = lists::run(
        serde_json::from_slice(
            &fs::read(std::path::Path::new(&args[1]).with_file_name("list-scenarios.json"))
                .unwrap(),
        )
        .unwrap(),
    );
    let scope: Scope = serde_json::from_value(fixture["scope"].clone()).unwrap();
    let config: StreamConfig = serde_json::from_value(fixture["config"].clone()).unwrap();
    let grant: Grant = serde_json::from_value(fixture["grant"].clone()).unwrap();
    let key: PresenceKey = serde_json::from_value(fixture["key"].clone()).unwrap();
    let presence_config: PresenceConfig =
        serde_json::from_value(fixture["presence_config"].clone()).unwrap();
    let mut stream = JsonStream::new(scope.clone(), config).unwrap();
    let mut presence = JsonPresence::new(scope.clone(), key.clone(), presence_config).unwrap();
    let stream_trace: Vec<Value> = fixture["stream"]
        .as_array()
        .unwrap()
        .iter()
        .map(|input| serde_json::from_str(&stream.call(&input.to_string())).unwrap())
        .collect();
    let presence_trace: Vec<Value> = fixture["presence"]
        .as_array()
        .unwrap()
        .iter()
        .map(|input| serde_json::from_str(&presence.call(&input.to_string())).unwrap())
        .collect();
    assert_eq!(
        stream_trace[5]["value"]["result"]["received"]["reason"],
        "gap"
    );
    assert_eq!(
        stream_trace[10]["value"]["result"]["received"]["reason"],
        "overflow"
    );
    assert_eq!(stream_trace[15]["code"], "stale");
    assert_eq!(stream_trace[23]["value"]["view"]["state"], "disposed");
    assert_eq!(presence_trace[1]["value"]["view"]["state"], "active");
    assert_eq!(presence_trace[4]["code"], "denied");

    let path = owned.join("journal.json");
    assert!(!path.exists(), "native fixture must start with new storage");
    let allowed = Rc::new(Cell::new(true));
    let core = Presence::new(scope.clone(), key, presence_config).unwrap();
    let mut host = PresenceHost::new(
        core,
        Authority {
            allowed: allowed.clone(),
            grant: grant.clone(),
        },
        FileStorage {
            path: path.clone(),
            allowed: allowed.clone(),
            lose_ack: false,
        },
    );
    assert_eq!(
        host.observe(PresenceSignal::Active, 100).unwrap().state,
        PresenceState::Active
    );
    host.storage.lose_ack = true;
    assert_eq!(
        host.observe(PresenceSignal::Idle, 110),
        Err(ErrorCode::Storage)
    );
    let exact = host.core().pending().unwrap();
    assert_eq!(host.retry(112).unwrap().state, PresenceState::Idle);
    let stored: Vec<PreparedPresence> = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(stored.len(), 2);
    assert_eq!(stored[1], exact);
    let before = fs::read(&path).unwrap();
    allowed.set(false);
    assert_eq!(
        host.observe(PresenceSignal::Active, 113),
        Err(ErrorCode::Denied)
    );
    assert_eq!(host.core().view().state, PresenceState::Offline);
    assert_eq!(fs::read(&path).unwrap(), before);

    let iterations = 10_000_u32;
    let mut bench = Stream::new(
        scope.clone(),
        StreamConfig {
            max_events: 4,
            max_buffer_bytes: 2048,
            max_payload_bytes: 512,
        },
    )
    .unwrap();
    let request = bench.open(grant, 100).unwrap();
    bench
        .snapshot(
            Snapshot {
                scope: scope.clone(),
                generation: request.generation,
                epoch: "bench".into(),
                revision: "0".into(),
                data: json!({"count": 0}),
            },
            100,
        )
        .unwrap();
    bench.take(4, 100).unwrap();
    let started = Instant::now();
    for i in 1..=iterations {
        assert_eq!(
            bench.event(
                Event {
                    scope: scope.clone(),
                    generation: request.generation,
                    epoch: "bench".into(),
                    previous: (i - 1).to_string(),
                    revision: i.to_string(),
                    data: json!({"count": i})
                },
                100
            ),
            Ok(Receive::Accepted)
        );
        std::hint::black_box(bench.take(1, 100).unwrap());
    }
    let elapsed_ns = started.elapsed().as_nanos();
    assert_eq!(
        bench.view().cursor.unwrap().revision,
        iterations.to_string()
    );
    println!(
        "{}",
        json!({ "stream": stream_trace, "presence": presence_trace,"lists":list_trace,
        "native_storage": { "entries": stored.len(), "lost_ack_exact": true, "fresh_file_read": true, "denial_unchanged": true },
        "native_timing": { "iterations": iterations, "elapsed_ns": elapsed_ns, "ns_per_event_and_take": elapsed_ns as f64 / iterations as f64 } })
    );
}
