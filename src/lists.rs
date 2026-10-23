use crate::*;

pub struct ListWindow {
    stream: Stream,
    slots: Vec<ListSlot>,
    plan: ListPlan,
    rows: Vec<ListRow>,
    custody: ListCustody,
    next: Option<PageCursor>,
    authority: Option<Grant>,
    observed_epoch: Option<String>,
}
impl ListWindow {
    pub fn new(request: ListRequest, config: ListConfig) -> Result<Self, ErrorCode> {
        let plan = ListPlan::new(request, config)?;
        Ok(Self {
            stream: Stream::new(plan.request.query.scope.clone(), config.stream)?,
            slots: vec![],
            plan,
            rows: vec![],
            custody: ListCustody::default(),
            next: None,
            authority: None,
            observed_epoch: None,
        })
    }
    pub fn key(&self) -> String {
        self.plan.key().to_string()
    }
    pub fn set_custody(&mut self, custody: ListCustody) -> Result<(), ErrorCode> {
        let known: std::collections::HashSet<_> =
            self.slots.iter().map(|slot| slot.id.as_str()).collect();
        for ids in [&custody.selection, &custody.dirty] {
            if ids.len() > self.plan.config.max_rows as usize
                || ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len()
                || ids.iter().any(|id| !known.contains(id.as_str()))
            {
                return Err(ErrorCode::InvalidFrame);
            }
        }
        if custody
            .focus
            .as_ref()
            .is_some_and(|id| !known.contains(id.as_str()))
            || custody
                .anchor
                .as_ref()
                .is_some_and(|anchor| !known.contains(anchor.id.as_str()))
        {
            return Err(ErrorCode::InvalidFrame);
        }
        self.custody = custody;
        for slot in &mut self.slots {
            if !self.custody.dirty.contains(&slot.id) {
                slot.conflict = false;
            }
        }
        Ok(())
    }
    pub fn accept_changes(&mut self) -> Result<(), ErrorCode> {
        if self.stream.view().state != StreamState::Live {
            return Err(ErrorCode::NotReady);
        }
        let current: std::collections::HashSet<_> =
            self.rows.iter().map(|row| row.id.as_str()).collect();
        if self
            .custody
            .dirty
            .iter()
            .any(|id| !current.contains(id.as_str()))
        {
            return Err(ErrorCode::Busy);
        }
        self.custody
            .selection
            .retain(|id| current.contains(id.as_str()));
        if self
            .custody
            .focus
            .as_ref()
            .is_some_and(|id| !current.contains(id.as_str()))
        {
            self.custody.focus = None;
        }
        if self
            .custody
            .anchor
            .as_ref()
            .is_some_and(|anchor| !current.contains(anchor.id.as_str()))
        {
            self.custody.anchor = None;
        }
        self.slots = self
            .rows
            .iter()
            .map(|row| ListSlot {
                id: row.id.clone(),
                observed_revision: row.revision.clone(),
                row: Some(row.clone()),
                departure: None,
                moved: false,
                conflict: self
                    .slots
                    .iter()
                    .any(|slot| slot.id == row.id && slot.conflict),
            })
            .collect();
        Ok(())
    }
    pub fn open(&mut self, grant: Grant, now: u64) -> Result<SyncRequest, ErrorCode> {
        let same = self.authority.as_ref().is_some_and(|previous| {
            previous.actor_id == grant.actor_id
                && previous.session_id == grant.session_id
                && previous.permission_version == grant.permission_version
        });
        let result = self.stream.open(grant.clone(), now);
        if result.is_ok() {
            if !same {
                self.erase();
            } else {
                self.hide();
            }
            self.authority = Some(grant);
        } else {
            self.fence();
        }
        result
    }
    pub fn disconnect(&mut self) {
        self.stream.disconnect();
        self.fence();
    }
    pub fn revoke(&mut self) {
        self.stream.revoke();
        self.erase();
    }
    pub fn dispose(&mut self) {
        self.stream.dispose();
        self.erase();
    }
    pub fn tick(&mut self, now: u64) -> Result<(), ErrorCode> {
        let result = self.stream.tick(now);
        self.fence();
        result
    }
    fn hide(&mut self) {
        self.rows.clear();
        self.next = None;
        for slot in &mut self.slots {
            slot.row = None;
        }
    }
    fn erase(&mut self) {
        self.hide();
        self.slots.clear();
        self.custody = ListCustody::default();
        self.authority = None;
        self.observed_epoch = None;
    }
    fn fence(&mut self) {
        match self.stream.view().state {
            StreamState::Revoked | StreamState::Disposed => self.erase(),
            StreamState::Live => (),
            _ => self.hide(),
        }
    }
    fn retained_budget(&self, page: &ListPage) -> Result<(), ErrorCode> {
        let bytes = serde_json::to_vec(&page.rows)
            .map_err(|_| ErrorCode::PayloadTooLarge)?
            .len();
        if bytes.saturating_mul(2) > self.plan.config.max_retained_bytes as usize {
            return Err(ErrorCode::PayloadTooLarge);
        }
        Ok(())
    }
    pub fn snapshot(&mut self, mut snapshot: Snapshot, now: u64) -> Result<Receive, ErrorCode> {
        let data = payload::Payload::new(std::mem::take(&mut snapshot.data));
        self.tick(now)?;
        data.size(self.plan.config.stream.max_payload_bytes)?;
        snapshot.data = data.into_inner();
        let page: ListPage =
            serde_json::from_value(snapshot.data.clone()).map_err(|_| ErrorCode::InvalidFrame)?;
        self.plan.validate_page(
            &page,
            &Cursor {
                epoch: snapshot.epoch.clone(),
                revision: snapshot.revision.clone(),
            },
        )?;
        self.retained_budget(&page)?;
        let state = self.stream.view();
        if state.state == StreamState::Syncing
            && state.generation == snapshot.generation
            && self.observed_epoch.as_ref() == Some(&snapshot.epoch)
        {
            let known: std::collections::HashMap<_, _> = self
                .slots
                .iter()
                .map(|slot| (&slot.id, &slot.observed_revision))
                .collect();
            for row in &page.rows {
                if let Some(previous) = known.get(&row.id)
                    && stream::revision(&row.revision)? < stream::revision(previous)?
                {
                    return Err(ErrorCode::InvalidRevision);
                }
            }
        }
        let epoch = snapshot.epoch.clone();
        let received = self.stream.snapshot(snapshot, now);
        self.fence();
        let received = received?;
        if received == Receive::Accepted {
            self.observed_epoch = Some(epoch);
            self.stream.take(u32::MAX, now)?;
            self.rows = page.rows;
            self.next = page.next;
            if self.slots.is_empty() {
                self.accept_changes()?;
            } else {
                self.reconcile(&[]);
            }
        }
        Ok(received)
    }
    pub fn event(&mut self, mut event: Event, now: u64) -> Result<Receive, ErrorCode> {
        let data = payload::Payload::new(std::mem::take(&mut event.data));
        self.tick(now)?;
        data.size(self.plan.config.stream.max_payload_bytes)?;
        event.data = data.into_inner();
        let patch: ListPatch =
            serde_json::from_value(event.data.clone()).map_err(|_| ErrorCode::InvalidFrame)?;
        if patch.request_key != self.key() {
            return Err(ErrorCode::InvalidFrame);
        }
        let view = self.stream.view();
        let prospective = if view.state == StreamState::Live
            && view.generation == event.generation
            && view.scope == event.scope
            && view.cursor.as_ref().is_some_and(|cursor| {
                cursor.epoch == event.epoch && cursor.revision == event.previous
            }) {
            Some(self.plan.apply_patch(
                &Cursor {
                    epoch: event.epoch.clone(),
                    revision: event.revision.clone(),
                },
                &ListPage {
                    request_key: self.key(),
                    rows: self.rows.clone(),
                    next: self.next.clone(),
                },
                &patch,
            )?)
        } else {
            None
        };
        if let Some(page) = &prospective {
            self.retained_budget(page)?;
        }
        let received = self.stream.event(event, now);
        self.fence();
        let received = received?;
        if received == Receive::Accepted {
            self.stream.take(u32::MAX, now)?;
            let page = prospective.ok_or(ErrorCode::InvalidFrame)?;
            self.rows = page.rows;
            self.next = page.next;
            self.reconcile(&patch.departures);
        }
        Ok(received)
    }
    fn reconcile(&mut self, departures: &[ListDeparture]) {
        for (index, slot) in self.slots.iter_mut().enumerate() {
            if let Some(row) = self.rows.iter().find(|row| row.id == slot.id) {
                slot.conflict |=
                    self.custody.dirty.contains(&row.id) && slot.observed_revision != row.revision;
                slot.observed_revision = row.revision.clone();
                slot.row = Some(row.clone());
                slot.departure = None;
                slot.moved = self.rows.iter().position(|row| row.id == slot.id) != Some(index);
            } else {
                slot.row = None;
                slot.departure = Some(
                    departures
                        .iter()
                        .find(|d| d.id == slot.id)
                        .map_or(slot.departure.unwrap_or(DepartureReason::WindowExit), |d| {
                            d.reason
                        }),
                );
                slot.conflict |= self.custody.dirty.contains(&slot.id);
            }
        }
    }
    pub fn view(&self) -> ListView {
        let order: Vec<_> = self.rows.iter().map(|row| row.id.clone()).collect();
        let unchanged = self.slots.iter().map(|slot| &slot.id).eq(order.iter());
        ListView {
            stream: self.stream.view(),
            request_key: self.key(),
            slots: self.slots.clone(),
            pending_order: if unchanged { vec![] } else { order },
            pending: !unchanged,
            next: self.next.clone(),
            custody: self.custody.clone(),
        }
    }
}
