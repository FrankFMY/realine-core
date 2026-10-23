use realine_core::{Grant, Scope, Snapshot, Stream, StreamConfig};
use serde_json::json;

fn main() {
    let scope = Scope {
        product: "catalog".into(),
        tenant: "sample".into(),
        resource: "items".into(),
        channel: "changes".into(),
    };
    let mut stream = Stream::new(
        scope.clone(),
        StreamConfig {
            max_events: 4,
            max_buffer_bytes: 4096,
            max_payload_bytes: 1024,
        },
    )
    .unwrap();
    // This local example does not authenticate anyone. A host supplies real grants.
    let sync = stream
        .open(
            Grant {
                scope: scope.clone(),
                actor_id: "reader".into(),
                session_id: "session".into(),
                permission_version: "1".into(),
                expires_at_ms: 1000,
            },
            100,
        )
        .unwrap();
    stream
        .snapshot(
            Snapshot {
                scope,
                generation: sync.generation,
                epoch: "catalog-1".into(),
                revision: "0".into(),
                data: json!({"count": 0}),
            },
            100,
        )
        .unwrap();
    println!("{:?}", stream.take(1, 100).unwrap());
    stream.dispose();
}
