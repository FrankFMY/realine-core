use realine_core::*;
use serde_json::json;

fn request() -> ListRequest {
    ListRequest {
        query: ListQuery {
            scope: Scope {
                product: "workbench".into(),
                tenant: "company-a".into(),
                resource: "fleet".into(),
                channel: "vehicles".into(),
            },
            projection: "public-v1".into(),
            access: "dispatchers-v3".into(),
            filter: json!({"active": true}),
            sort: vec![ListSort {
                field: "name".into(),
                direction: SortDirection::Asc,
                missing: MissingPosition::Last,
            }],
            limit: 3,
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
        max_rows: 3,
        max_retained_bytes: 65536,
    }
}
fn grant() -> Grant {
    Grant {
        scope: request().query.scope,
        actor_id: "operator".into(),
        session_id: "session".into(),
        permission_version: "3".into(),
        expires_at_ms: 10000,
    }
}
fn row(id: &str, revision: &str, value: serde_json::Value) -> ListRow {
    ListRow {
        id: id.into(),
        revision: revision.into(),
        value,
    }
}
fn baseline(window: &ListWindow, sync: &SyncRequest, rows: Vec<ListRow>) -> Snapshot {
    Snapshot {
        scope: sync.scope.clone(),
        generation: sync.generation,
        epoch: "db-1".into(),
        revision: "10".into(),
        data: serde_json::to_value(ListPage {
            request_key: window.key(),
            rows,
            next: None,
        })
        .unwrap(),
    }
}
fn change(
    window: &ListWindow,
    sync: &SyncRequest,
    upserts: Vec<ListRow>,
    order: &[&str],
    departures: Vec<ListDeparture>,
) -> Event {
    Event {
        scope: sync.scope.clone(),
        generation: sync.generation,
        epoch: "db-1".into(),
        previous: "10".into(),
        revision: "12".into(),
        data: serde_json::to_value(ListPatch {
            request_key: window.key(),
            upserts,
            departures,
            order: order.iter().map(|s| s.to_string()).collect(),
            next: None,
        })
        .unwrap(),
    }
}
#[test]
fn in_place_update_materializes_exact_json_without_replacing_the_visible_slot() {
    let mut window = ListWindow::new(request(), config()).unwrap();
    let sync = window.open(grant(), 1).unwrap();
    let first = row(
        "vehicle-a",
        "1",
        json!({"name":"A", "available":false, "load":0, "note":null}),
    );
    let second = row("vehicle-b", "1", json!({"name":"B"}));
    window
        .snapshot(baseline(&window, &sync, vec![first, second.clone()]), 2)
        .unwrap();
    let updated = row(
        "vehicle-a",
        "2",
        json!({"name":"A", "available":false, "load":0}),
    );
    window
        .event(
            change(
                &window,
                &sync,
                vec![updated.clone()],
                &["vehicle-a", "vehicle-b"],
                vec![],
            ),
            3,
        )
        .unwrap();
    let view = window.view();
    assert_eq!(
        view.slots.len(),
        2,
        "a live page must materialize its stable slots"
    );
    assert_eq!(view.slots[0].row, Some(updated));
    assert_eq!(view.slots[1].row, Some(second));
    assert!(!view.slots[0].moved);
}

#[test]
fn query_identity_binds_authority_projection_filter_sort_and_page_size() {
    let key = ListWindow::new(request(), config()).unwrap().key();
    let mut variants = vec![];
    let mut q = request();
    q.query.scope.tenant = "company-b".into();
    variants.push(q);
    let mut q = request();
    q.query.access = "different-rows".into();
    variants.push(q);
    let mut q = request();
    q.query.projection = "redacted".into();
    variants.push(q);
    let mut q = request();
    q.query.filter = json!({"active":false});
    variants.push(q);
    let mut q = request();
    q.query.sort[0].direction = SortDirection::Desc;
    variants.push(q);
    let mut q = request();
    q.query.limit = 2;
    variants.push(q);
    for query in variants {
        assert_ne!(
            ListWindow::new(query, config()).unwrap().key(),
            key,
            "different permitted selections must not share a window"
        );
    }
    let keys: std::collections::HashSet<_> = [
        json!({}),
        json!({"x":null}),
        json!({"x":0}),
        json!({"x":false}),
        json!({"x":""}),
    ]
    .into_iter()
    .map(|filter| {
        let mut q = request();
        q.query.filter = filter;
        ListWindow::new(q, config()).unwrap().key()
    })
    .collect();
    assert_eq!(keys.len(), 5);
    let mut a = request();
    a.query.filter = json!({"b":2,"a":1});
    let mut b = request();
    b.query.filter = json!({"a":1,"b":2});
    assert_eq!(
        ListWindow::new(a, config()).unwrap().key(),
        ListWindow::new(b, config()).unwrap().key()
    );
}

#[test]
fn insertion_reorder_and_departure_wait_for_explicit_acceptance_without_losing_custody() {
    let mut window = ListWindow::new(request(), config()).unwrap();
    let sync = window.open(grant(), 1).unwrap();
    window
        .snapshot(
            baseline(
                &window,
                &sync,
                vec![
                    row("a", "1", json!(1)),
                    row("b", "1", json!(2)),
                    row("c", "1", json!(3)),
                ],
            ),
            2,
        )
        .unwrap();
    let custody = ListCustody {
        focus: Some("b".into()),
        selection: vec!["b".into()],
        anchor: Some(ScrollAnchor {
            id: "b".into(),
            offset_px: -14,
        }),
        dirty: vec!["b".into()],
    };
    window.set_custody(custody.clone()).unwrap();
    window
        .event(
            change(
                &window,
                &sync,
                vec![row("d", "1", json!(4)), row("b", "2", json!(20))],
                &["d", "c", "b"],
                vec![ListDeparture {
                    id: "a".into(),
                    reason: DepartureReason::Deleted,
                }],
            ),
            3,
        )
        .unwrap();
    let view = window.view();
    assert_eq!(
        view.slots.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
        vec!["a", "b", "c"]
    );
    assert_eq!(view.pending_order, vec!["d", "c", "b"]);
    assert_eq!(view.slots[0].departure, Some(DepartureReason::Deleted));
    assert_eq!(
        view.slots[0].row, None,
        "tombstones must not retain departed protected data"
    );
    assert!(view.slots[1].moved && view.slots[1].conflict);
    assert_eq!(view.custody, custody);
    window.accept_changes().unwrap();
    let view = window.view();
    assert_eq!(
        view.slots.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
        vec!["d", "c", "b"]
    );
    assert_eq!(view.custody, custody);
    assert!(view.pending_order.is_empty());
}

#[test]
fn malformed_or_oversized_queries_pages_and_cursor_witnesses_are_rejected() {
    for limit in [0, 4, 1001] {
        let mut bad = request();
        bad.query.limit = limit;
        assert!(
            ListWindow::new(bad, config()).is_err(),
            "invalid limit {limit} admitted"
        );
    }
    let mut bad = request();
    bad.query.sort.push(bad.query.sort[0].clone());
    assert!(ListWindow::new(bad, config()).is_err());
    let mut bad = request();
    bad.query.filter = json!("x".repeat(5000));
    assert!(ListWindow::new(bad, config()).is_err());
    let mut bad = request();
    bad.after = Some(PageCursor {
        query_key: "foreign".into(),
        epoch: "db-1".into(),
        revision: "1".into(),
        anchor_id: "a".into(),
        anchor_revision: "1".into(),
    });
    assert!(ListWindow::new(bad, config()).is_err());
    for rows in [
        vec![row("a", "01", json!(1))],
        vec![row("a", "1", json!(1)), row("a", "2", json!(2))],
        vec![row("a", "1", json!(1)); 4],
    ] {
        let mut window = ListWindow::new(request(), config()).unwrap();
        let sync = window.open(grant(), 1).unwrap();
        assert!(window.snapshot(baseline(&window, &sync, rows), 2).is_err());
        assert!(window.view().slots.is_empty());
    }
    let mut window = ListWindow::new(request(), config()).unwrap();
    let sync = window.open(grant(), 1).unwrap();
    let mut frame = baseline(&window, &sync, vec![]);
    frame.data["request_key"] = json!("foreign");
    assert_eq!(window.snapshot(frame, 2), Err(ErrorCode::InvalidFrame));
}

#[test]
fn provider_page_and_diff_bind_bounded_cursor_and_emit_only_changed_values() {
    let plan = ListPlan::new(request(), config()).unwrap();
    let cursor = Cursor {
        epoch: "db-1".into(),
        revision: "10".into(),
    };
    let a = row("a", "1", json!({"name":"A"}));
    let b = row("b", "1", json!({"name":"B"}));
    let before = plan
        .page(&cursor, vec![a.clone(), b.clone()], true)
        .unwrap();
    assert_eq!(
        before.next.as_ref().map(|c| c.anchor_id.as_str()),
        Some("b")
    );
    let mut paged = request();
    paged.after = before.next.clone();
    assert_ne!(ListPlan::new(paged, config()).unwrap().key(), plan.key());
    let cursor = Cursor {
        revision: "12".into(),
        ..cursor
    };
    let after = plan
        .page(&cursor, vec![b.clone(), row("c", "1", json!(3))], false)
        .unwrap();
    let patch = plan
        .diff(
            &cursor,
            &before,
            &after,
            vec![ListDeparture {
                id: "a".into(),
                reason: DepartureReason::FilterExit,
            }],
        )
        .unwrap();
    assert_eq!(patch.upserts, vec![row("c", "1", json!(3))]);
    assert_eq!(patch.departures[0].reason, DepartureReason::FilterExit);
    let mut bad = after;
    bad.rows[0].value = json!("changed-without-revision");
    assert_eq!(
        plan.diff(&cursor, &before, &bad, vec![]),
        Err(ErrorCode::InvalidRevision)
    );
}

#[test]
fn gap_reconnect_revocation_and_disposal_fence_data_but_preserve_same_authority_work() {
    let mut window = ListWindow::new(request(), config()).unwrap();
    let sync = window.open(grant(), 1).unwrap();
    window
        .snapshot(baseline(&window, &sync, vec![row("a", "1", json!(1))]), 2)
        .unwrap();
    let custody = ListCustody {
        focus: Some("a".into()),
        dirty: vec!["a".into()],
        ..ListCustody::default()
    };
    window.set_custody(custody.clone()).unwrap();
    let mut gap = change(&window, &sync, vec![], &[], vec![]);
    gap.previous = "11".into();
    let Receive::Resync { request: next, .. } = window.event(gap, 3).unwrap() else {
        panic!("gap must resync")
    };
    assert!(
        window.view().slots.iter().all(|s| s.row.is_none()),
        "resync cannot expose stale rows as ready"
    );
    let mut stale = baseline(&window, &next, vec![row("a", "1", json!(1))]);
    stale.revision = "11".into();
    assert_eq!(window.snapshot(stale, 4), Err(ErrorCode::Stale));
    let mut current = baseline(&window, &next, vec![row("a", "2", json!(2))]);
    current.revision = "12".into();
    window.snapshot(current, 5).unwrap();
    assert_eq!(window.view().custody, custody);
    window.disconnect();
    assert!(window.view().slots.iter().all(|s| s.row.is_none()));
    let sync2 = window.open(grant(), 6).unwrap();
    assert_eq!(window.view().custody, custody);
    let mut snap = baseline(&window, &sync2, vec![row("a", "2", json!(2))]);
    snap.revision = "12".into();
    window.snapshot(snap, 7).unwrap();
    window.revoke();
    assert!(window.view().slots.is_empty());
    assert_eq!(window.view().custody, ListCustody::default());
    assert!(
        window
            .snapshot(baseline(&window, &sync2, vec![row("a", "2", json!(2))]), 8)
            .is_err()
    );
    window.dispose();
    assert_eq!(window.open(grant(), 9), Err(ErrorCode::Disposed));
    assert!(window.view().slots.is_empty());
}

#[test]
fn patch_admission_never_silently_omits_unknown_rows_or_reuses_a_changed_revision() {
    for (upserts, order, departures) in [
        (
            vec![],
            vec!["unknown"],
            vec![ListDeparture {
                id: "a".into(),
                reason: DepartureReason::WindowExit,
            }],
        ),
        (vec![row("a", "1", json!(99))], vec!["a"], vec![]),
        (vec![row("a", "0", json!(1))], vec!["a"], vec![]),
        (vec![], vec!["a", "a"], vec![]),
        (vec![], vec![], vec![]),
        (
            vec![],
            vec!["a"],
            vec![ListDeparture {
                id: "a".into(),
                reason: DepartureReason::Deleted,
            }],
        ),
    ] {
        let mut window = ListWindow::new(request(), config()).unwrap();
        let sync = window.open(grant(), 1).unwrap();
        window
            .snapshot(baseline(&window, &sync, vec![row("a", "1", json!(1))]), 2)
            .unwrap();
        let before = window.view();
        assert!(
            window
                .event(change(&window, &sync, upserts, &order, departures), 3)
                .is_err(),
            "malformed delta accepted"
        );
        assert_eq!(
            window.view(),
            before,
            "invalid delta must not partly advance the causal cursor or page"
        );
    }
}

#[test]
fn dirty_departures_require_explicit_release_before_compaction() {
    let mut window = ListWindow::new(request(), config()).unwrap();
    let sync = window.open(grant(), 1).unwrap();
    window
        .snapshot(baseline(&window, &sync, vec![row("a", "1", json!(1))]), 2)
        .unwrap();
    window
        .set_custody(ListCustody {
            focus: Some("a".into()),
            dirty: vec!["a".into()],
            ..ListCustody::default()
        })
        .unwrap();
    window
        .event(
            change(
                &window,
                &sync,
                vec![],
                &[],
                vec![ListDeparture {
                    id: "a".into(),
                    reason: DepartureReason::MovedOut,
                }],
            ),
            3,
        )
        .unwrap();
    assert_eq!(window.accept_changes(), Err(ErrorCode::Busy));
    assert_eq!(window.view().slots.len(), 1);
    window.set_custody(ListCustody::default()).unwrap();
    window.accept_changes().unwrap();
    assert!(window.view().slots.is_empty());
    assert_eq!(
        window.set_custody(ListCustody {
            dirty: vec!["unknown".into()],
            ..ListCustody::default()
        }),
        Err(ErrorCode::InvalidFrame)
    );
}

#[test]
fn retained_byte_limits_reject_atomically_instead_of_silently_shortening_pages() {
    let mut small = config();
    small.max_retained_bytes = 100;
    let mut window = ListWindow::new(request(), small).unwrap();
    let sync = window.open(grant(), 1).unwrap();
    assert_eq!(
        window.snapshot(
            baseline(&window, &sync, vec![row("a", "1", json!("x".repeat(256)))]),
            2
        ),
        Err(ErrorCode::PayloadTooLarge)
    );
    assert!(window.view().slots.is_empty());
    assert_eq!(window.view().stream.state, StreamState::Syncing);
}

#[test]
fn malformed_frames_cannot_bypass_expiry_fencing() {
    for snapshot in [true, false] {
        let mut window = ListWindow::new(request(), config()).unwrap();
        let sync = window.open(grant(), 1).unwrap();
        window
            .snapshot(baseline(&window, &sync, vec![row("a", "1", json!(1))]), 2)
            .unwrap();
        let error = if snapshot {
            let mut frame = baseline(&window, &sync, vec![]);
            frame.data = json!(null);
            window.snapshot(frame, 10000)
        } else {
            let mut frame = change(&window, &sync, vec![], &[], vec![]);
            frame.data = json!(null);
            window.event(frame, 10000)
        };
        assert_eq!(error, Err(ErrorCode::Expired));
        assert_eq!(window.view().stream.state, StreamState::Revoked);
        assert!(window.view().slots.is_empty());
    }
}

#[test]
fn native_provider_pages_reject_oversized_and_deep_values_without_recursive_clone_or_drop() {
    let plan = ListPlan::new(request(), config()).unwrap();
    let cursor = Cursor {
        epoch: "db-1".into(),
        revision: "1".into(),
    };
    assert_eq!(
        plan.page(
            &cursor,
            vec![row("a", "1", json!("x".repeat(40000)))],
            false
        ),
        Err(ErrorCode::PayloadTooLarge)
    );
    let mut deep = json!(0);
    for _ in 0..20000 {
        deep = serde_json::Value::Array(vec![deep]);
    }
    assert_eq!(
        plan.page(&cursor, vec![row("a", "1", deep)], false),
        Err(ErrorCode::PayloadTooLarge)
    );
    let mut deep = json!(0);
    for _ in 0..20000 {
        deep = serde_json::Value::Array(vec![deep]);
    }
    let mut request = request();
    request.query.filter = deep;
    assert!(matches!(
        ListPlan::new(request, config()),
        Err(ErrorCode::PayloadTooLarge)
    ));
}

#[test]
fn cursor_history_cannot_be_reused_after_epoch_reset_or_revision_regression() {
    let plan = ListPlan::new(request(), config()).unwrap();
    let page = plan
        .page(
            &Cursor {
                epoch: "db-1".into(),
                revision: "10".into(),
            },
            vec![row("a", "1", json!(1))],
            true,
        )
        .unwrap();
    let mut request = request();
    request.after = page.next;
    let plan = ListPlan::new(request, config()).unwrap();
    for cursor in [
        Cursor {
            epoch: "db-2".into(),
            revision: "12".into(),
        },
        Cursor {
            epoch: "db-1".into(),
            revision: "9".into(),
        },
    ] {
        assert_eq!(
            plan.page(&cursor, vec![row("b", "1", json!(2))], false),
            Err(ErrorCode::Stale)
        );
    }
}

#[test]
fn a_later_unrelated_patch_retains_the_authoritative_tombstone_reason() {
    let mut window = ListWindow::new(request(), config()).unwrap();
    let sync = window.open(grant(), 1).unwrap();
    window
        .snapshot(
            baseline(
                &window,
                &sync,
                vec![row("a", "1", json!(1)), row("b", "1", json!(2))],
            ),
            2,
        )
        .unwrap();
    window
        .event(
            change(
                &window,
                &sync,
                vec![],
                &["b"],
                vec![ListDeparture {
                    id: "a".into(),
                    reason: DepartureReason::Deleted,
                }],
            ),
            3,
        )
        .unwrap();
    let mut update = change(
        &window,
        &sync,
        vec![row("b", "2", json!(3))],
        &["b"],
        vec![],
    );
    update.previous = "12".into();
    update.revision = "15".into();
    window.event(update, 4).unwrap();
    assert_eq!(
        window.view().slots[0].departure,
        Some(DepartureReason::Deleted)
    );
}

#[test]
fn a_dirty_reconnect_retains_revision_conflicts_without_retaining_old_values() {
    let mut window = ListWindow::new(request(), config()).unwrap();
    let sync = window.open(grant(), 1).unwrap();
    window
        .snapshot(baseline(&window, &sync, vec![row("a", "1", json!(1))]), 2)
        .unwrap();
    window
        .set_custody(ListCustody {
            dirty: vec!["a".into()],
            ..ListCustody::default()
        })
        .unwrap();
    window.disconnect();
    let sync = window.open(grant(), 3).unwrap();
    window
        .snapshot(baseline(&window, &sync, vec![row("a", "2", json!(2))]), 4)
        .unwrap();
    assert!(window.view().slots[0].conflict);
}

#[test]
fn json_list_binding_forwards_to_the_owning_rust_window_and_rejects_unknown_actions() {
    let mut core = JsonList::new(request(), config()).unwrap();
    let output: BindingReply<ListOutput> = serde_json::from_str(
        &core.call(
            &serde_json::to_string(&ListInput {
                now_ms: 1,
                action: ListAction::Stream {
                    action: StreamAction::Open { grant: grant() },
                },
            })
            .unwrap(),
        ),
    )
    .unwrap();
    let BindingReply::Ok { value } = output else {
        panic!("open failed")
    };
    assert!(matches!(value.result, StreamResult::Sync { .. }));
    let bad: BindingReply<ListOutput> =
        serde_json::from_str(&core.call(r#"{"now_ms":1,"action":{"kind":"invented"}}"#)).unwrap();
    assert_eq!(
        bad,
        BindingReply::Error {
            code: ErrorCode::InvalidFrame
        }
    );
}
