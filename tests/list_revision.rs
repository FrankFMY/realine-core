use realine_core::*;
use serde_json::json;
#[test]
fn a_same_epoch_resync_cannot_regress_an_observed_record_revision() {
    let scope = Scope {
        product: "ide".into(),
        tenant: "a".into(),
        resource: "projects".into(),
        channel: "list".into(),
    };
    let request = ListRequest {
        query: ListQuery {
            scope: scope.clone(),
            projection: "names".into(),
            access: "member".into(),
            filter: json!({}),
            sort: vec![],
            limit: 2,
        },
        after: None,
    };
    let config = ListConfig {
        stream: StreamConfig {
            max_events: 4,
            max_buffer_bytes: 65536,
            max_payload_bytes: 32768,
        },
        max_rows: 2,
        max_retained_bytes: 65536,
    };
    let grant = Grant {
        scope: scope.clone(),
        actor_id: "actor".into(),
        session_id: "session".into(),
        permission_version: "1".into(),
        expires_at_ms: 10000,
    };
    let mut window = ListWindow::new(request, config).unwrap();
    let first = window.open(grant.clone(), 1).unwrap();
    let snapshot = |generation, revision, record_revision, key: String| Snapshot {
        scope: scope.clone(),
        generation,
        epoch: "db".into(),
        revision,
        data: serde_json::to_value(ListPage {
            request_key: key,
            rows: vec![ListRow {
                id: "a".into(),
                revision: record_revision,
                value: json!({"name":"A"}),
            }],
            next: None,
        })
        .unwrap(),
    };
    window
        .snapshot(
            snapshot(first.generation, "10".into(), "2".into(), window.key()),
            2,
        )
        .unwrap();
    window.disconnect();
    let next = window.open(grant, 3).unwrap();
    assert_eq!(
        window.snapshot(
            snapshot(next.generation, "12".into(), "1".into(), window.key()),
            4
        ),
        Err(ErrorCode::InvalidRevision)
    );
    assert!(window.view().slots.iter().all(|slot| slot.row.is_none()));
}
