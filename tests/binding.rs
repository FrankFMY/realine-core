use realine_core::*;
use serde_json::json;

#[test]
fn presence_json_binding_exposes_the_same_two_phase_journal_and_revocation() {
    let scope = Scope {
        product: "app".into(),
        tenant: "workspace".into(),
        resource: "orders".into(),
        channel: "presence".into(),
    };
    let key = PresenceKey {
        actor_id: "operator".into(),
        session_id: "session".into(),
        connection_id: "connection".into(),
    };
    let mut binding = JsonPresence::new(
        scope.clone(),
        key,
        PresenceConfig {
            idle_after_ms: 100,
            uncertain_after_ms: 50,
            offline_after_ms: 200,
        },
    )
    .unwrap();
    let grant = Grant {
        scope,
        actor_id: "operator".into(),
        session_id: "session".into(),
        permission_version: "1".into(),
        expires_at_ms: 1000,
    };
    let BindingReply::Ok { value } = serde_json::from_str::<BindingReply<PresenceOutput>>(
        &binding.call(
            &json!({"now_ms":100,"action":{"kind":"prepare","grant":grant,"signal":"active"}})
                .to_string(),
        ),
    )
    .unwrap() else {
        panic!("presence binding must prepare")
    };
    assert_eq!(value.view.state, PresenceState::Offline);
    let pending = value.pending.unwrap();
    assert_eq!(pending.view.state, PresenceState::Active);
    let BindingReply::Ok { value } = serde_json::from_str::<BindingReply<PresenceOutput>>(
        &binding.call(
            &json!({"now_ms":101,"action":{"kind":"commit","ticket":pending.ticket,"grant":grant}})
                .to_string(),
        ),
    )
    .unwrap() else {
        panic!("presence binding must commit")
    };
    assert_eq!(value.view.state, PresenceState::Active);
    let BindingReply::Ok { value } = serde_json::from_str::<BindingReply<PresenceOutput>>(
        &binding.call(r#"{"now_ms":102,"action":{"kind":"revoke"}}"#),
    )
    .unwrap() else {
        panic!("presence binding must revoke")
    };
    assert_eq!(value.view.state, PresenceState::Offline);
    assert_eq!(value.pending, None);
}

#[test]
fn portable_json_binding_runs_the_real_scoped_core_and_sanitizes_errors() {
    let scope = Scope {
        product: "ide".into(),
        tenant: "workspace".into(),
        resource: "project".into(),
        channel: "source".into(),
    };
    let mut binding = JsonStream::new(
        scope.clone(),
        StreamConfig {
            max_events: 4,
            max_buffer_bytes: 1024,
            max_payload_bytes: 256,
        },
    )
    .unwrap();
    let raw = binding.call(&json!({"now_ms": 100, "action": {"kind": "open", "grant": {
        "scope": scope, "actor_id": "author", "session_id": "session", "permission_version": "1", "expires_at_ms": 1000,
    }}}).to_string());
    let BindingReply::Ok { value } =
        serde_json::from_str::<BindingReply<StreamOutput>>(&raw).unwrap()
    else {
        panic!("real core must open through JSON")
    };
    assert_eq!(value.view.state, StreamState::Syncing);
    assert!(matches!(value.result, StreamResult::Sync { .. }));
    for input in [
        "not-json".to_owned(),
        "x".repeat(1_060_000),
        json!({"now_ms": 101, "action": {"kind":"view", "unexpected":"private-value"}}).to_string(),
    ] {
        let raw = binding.call(&input);
        assert_eq!(
            serde_json::from_str::<BindingReply<StreamOutput>>(&raw).unwrap(),
            BindingReply::Error {
                code: ErrorCode::InvalidFrame
            }
        );
        assert!(!raw.contains("private-value"));
    }
}
