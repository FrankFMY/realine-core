use realine_core::*;

fn grant() -> Grant {
    Grant {
        scope: Scope {
            product: "dispatch".into(),
            tenant: "company-a".into(),
            resource: "fleet".into(),
            channel: "presence".into(),
        },
        actor_id: "operator".into(),
        session_id: "session-a".into(),
        permission_version: "1".into(),
        expires_at_ms: 100_000,
    }
}

fn presence() -> Presence {
    Presence::new(
        grant().scope,
        PresenceKey {
            actor_id: "operator".into(),
            session_id: "session-a".into(),
            connection_id: "connection-1".into(),
        },
        PresenceConfig {
            idle_after_ms: 100,
            uncertain_after_ms: 50,
            offline_after_ms: 200,
        },
    )
    .unwrap()
}

fn observe(core: &mut Presence, signal: PresenceSignal, now: u64) -> PreparedPresence {
    let prepared = core.prepare(grant(), signal, now).unwrap();
    core.commit(prepared.ticket, grant(), now).unwrap();
    prepared
}

#[test]
fn presence_rechecks_exact_authority_and_retains_only_one_immutable_journal_proposal() {
    let mut core = presence();
    let prepared = core.prepare(grant(), PresenceSignal::Active, 100).unwrap();
    assert_eq!(
        core.prepare(grant(), PresenceSignal::Idle, 101),
        Err(ErrorCode::Busy)
    );
    assert_eq!(core.pending(), Some(prepared.clone()));
    assert_eq!(
        core.commit(prepared.ticket + 1, grant(), 102),
        Err(ErrorCode::Stale)
    );
    assert_eq!(core.view().state, PresenceState::Offline);
    let mut changed = grant();
    changed.permission_version = "2".into();
    assert_eq!(
        core.commit(prepared.ticket, changed, 103),
        Err(ErrorCode::Denied)
    );
    assert_eq!(core.view().lifecycle, PresenceLifecycle::Revoked);
    assert_eq!(core.pending(), None);
    assert_eq!(
        core.prepare(grant(), PresenceSignal::Active, 104),
        Err(ErrorCode::Denied)
    );
    for altered in 0..3 {
        let mut core = presence();
        let mut foreign = grant();
        match altered {
            0 => foreign.scope.product = "foreign".into(),
            1 => foreign.actor_id = "other".into(),
            _ => foreign.session_id = "other".into(),
        }
        assert_eq!(
            core.prepare(foreign, PresenceSignal::Active, 100),
            Err(ErrorCode::Denied)
        );
        assert_eq!(core.view().state, PresenceState::Offline);
    }
    let mut core = presence();
    observe(&mut core, PresenceSignal::Active, 100);
    assert_eq!(
        core.prepare(grant(), PresenceSignal::Active, 99),
        Err(ErrorCode::InvalidTime)
    );
    assert_eq!(
        core.prepare(grant(), PresenceSignal::Tick, 100_000),
        Err(ErrorCode::Expired)
    );
    assert_eq!(core.view().lifecycle, PresenceLifecycle::Revoked);
    core.dispose();
    core.revoke();
    assert_eq!(core.view().lifecycle, PresenceLifecycle::Disposed);
    assert_eq!(
        core.prepare(grant(), PresenceSignal::Active, 100_001),
        Err(ErrorCode::Disposed)
    );
}

#[test]
fn injected_storage_retains_exact_lost_ack_retry_and_authority_is_current() {
    struct Authority {
        allowed: bool,
    }
    impl PresenceAuthority for Authority {
        fn current(
            &mut self,
            scope: &Scope,
            key: &PresenceKey,
            _: u64,
        ) -> Result<Grant, ErrorCode> {
            assert_eq!(scope, &grant().scope);
            assert_eq!(key.actor_id, "operator");
            if self.allowed {
                Ok(grant())
            } else {
                Err(ErrorCode::Denied)
            }
        }
    }
    #[derive(Default)]
    struct Storage {
        entries: Vec<PreparedPresence>,
        lose_ack: bool,
    }
    impl PresenceStorage for Storage {
        fn store(&mut self, _: &Grant, observation: &PreparedPresence) -> Result<(), ErrorCode> {
            if let Some(previous) = self
                .entries
                .iter()
                .find(|entry| entry.ticket == observation.ticket)
            {
                assert_eq!(previous, observation);
            } else {
                self.entries.push(observation.clone());
            }
            if self.lose_ack {
                self.lose_ack = false;
                Err(ErrorCode::Storage)
            } else {
                Ok(())
            }
        }
    }
    let mut host = PresenceHost::new(presence(), Authority { allowed: true }, Storage::default());
    assert_eq!(
        host.observe(PresenceSignal::Active, 100).unwrap().state,
        PresenceState::Active
    );
    host.storage.lose_ack = true;
    assert_eq!(
        host.observe(PresenceSignal::Idle, 110),
        Err(ErrorCode::Storage)
    );
    assert_eq!(host.core().view().state, PresenceState::Active);
    let pending = host.core().pending().unwrap();
    assert_eq!(
        host.observe(PresenceSignal::Active, 111),
        Err(ErrorCode::Busy)
    );
    assert_eq!(host.retry(112).unwrap().state, PresenceState::Idle);
    assert_eq!(host.storage.entries.len(), 2);
    assert_eq!(host.storage.entries[1], pending);
    host.authority.allowed = false;
    assert_eq!(
        host.observe(PresenceSignal::Active, 113),
        Err(ErrorCode::Denied)
    );
    assert_eq!(host.core().view().state, PresenceState::Offline);
    assert_eq!(host.core().view().lifecycle, PresenceLifecycle::Revoked);
    assert_eq!(host.storage.entries.len(), 2);
}

#[test]
fn retry_never_sends_old_protected_journal_to_a_changed_authority() {
    struct Authority {
        version: String,
    }
    impl PresenceAuthority for Authority {
        fn current(&mut self, _: &Scope, _: &PresenceKey, _: u64) -> Result<Grant, ErrorCode> {
            let mut current = grant();
            current.permission_version = self.version.clone();
            Ok(current)
        }
    }
    struct Storage {
        calls: usize,
    }
    impl PresenceStorage for Storage {
        fn store(&mut self, _: &Grant, _: &PreparedPresence) -> Result<(), ErrorCode> {
            self.calls += 1;
            Err(ErrorCode::Storage)
        }
    }
    let mut host = PresenceHost::new(
        presence(),
        Authority {
            version: "1".into(),
        },
        Storage { calls: 0 },
    );
    assert_eq!(
        host.observe(PresenceSignal::Active, 100),
        Err(ErrorCode::Storage)
    );
    host.authority.version = "2".into();
    assert_eq!(host.retry(101), Err(ErrorCode::Denied));
    assert_eq!(host.storage.calls, 1);
    assert_eq!(host.core().pending(), None);
}

#[test]
fn delayed_commit_keeps_a_separate_validation_clock_high_water_mark() {
    let mut core = presence();
    let proposal = core.prepare(grant(), PresenceSignal::Active, 100).unwrap();
    core.commit(proposal.ticket, grant(), 1000).unwrap();
    assert_eq!(core.view().observed_at_ms, 100);
    let mut short = grant();
    short.expires_at_ms = 200;
    assert_eq!(
        core.prepare(short, PresenceSignal::Heartbeat, 101),
        Err(ErrorCode::InvalidTime)
    );
    assert_eq!(core.pending(), None);
    assert_eq!(
        core.prepare(grant(), PresenceSignal::Tick, 1001)
            .unwrap()
            .view
            .state,
        PresenceState::Offline
    );
}

#[test]
fn transactional_storage_revocation_is_terminal_not_a_lost_ack_retry() {
    struct Authority;
    impl PresenceAuthority for Authority {
        fn current(&mut self, _: &Scope, _: &PresenceKey, _: u64) -> Result<Grant, ErrorCode> {
            Ok(grant())
        }
    }
    struct Storage {
        denied: bool,
    }
    impl PresenceStorage for Storage {
        fn store(&mut self, _: &Grant, _: &PreparedPresence) -> Result<(), ErrorCode> {
            if self.denied {
                Err(ErrorCode::Denied)
            } else {
                Ok(())
            }
        }
    }
    let mut host = PresenceHost::new(presence(), Authority, Storage { denied: false });
    host.observe(PresenceSignal::Active, 100).unwrap();
    host.storage.denied = true;
    assert_eq!(
        host.observe(PresenceSignal::Idle, 110),
        Err(ErrorCode::Denied)
    );
    assert_eq!(host.core().view().state, PresenceState::Offline);
    assert_eq!(host.core().view().lifecycle, PresenceLifecycle::Revoked);
    assert_eq!(host.core().pending(), None);
}

#[test]
fn invalid_presence_limits_and_identity_are_rejected_before_observation() {
    let key = presence().view().key;
    for config in [
        PresenceConfig {
            idle_after_ms: 0,
            uncertain_after_ms: 50,
            offline_after_ms: 200,
        },
        PresenceConfig {
            idle_after_ms: 100,
            uncertain_after_ms: 0,
            offline_after_ms: 200,
        },
        PresenceConfig {
            idle_after_ms: 200,
            uncertain_after_ms: 50,
            offline_after_ms: 200,
        },
        PresenceConfig {
            idle_after_ms: 100,
            uncertain_after_ms: 200,
            offline_after_ms: 200,
        },
        PresenceConfig {
            idle_after_ms: 100,
            uncertain_after_ms: 50,
            offline_after_ms: 86_400_001,
        },
    ] {
        assert!(matches!(
            Presence::new(grant().scope, key.clone(), config),
            Err(ErrorCode::InvalidConfig)
        ));
    }
    let mut invalid = key;
    invalid.connection_id.clear();
    assert!(matches!(
        Presence::new(
            grant().scope,
            invalid,
            PresenceConfig {
                idle_after_ms: 100,
                uncertain_after_ms: 50,
                offline_after_ms: 200,
            }
        ),
        Err(ErrorCode::InvalidGrant)
    ));
}

#[test]
fn server_observations_drive_presence_and_prepare_journal_before_commit() {
    let mut core = presence();
    let active = core.prepare(grant(), PresenceSignal::Active, 1000).unwrap();
    assert_eq!(core.view().state, PresenceState::Offline);
    assert_eq!(active.view.state, PresenceState::Active);
    let entry = active.entry.as_ref().expect("journal transition");
    assert_eq!(entry.from, PresenceState::Offline);
    assert_eq!(entry.to, PresenceState::Active);
    assert_eq!(entry.observed_at_ms, 1000);
    core.commit(active.ticket, grant(), 1000).unwrap();
    assert_eq!(core.view().last_active_ms, Some(1000));
    assert!(
        observe(&mut core, PresenceSignal::Heartbeat, 1040)
            .entry
            .is_none()
    );
    observe(&mut core, PresenceSignal::Heartbeat, 1080);
    assert_eq!(
        observe(&mut core, PresenceSignal::Heartbeat, 1100)
            .view
            .state,
        PresenceState::Idle
    );
    assert_eq!(
        observe(&mut core, PresenceSignal::Tick, 1150).view.state,
        PresenceState::Uncertain
    );
    let offline = observe(&mut core, PresenceSignal::Tick, 1300);
    assert_eq!(offline.view.state, PresenceState::Offline);
    assert_eq!(offline.view.last_seen_ms, Some(1100));
    assert_eq!(
        observe(&mut core, PresenceSignal::Active, 1301).view.state,
        PresenceState::Active
    );
    assert_eq!(
        observe(&mut core, PresenceSignal::Uncertain, 1302)
            .view
            .state,
        PresenceState::Uncertain
    );
    assert_eq!(
        observe(&mut core, PresenceSignal::Idle, 1303).view.state,
        PresenceState::Idle
    );
    assert_eq!(
        observe(&mut core, PresenceSignal::Offline, 1304).view.state,
        PresenceState::Offline
    );
}
