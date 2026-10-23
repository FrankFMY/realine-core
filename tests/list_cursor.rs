use realine_core::*;
use serde_json::json;
#[test]
fn grouped_provider_cursor_advance_rejects_regression_without_a_second_js_comparer() {
    let plan = ListPlan::new(
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
        },
        ListConfig {
            stream: StreamConfig {
                max_events: 4,
                max_buffer_bytes: 65536,
                max_payload_bytes: 32768,
            },
            max_rows: 2,
            max_retained_bytes: 65536,
        },
    )
    .unwrap();
    let before = Cursor {
        epoch: "db".into(),
        revision: "10".into(),
    };
    assert_eq!(
        plan.advance(
            &before,
            &Cursor {
                revision: "12".into(),
                ..before.clone()
            }
        ),
        Ok(CursorAdvance::Newer)
    );
    assert_eq!(plan.advance(&before, &before), Ok(CursorAdvance::Same));
    assert_eq!(
        plan.advance(
            &before,
            &Cursor {
                revision: "9".into(),
                ..before.clone()
            }
        ),
        Err(ErrorCode::Stale)
    );
    assert_eq!(
        plan.advance(
            &before,
            &Cursor {
                epoch: "new-db".into(),
                revision: "0".into()
            }
        ),
        Ok(CursorAdvance::Epoch)
    );
}
