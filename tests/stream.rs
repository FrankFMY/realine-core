use realine_core::*;
use serde_json::json;

fn scope() -> Scope {
    Scope {
        product: "dispatch".into(),
        tenant: "company-a".into(),
        resource: "fleet".into(),
        channel: "vehicles".into(),
    }
}

fn grant() -> Grant {
    Grant {
        scope: scope(),
        actor_id: "operator".into(),
        session_id: "session-a".into(),
        permission_version: "permission-1".into(),
        expires_at_ms: 10_000,
    }
}

fn stream() -> Stream {
    Stream::new(
        scope(),
        StreamConfig {
            max_events: 4,
            max_buffer_bytes: 128,
            max_payload_bytes: 64,
        },
    )
    .unwrap()
}

fn snapshot(request: &SyncRequest, revision: &str) -> Snapshot {
    Snapshot {
        scope: scope(),
        generation: request.generation,
        epoch: "source-1".into(),
        revision: revision.into(),
        data: json!({"ready": true}),
    }
}

fn event(request: &SyncRequest, previous: &str, revision: &str) -> Event {
    Event {
        scope: scope(),
        generation: request.generation,
        epoch: "source-1".into(),
        previous: previous.into(),
        revision: revision.into(),
        data: json!({"change": revision}),
    }
}

#[test]
fn ordered_events_detect_a_causal_gap_without_assuming_consecutive_numbers() {
    let mut core = stream();
    let request = core.open(grant(), 100).unwrap();
    core.snapshot(snapshot(&request, "12"), 101).unwrap();
    core.take(4, 102).unwrap();
    assert_eq!(
        core.event(event(&request, "12", "19"), 103),
        Ok(Receive::Accepted)
    );
    assert_eq!(
        core.event(event(&request, "12", "19"), 104),
        Ok(Receive::Duplicate)
    );
    let Ok(Receive::Resync {
        request: next,
        reason: SyncReason::Gap,
    }) = core.event(event(&request, "20", "21"), 105)
    else {
        panic!("gap must request a full resync")
    };
    assert!(next.generation > request.generation);
    assert!(core.take(4, 106).unwrap().is_empty());
    assert_eq!(
        core.snapshot(snapshot(&request, "21"), 107),
        Ok(Receive::Ignored)
    );
    assert_eq!(
        core.snapshot(snapshot(&next, "20"), 108),
        Err(ErrorCode::Stale)
    );
    assert_eq!(
        core.snapshot(snapshot(&next, "21"), 109),
        Ok(Receive::Accepted)
    );
    assert_eq!(
        core.event(event(&request, "21", "22"), 110),
        Ok(Receive::Ignored)
    );
    assert_eq!(
        core.event(event(&next, "21", "24"), 111),
        Ok(Receive::Accepted)
    );
    assert_eq!(core.take(4, 112).unwrap().len(), 2);
}

#[test]
fn slow_consumers_resync_instead_of_retaining_unbounded_events_or_bytes() {
    for config in [
        StreamConfig {
            max_events: 2,
            max_buffer_bytes: 128,
            max_payload_bytes: 64,
        },
        StreamConfig {
            max_events: 8,
            max_buffer_bytes: 32,
            max_payload_bytes: 32,
        },
    ] {
        let mut core = Stream::new(scope(), config).unwrap();
        let request = core.open(grant(), 100).unwrap();
        core.snapshot(snapshot(&request, "12"), 101).unwrap();
        assert_eq!(
            core.event(event(&request, "12", "13"), 102),
            Ok(Receive::Accepted)
        );
        assert!(matches!(
            core.event(event(&request, "13", "14"), 103),
            Ok(Receive::Resync {
                reason: SyncReason::Overflow,
                ..
            })
        ));
        assert!(core.take(99, 104).unwrap().is_empty());
    }
}

#[test]
fn invalid_boundaries_fail_unchanged_and_failed_renewal_erases_old_access() {
    for config in [
        StreamConfig {
            max_events: 0,
            max_buffer_bytes: 128,
            max_payload_bytes: 64,
        },
        StreamConfig {
            max_events: 1025,
            max_buffer_bytes: 128,
            max_payload_bytes: 64,
        },
        StreamConfig {
            max_events: 2,
            max_buffer_bytes: 32,
            max_payload_bytes: 64,
        },
        StreamConfig {
            max_events: 2,
            max_buffer_bytes: 4_194_305,
            max_payload_bytes: 64,
        },
    ] {
        assert!(matches!(
            Stream::new(scope(), config),
            Err(ErrorCode::InvalidConfig)
        ));
    }
    let mut bad_scope = scope();
    bad_scope.channel = "x".repeat(129);
    assert!(matches!(
        Stream::new(
            bad_scope,
            StreamConfig {
                max_events: 2,
                max_buffer_bytes: 128,
                max_payload_bytes: 64,
            }
        ),
        Err(ErrorCode::InvalidScope)
    ));
    let mut core = stream();
    let request = core.open(grant(), 100).unwrap();
    for invalid in ["01", "-1", "1.0", "9223372036854775808", "", "+2"] {
        assert_eq!(
            core.snapshot(snapshot(&request, invalid), 101),
            Err(ErrorCode::InvalidRevision)
        );
    }
    let mut large = snapshot(&request, "12");
    large.data = json!("x".repeat(65));
    assert_eq!(core.snapshot(large, 101), Err(ErrorCode::PayloadTooLarge));
    assert_eq!(
        core.snapshot(snapshot(&request, "12"), 99),
        Err(ErrorCode::InvalidTime)
    );
    assert_eq!(
        core.snapshot(snapshot(&request, "12"), 9_007_199_254_740_992),
        Err(ErrorCode::InvalidTime)
    );
    core.snapshot(snapshot(&request, "12"), 102).unwrap();
    let mut foreign = grant();
    foreign.actor_id.clear();
    assert_eq!(core.open(foreign, 103), Err(ErrorCode::InvalidGrant));
    assert_eq!(core.view().state, StreamState::Revoked);
    assert_eq!(core.view().queued_events, 0);
}

#[test]
fn native_payload_depth_is_bounded_even_when_the_serialized_bytes_fit() {
    let mut core = Stream::new(
        scope(),
        StreamConfig {
            max_events: 4,
            max_buffer_bytes: 32768,
            max_payload_bytes: 32768,
        },
    )
    .unwrap();
    let request = core.open(grant(), 100).unwrap();
    let mut nested = serde_json::Value::Null;
    for _ in 0..64 {
        nested = serde_json::Value::Array(vec![nested]);
    }
    let mut deep = snapshot(&request, "12");
    deep.data = nested;
    assert_eq!(core.snapshot(deep, 101), Err(ErrorCode::PayloadTooLarge));
    assert_eq!(core.view().queued_events, 0);
}

#[test]
fn rejected_native_payloads_are_destroyed_iteratively_even_on_denial() {
    std::thread::Builder::new()
        .stack_size(64 * 1024)
        .spawn(|| {
            for denied in [false, true] {
                let mut core = Stream::new(
                    scope(),
                    StreamConfig {
                        max_events: 4,
                        max_buffer_bytes: 32768,
                        max_payload_bytes: 32768,
                    },
                )
                .unwrap();
                let request = core.open(grant(), 100).unwrap();
                let mut deep = serde_json::Value::Null;
                for _ in 0..8192 {
                    deep = serde_json::Value::Array(vec![deep]);
                }
                let mut frame = snapshot(&request, "12");
                frame.data = deep;
                if denied {
                    core.revoke();
                }
                assert_eq!(
                    core.snapshot(frame, 101),
                    Err(if denied {
                        ErrorCode::Denied
                    } else {
                        ErrorCode::PayloadTooLarge
                    })
                );
                assert_eq!(core.view().queued_events, 0);
            }
        })
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn a_second_epoch_restart_during_resync_produces_a_new_recoverable_generation() {
    let mut core = stream();
    let first = core.open(grant(), 100).unwrap();
    core.snapshot(snapshot(&first, "10"), 101).unwrap();
    let mut restart = event(&first, "0", "1");
    restart.epoch = "source-2".into();
    let Receive::Resync {
        request: second,
        reason: SyncReason::Epoch,
    } = core.event(restart, 102).unwrap()
    else {
        panic!("epoch restart must resync")
    };
    let mut changed_again = snapshot(&second, "0");
    changed_again.epoch = "source-3".into();
    let Receive::Resync {
        request: third,
        reason: SyncReason::Epoch,
    } = core.snapshot(changed_again.clone(), 103).unwrap()
    else {
        panic!("restart during recovery must issue a new request")
    };
    changed_again.generation = third.generation;
    assert_eq!(core.snapshot(changed_again, 104), Ok(Receive::Accepted));
    assert_eq!(core.view().state, StreamState::Live);
    assert_eq!(core.view().cursor.unwrap().epoch, "source-3");
}

#[test]
fn reconnect_under_the_same_authority_cannot_regress_a_known_epoch() {
    let mut core = stream();
    let first = core.open(grant(), 100).unwrap();
    core.snapshot(snapshot(&first, "10"), 101).unwrap();
    core.event(event(&first, "10", "15"), 102).unwrap();
    core.disconnect();
    let second = core.open(grant(), 103).unwrap();
    assert_eq!(
        core.snapshot(snapshot(&second, "14"), 104),
        Err(ErrorCode::Stale)
    );
    assert_eq!(
        core.snapshot(snapshot(&second, "15"), 105),
        Ok(Receive::Accepted)
    );
    core.revoke();
    core.disconnect();
    assert_eq!(core.view().state, StreamState::Revoked);
    let third = core.open(grant(), 106).unwrap();
    assert_eq!(
        core.snapshot(snapshot(&third, "1"), 107),
        Ok(Receive::Accepted)
    );
}

#[test]
fn authorized_snapshot_is_delivered_to_the_scoped_consumer() {
    let mut core = stream();
    let request = core.open(grant(), 100).unwrap();
    assert_eq!(request.scope, scope());
    assert_eq!(request.session_id, "session-a");
    assert_eq!(
        core.snapshot(snapshot(&request, "12"), 101),
        Ok(Receive::Accepted)
    );
    assert_eq!(
        core.take(4, 102).unwrap(),
        vec![Delivery::Snapshot {
            cursor: Cursor {
                epoch: "source-1".into(),
                revision: "12".into()
            },
            data: json!({"ready": true}),
        }]
    );
}

#[test]
fn disconnect_revocation_and_disposal_clear_data_and_fence_old_callbacks() {
    let mut core = stream();
    let first = core.open(grant(), 100).unwrap();
    core.snapshot(snapshot(&first, "12"), 101).unwrap();
    core.disconnect();
    assert_eq!(core.view().state, StreamState::Uncertain);
    assert_eq!(core.view().queued_events, 0);
    assert_eq!(core.view().queued_bytes, 0);
    let second = core.open(grant(), 102).unwrap();
    assert_eq!(
        core.snapshot(snapshot(&first, "13"), 103),
        Ok(Receive::Ignored)
    );
    core.snapshot(snapshot(&second, "14"), 104).unwrap();
    core.revoke();
    assert_eq!(core.view().state, StreamState::Revoked);
    assert_eq!(core.view().cursor, None);
    assert_eq!(core.take(4, 105), Err(ErrorCode::Denied));
    core.open(grant(), 106).unwrap();
    core.dispose();
    core.dispose();
    core.revoke();
    core.disconnect();
    assert_eq!(core.view().state, StreamState::Disposed);
    assert_eq!(core.open(grant(), 107), Err(ErrorCode::Disposed));
    assert_eq!(
        core.event(event(&second, "14", "15"), 108),
        Err(ErrorCode::Disposed)
    );
}

#[test]
fn scope_and_session_expiry_fence_delivery() {
    let mut core = stream();
    let mut foreign = grant();
    foreign.scope.tenant = "company-b".into();
    assert_eq!(core.open(foreign, 100), Err(ErrorCode::Denied));
    let request = core.open(grant(), 101).unwrap();
    let mut foreign_snapshot = snapshot(&request, "12");
    foreign_snapshot.scope.product = "another-product".into();
    assert_eq!(
        core.snapshot(foreign_snapshot, 102),
        Err(ErrorCode::InvalidScope)
    );
    core.snapshot(snapshot(&request, "12"), 103).unwrap();
    assert_eq!(core.take(4, 10_000), Err(ErrorCode::Expired));
    assert_eq!(
        core.snapshot(snapshot(&request, "13"), 10_001),
        Err(ErrorCode::Denied)
    );
    let mut renewed = grant();
    renewed.expires_at_ms = 20_000;
    let next = core.open(renewed, 10_002).unwrap();
    assert!(next.generation > request.generation);
    assert_eq!(
        core.snapshot(snapshot(&request, "14"), 10_003),
        Ok(Receive::Ignored)
    );
    assert!(core.take(4, 10_004).unwrap().is_empty());
}
