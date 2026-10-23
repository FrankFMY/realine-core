use crate::*;

/// Resolve the live authenticated session and current scope permission, never a channel descriptor.
pub trait PresenceAuthority {
    fn current(
        &mut self,
        scope: &Scope,
        key: &PresenceKey,
        now_ms: u64,
    ) -> Result<Grant, ErrorCode>;
}

/// Persist the observation and optional transition atomically and idempotently by scope/key/ticket.
/// Durable providers must revalidate the supplied grant in their own authority transaction.
pub trait PresenceStorage {
    fn store(&mut self, grant: &Grant, observation: &PreparedPresence) -> Result<(), ErrorCode>;
}

pub struct PresenceHost<A, S> {
    pub authority: A,
    pub storage: S,
    core: Presence,
}

impl<A: PresenceAuthority, S: PresenceStorage> PresenceHost<A, S> {
    pub fn new(core: Presence, authority: A, storage: S) -> Self {
        Self {
            core,
            authority,
            storage,
        }
    }
    pub fn observe(
        &mut self,
        signal: PresenceSignal,
        now_ms: u64,
    ) -> Result<PresenceView, ErrorCode> {
        let grant = self.authorize(now_ms)?;
        let observation = self.core.prepare(grant.clone(), signal, now_ms)?;
        self.persist(observation, grant, now_ms)
    }
    pub fn retry(&mut self, now_ms: u64) -> Result<PresenceView, ErrorCode> {
        let grant = self.authorize(now_ms)?;
        let observation = self.core.revalidate_pending(&grant, now_ms)?;
        self.persist(observation, grant, now_ms)
    }
    pub fn core(&self) -> &Presence {
        &self.core
    }

    fn authorize(&mut self, now_ms: u64) -> Result<Grant, ErrorCode> {
        let view = self.core.view();
        match self.authority.current(&view.scope, &view.key, now_ms) {
            Ok(grant) => Ok(grant),
            Err(error) => {
                self.core.revoke();
                Err(error)
            }
        }
    }

    fn persist(
        &mut self,
        observation: PreparedPresence,
        grant: Grant,
        now_ms: u64,
    ) -> Result<PresenceView, ErrorCode> {
        if let Err(error) = self.storage.store(&grant, &observation) {
            if matches!(
                error,
                ErrorCode::Denied
                    | ErrorCode::Expired
                    | ErrorCode::InvalidGrant
                    | ErrorCode::InvalidScope
            ) {
                self.core.revoke();
                return Err(error);
            }
            return Err(ErrorCode::Storage);
        }
        let current = self.authorize(now_ms)?;
        self.core.commit(observation.ticket, current, now_ms)
    }
}
