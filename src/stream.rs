use crate::*;

pub struct Stream {
    scope: Scope,
    config: StreamConfig,
    queued_bytes: u32,
    last_now_ms: u64,
    generation: u32,
    grant: Option<Grant>,
    state: StreamState,
    cursor: Option<Cursor>,
    floor: Option<Cursor>,
    resume: Option<(Grant, Cursor)>,
    queue: std::collections::VecDeque<(Delivery, u32)>,
}

impl Stream {
    pub fn new(scope: Scope, config: StreamConfig) -> Result<Self, ErrorCode> {
        validate::scope(&scope)?;
        if config.max_events == 0
            || config.max_events > 1024
            || config.max_buffer_bytes > 4_194_304
            || config.max_payload_bytes == 0
            || config.max_payload_bytes > 1_048_576
            || config.max_payload_bytes > config.max_buffer_bytes
        {
            return Err(ErrorCode::InvalidConfig);
        }
        Ok(Self {
            scope,
            config,
            queued_bytes: 0,
            last_now_ms: 0,
            generation: 0,
            grant: None,
            state: StreamState::Dormant,
            cursor: None,
            floor: None,
            resume: None,
            queue: std::collections::VecDeque::new(),
        })
    }

    pub fn open(&mut self, grant: Grant, now_ms: u64) -> Result<SyncRequest, ErrorCode> {
        if self.state == StreamState::Disposed {
            return Err(ErrorCode::Disposed);
        }
        validate::time(now_ms, self.last_now_ms)?;
        if let Err(error) = validate::grant(&grant, &self.scope, now_ms) {
            self.revoke();
            return Err(error);
        }
        self.last_now_ms = now_ms;
        self.generation = self.generation.checked_add(1).ok_or(ErrorCode::Exhausted)?;
        let current_floor = self.cursor.clone().or_else(|| self.floor.clone());
        let prior = self
            .grant
            .as_ref()
            .zip(current_floor)
            .map(|(grant, cursor)| (grant.clone(), cursor))
            .or_else(|| self.resume.take());
        self.queue.clear();
        self.cursor = None;
        self.floor = prior
            .filter(|(previous, _)| {
                previous.actor_id == grant.actor_id
                    && previous.session_id == grant.session_id
                    && previous.permission_version == grant.permission_version
            })
            .map(|(_, cursor)| cursor);
        self.resume = None;
        self.state = StreamState::Syncing;
        self.queued_bytes = 0;
        self.grant = Some(grant.clone());
        Ok(SyncRequest {
            generation: self.generation,
            scope: self.scope.clone(),
            session_id: grant.session_id,
            permission_version: grant.permission_version,
        })
    }

    pub fn snapshot(&mut self, mut snapshot: Snapshot, now_ms: u64) -> Result<Receive, ErrorCode> {
        let data = crate::payload::Payload::new(std::mem::take(&mut snapshot.data));
        self.check(now_ms)?;
        if snapshot.scope != self.scope {
            return Err(ErrorCode::InvalidScope);
        }
        if snapshot.generation != self.generation {
            return Ok(Receive::Ignored);
        }
        if !validate::identifier(&snapshot.epoch) {
            return Err(ErrorCode::InvalidFrame);
        }
        let next = revision(&snapshot.revision)?;
        if self.state != StreamState::Syncing {
            return Ok(Receive::Ignored);
        }
        if let Some(floor) = &self.floor {
            if floor.epoch != snapshot.epoch {
                return self.resync(
                    Cursor {
                        epoch: snapshot.epoch,
                        revision: snapshot.revision,
                    },
                    SyncReason::Epoch,
                );
            }
            if next < revision(&floor.revision)? {
                return Err(ErrorCode::Stale);
            }
        }
        let size = data.size(self.config.max_payload_bytes)?;
        let cursor = Cursor {
            epoch: snapshot.epoch,
            revision: snapshot.revision,
        };
        self.queue.push_back((
            Delivery::Snapshot {
                cursor: cursor.clone(),
                data: data.into_inner(),
            },
            size,
        ));
        self.queued_bytes = size;
        self.cursor = Some(cursor);
        self.floor = None;
        self.state = StreamState::Live;
        Ok(Receive::Accepted)
    }

    pub fn event(&mut self, mut event: Event, now_ms: u64) -> Result<Receive, ErrorCode> {
        let data = crate::payload::Payload::new(std::mem::take(&mut event.data));
        self.check(now_ms)?;
        if event.scope != self.scope {
            return Err(ErrorCode::InvalidScope);
        }
        if event.generation != self.generation {
            return Ok(Receive::Ignored);
        }
        if !validate::identifier(&event.epoch) {
            return Err(ErrorCode::InvalidFrame);
        }
        let next = revision(&event.revision)?;
        let previous = revision(&event.previous)?;
        if previous >= next {
            return Err(ErrorCode::InvalidRevision);
        }
        let size = data.size(self.config.max_payload_bytes)?;
        let incoming = Cursor {
            epoch: event.epoch,
            revision: event.revision,
        };
        if self.state == StreamState::Syncing {
            if self
                .floor
                .as_ref()
                .is_some_and(|floor| floor.epoch != incoming.epoch)
            {
                return self.resync(incoming, SyncReason::Epoch);
            }
            if self.floor.as_ref().is_none_or(|floor| {
                floor.epoch != incoming.epoch || revision(&floor.revision).is_ok_and(|r| next > r)
            }) {
                self.floor = Some(incoming);
            }
            return Ok(Receive::Ignored);
        }
        let cursor = self.cursor.as_ref().ok_or(ErrorCode::NotReady)?;
        if incoming.epoch != cursor.epoch {
            return self.resync(incoming, SyncReason::Epoch);
        }
        if next <= revision(&cursor.revision)? {
            return Ok(Receive::Duplicate);
        }
        if event.previous != cursor.revision {
            return self.resync(incoming, SyncReason::Gap);
        }
        if self.queue.len() >= self.config.max_events as usize
            || self.queued_bytes.saturating_add(size) > self.config.max_buffer_bytes
        {
            return self.resync(incoming, SyncReason::Overflow);
        }
        self.queue.push_back((
            Delivery::Event {
                cursor: incoming.clone(),
                data: data.into_inner(),
            },
            size,
        ));
        self.queued_bytes += size;
        self.cursor = Some(incoming);
        Ok(Receive::Accepted)
    }

    pub fn take(&mut self, limit: u32, now_ms: u64) -> Result<Vec<Delivery>, ErrorCode> {
        self.check(now_ms)?;
        let count = (limit as usize).min(self.queue.len());
        Ok(self
            .queue
            .drain(..count)
            .map(|(delivery, size)| {
                self.queued_bytes -= size;
                delivery
            })
            .collect())
    }

    pub fn tick(&mut self, now_ms: u64) -> Result<(), ErrorCode> {
        self.check(now_ms)
    }

    pub fn view(&self) -> StreamView {
        StreamView {
            scope: self.scope.clone(),
            state: self.state,
            generation: self.generation,
            cursor: self.cursor.clone(),
            queued_events: self.queue.len() as u32,
            queued_bytes: self.queued_bytes,
        }
    }

    pub fn disconnect(&mut self) {
        if matches!(self.state, StreamState::Disposed | StreamState::Revoked) {
            return;
        }
        if let Some(grant) = &self.grant
            && let Some(cursor) = self.cursor.clone().or_else(|| self.floor.clone())
        {
            self.resume = Some((grant.clone(), cursor));
        }
        self.clear(StreamState::Uncertain);
    }
    pub fn revoke(&mut self) {
        self.clear(StreamState::Revoked);
    }
    pub fn dispose(&mut self) {
        self.clear(StreamState::Disposed);
    }

    fn clear(&mut self, state: StreamState) {
        if self.state == StreamState::Disposed {
            return;
        }
        self.state = state;
        if state != StreamState::Uncertain {
            self.resume = None;
        }
        self.grant = None;
        self.cursor = None;
        self.floor = None;
        self.queue.clear();
        self.queued_bytes = 0;
    }

    fn check(&mut self, now_ms: u64) -> Result<(), ErrorCode> {
        if self.state == StreamState::Disposed {
            return Err(ErrorCode::Disposed);
        }
        validate::time(now_ms, self.last_now_ms)?;
        self.last_now_ms = now_ms;
        let grant = self.grant.as_ref().ok_or(ErrorCode::Denied)?;
        if now_ms >= grant.expires_at_ms {
            self.revoke();
            return Err(ErrorCode::Expired);
        }
        Ok(())
    }

    fn resync(&mut self, floor: Cursor, reason: SyncReason) -> Result<Receive, ErrorCode> {
        self.generation = self.generation.checked_add(1).ok_or(ErrorCode::Exhausted)?;
        self.state = StreamState::Syncing;
        self.queue.clear();
        self.queued_bytes = 0;
        self.cursor = None;
        self.floor = Some(floor);
        let grant = self.grant.as_ref().ok_or(ErrorCode::Denied)?;
        Ok(Receive::Resync {
            reason,
            request: SyncRequest {
                generation: self.generation,
                scope: self.scope.clone(),
                session_id: grant.session_id.clone(),
                permission_version: grant.permission_version.clone(),
            },
        })
    }
}

pub(crate) fn revision(value: &str) -> Result<u64, ErrorCode> {
    if value.is_empty()
        || value.len() > 19
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(ErrorCode::InvalidRevision);
    }
    value
        .parse::<u64>()
        .ok()
        .filter(|value| *value <= i64::MAX as u64)
        .ok_or(ErrorCode::InvalidRevision)
}
