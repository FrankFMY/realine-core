use realine_core::*;
use serde_json::json;
fn request() -> ListRequest {
    ListRequest {
        query: ListQuery {
            scope: Scope {
                product: "ide".into(),
                tenant: "a".into(),
                resource: "projects".into(),
                channel: "list".into(),
            },
            projection: "names".into(),
            access: "member".into(),
            filter: json!({}),
            sort: vec![],
            limit: 2,
        },
        after: None,
    }
}
fn config() -> ListConfig {
    ListConfig {
        stream: StreamConfig {
            max_events: 4,
            max_buffer_bytes: 65536,
            max_payload_bytes: 32768,
        },
        max_rows: 2,
        max_retained_bytes: 65536,
    }
}
#[test]
fn provider_pages_obey_the_complete_wire_depth_and_composite_binding_budget() {
    let plan = ListPlan::new(request(), config()).unwrap();
    let cursor = Cursor {
        epoch: "db".into(),
        revision: "1".into(),
    };
    let mut deep = json!(null);
    for _ in 0..30 {
        deep = serde_json::Value::Array(vec![deep]);
    }
    assert_eq!(
        plan.page(
            &cursor,
            vec![ListRow {
                id: "a".into(),
                revision: "1".into(),
                value: deep
            }],
            false
        ),
        Err(ErrorCode::PayloadTooLarge)
    );
    let mut too_large = config();
    too_large.stream.max_buffer_bytes = 2097152;
    too_large.stream.max_payload_bytes = 1048576;
    assert!(matches!(
        ListPlan::new(request(), too_large),
        Err(ErrorCode::InvalidConfig)
    ));
}
