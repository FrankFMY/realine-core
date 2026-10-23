use crate::*;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PresenceKey {
    pub actor_id: String,
    pub session_id: String,
    pub connection_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PresenceConfig {
    pub idle_after_ms: u32,
    pub uncertain_after_ms: u32,
    pub offline_after_ms: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PresenceSignal {
    Active,
    Idle,
    Heartbeat,
    Uncertain,
    Offline,
    Tick,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PresenceState {
    Offline,
    Active,
    Idle,
    Uncertain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PresenceLifecycle {
    Dormant,
    Open,
    Revoked,
    Disposed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PresenceView {
    pub scope: Scope,
    pub key: PresenceKey,
    pub lifecycle: PresenceLifecycle,
    pub state: PresenceState,
    #[ts(type = "number | null")]
    pub last_seen_ms: Option<u64>,
    #[ts(type = "number | null")]
    pub last_active_ms: Option<u64>,
    #[ts(type = "number")]
    pub observed_at_ms: u64,
}

/// Idempotency key is (scope, key, sequence). A connection_id is server-owned and never reused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PresenceEntry {
    pub scope: Scope,
    pub key: PresenceKey,
    pub sequence: u32,
    pub from: PresenceState,
    pub to: PresenceState,
    pub reason: PresenceSignal,
    #[ts(type = "number")]
    pub observed_at_ms: u64,
    #[ts(type = "number | null")]
    pub last_seen_ms: Option<u64>,
    #[ts(type = "number | null")]
    pub last_active_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PreparedPresence {
    pub ticket: u32,
    pub view: PresenceView,
    pub entry: Option<PresenceEntry>,
}

pub struct Presence {
    view: PresenceView,
    config: PresenceConfig,
    sequence: u32,
    last_validation_ms: u64,
    pending: Option<(PreparedPresence, Grant)>,
}

impl Presence {
    pub fn new(scope: Scope, key: PresenceKey, config: PresenceConfig) -> Result<Self, ErrorCode> {
        validate::scope(&scope)?;
        if ![&key.actor_id, &key.session_id, &key.connection_id]
            .iter()
            .all(|id| validate::identifier(id))
        {
            return Err(ErrorCode::InvalidGrant);
        }
        if config.idle_after_ms == 0
            || config.uncertain_after_ms == 0
            || config.idle_after_ms >= config.offline_after_ms
            || config.uncertain_after_ms >= config.offline_after_ms
            || config.offline_after_ms > 86_400_000
        {
            return Err(ErrorCode::InvalidConfig);
        }
        Ok(Self {
            config,
            sequence: 0,
            last_validation_ms: 0,
            pending: None,
            view: PresenceView {
                scope,
                key,
                lifecycle: PresenceLifecycle::Dormant,
                state: PresenceState::Offline,
                last_seen_ms: None,
                last_active_ms: None,
                observed_at_ms: 0,
            },
        })
    }

    pub fn prepare(
        &mut self,
        grant: Grant,
        signal: PresenceSignal,
        now_ms: u64,
    ) -> Result<PreparedPresence, ErrorCode> {
        self.check(&grant, now_ms)?;
        if self.pending.is_some() {
            return Err(ErrorCode::Busy);
        }
        let mut view = self.view.clone();
        view.lifecycle = PresenceLifecycle::Open;
        view.observed_at_ms = now_ms;
        match signal {
            PresenceSignal::Active => {
                view.state = PresenceState::Active;
                view.last_seen_ms = Some(now_ms);
                view.last_active_ms = Some(now_ms);
            }
            PresenceSignal::Idle | PresenceSignal::Uncertain => {
                view.state = if signal == PresenceSignal::Idle {
                    PresenceState::Idle
                } else {
                    PresenceState::Uncertain
                };
                view.last_seen_ms = Some(now_ms);
            }
            PresenceSignal::Heartbeat => {
                view.last_seen_ms = Some(now_ms);
                view.state = if view
                    .last_active_ms
                    .is_some_and(|last| now_ms - last < self.config.idle_after_ms as u64)
                {
                    PresenceState::Active
                } else {
                    PresenceState::Idle
                };
            }
            PresenceSignal::Offline => view.state = PresenceState::Offline,
            PresenceSignal::Tick => {
                if view.state != PresenceState::Offline {
                    let elapsed = now_ms - view.last_seen_ms.unwrap_or(now_ms);
                    if elapsed >= self.config.offline_after_ms as u64 {
                        view.state = PresenceState::Offline;
                    } else if elapsed >= self.config.uncertain_after_ms as u64 {
                        view.state = PresenceState::Uncertain;
                    } else if view.state == PresenceState::Active
                        && view
                            .last_active_ms
                            .is_some_and(|last| now_ms - last >= self.config.idle_after_ms as u64)
                    {
                        view.state = PresenceState::Idle;
                    }
                }
            }
        }
        self.sequence = self.sequence.checked_add(1).ok_or(ErrorCode::Exhausted)?;
        let entry = (self.view.state != view.state).then(|| PresenceEntry {
            scope: view.scope.clone(),
            key: view.key.clone(),
            sequence: self.sequence,
            from: self.view.state,
            to: view.state,
            reason: signal,
            observed_at_ms: now_ms,
            last_seen_ms: view.last_seen_ms,
            last_active_ms: view.last_active_ms,
        });
        let prepared = PreparedPresence {
            ticket: self.sequence,
            view,
            entry,
        };
        self.pending = Some((prepared.clone(), grant));
        Ok(prepared)
    }

    pub fn commit(
        &mut self,
        ticket: u32,
        grant: Grant,
        now_ms: u64,
    ) -> Result<PresenceView, ErrorCode> {
        let prepared = self.revalidate_pending(&grant, now_ms)?;
        if prepared.ticket != ticket {
            return Err(ErrorCode::Stale);
        }
        let (prepared, _) = self.pending.take().ok_or(ErrorCode::Stale)?;
        self.view = prepared.view;
        Ok(self.view.clone())
    }

    pub fn revalidate_pending(
        &mut self,
        grant: &Grant,
        now_ms: u64,
    ) -> Result<PreparedPresence, ErrorCode> {
        self.check(grant, now_ms)?;
        let (prepared, previous_grant) = self.pending.as_ref().ok_or(ErrorCode::Stale)?;
        validate::time(now_ms, prepared.view.observed_at_ms)?;
        if previous_grant.permission_version != grant.permission_version {
            self.revoke();
            return Err(ErrorCode::Denied);
        }
        Ok(prepared.clone())
    }

    pub fn pending(&self) -> Option<PreparedPresence> {
        self.pending.as_ref().map(|(p, _)| p.clone())
    }
    pub fn revoke(&mut self) {
        if self.view.lifecycle == PresenceLifecycle::Disposed {
            return;
        }
        self.view.lifecycle = PresenceLifecycle::Revoked;
        self.view.state = PresenceState::Offline;
        self.view.last_seen_ms = None;
        self.view.last_active_ms = None;
        self.pending = None;
    }
    pub fn dispose(&mut self) {
        self.revoke();
        self.view.lifecycle = PresenceLifecycle::Disposed;
    }

    fn check(&mut self, grant: &Grant, now_ms: u64) -> Result<(), ErrorCode> {
        match self.view.lifecycle {
            PresenceLifecycle::Disposed => return Err(ErrorCode::Disposed),
            PresenceLifecycle::Revoked => return Err(ErrorCode::Denied),
            _ => (),
        }
        validate::time(now_ms, self.last_validation_ms)?;
        self.last_validation_ms = now_ms;
        let check = validate::grant(grant, &self.view.scope, now_ms).and_then(|()| {
            if grant.actor_id != self.view.key.actor_id
                || grant.session_id != self.view.key.session_id
            {
                Err(ErrorCode::Denied)
            } else {
                Ok(())
            }
        });
        if check.is_err() {
            self.revoke();
        }
        check
    }

    pub fn view(&self) -> PresenceView {
        self.view.clone()
    }
}
