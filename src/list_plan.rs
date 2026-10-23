use crate::*;
use std::collections::HashSet;

/// Bounded canonical identity and page admission, shared by native hosts and Wasm clients.
pub struct ListPlan {
    pub(crate) request: ListRequest,
    pub(crate) config: ListConfig,
    pub(crate) query_key: String,
    pub(crate) request_key: String,
}
impl ListPlan {
    pub fn advance(&self, before: &Cursor, after: &Cursor) -> Result<CursorAdvance, ErrorCode> {
        if !validate::identifier(&before.epoch) || !validate::identifier(&after.epoch) {
            return Err(ErrorCode::InvalidFrame);
        }
        let old = stream::revision(&before.revision)?;
        let next = stream::revision(&after.revision)?;
        if before.epoch != after.epoch {
            return Ok(CursorAdvance::Epoch);
        }
        match next.cmp(&old) {
            std::cmp::Ordering::Less => Err(ErrorCode::Stale),
            std::cmp::Ordering::Equal => Ok(CursorAdvance::Same),
            std::cmp::Ordering::Greater => Ok(CursorAdvance::Newer),
        }
    }
    pub fn new(mut request: ListRequest, config: ListConfig) -> Result<Self, ErrorCode> {
        let filter = payload::Payload::new(std::mem::take(&mut request.query.filter));
        filter.size(4096)?;
        validate::scope(&request.query.scope)?;
        if config.max_rows == 0
            || config.stream.max_payload_bytes > 262_144
            || config.max_rows > 1000
            || config.max_retained_bytes == 0
            || config.max_retained_bytes > 4_194_304
            || request.query.limit == 0
            || request.query.limit > config.max_rows
            || request.query.sort.len() > 8
        {
            return Err(ErrorCode::InvalidConfig);
        }
        Stream::new(request.query.scope.clone(), config.stream)?;
        let mut fields = HashSet::new();
        if !validate::identifier(&request.query.projection)
            || !validate::identifier(&request.query.access)
            || request
                .query
                .sort
                .iter()
                .any(|sort| !validate::identifier(&sort.field) || !fields.insert(&sort.field))
        {
            return Err(ErrorCode::InvalidFrame);
        }
        request.query.filter = filter.into_inner();
        let query_key =
            serde_json::to_string(&request.query).map_err(|_| ErrorCode::InvalidFrame)?;
        if query_key.len() > 8192 {
            return Err(ErrorCode::PayloadTooLarge);
        }
        if let Some(cursor) = &request.after {
            validate_cursor(cursor, &query_key)?;
        }
        let request_key = serde_json::to_string(&request).map_err(|_| ErrorCode::InvalidFrame)?;
        if request_key.len() > 32768 {
            return Err(ErrorCode::PayloadTooLarge);
        }
        Ok(Self {
            request,
            config,
            query_key,
            request_key,
        })
    }
    pub fn key(&self) -> &str {
        &self.request_key
    }
    pub fn page(
        &self,
        cursor: &Cursor,
        mut rows: Vec<ListRow>,
        has_more: bool,
    ) -> Result<ListPage, ErrorCode> {
        // Adopt every native value before rejection can recursively drop a later deep row.
        let values: Vec<_> = rows
            .iter_mut()
            .map(|row| payload::Payload::new(std::mem::take(&mut row.value)))
            .collect();
        for value in &values {
            value.size(self.config.stream.max_payload_bytes)?;
        }
        for (row, value) in rows.iter_mut().zip(values) {
            row.value = value.into_inner();
        }
        let next = if has_more {
            let last = rows.last().ok_or(ErrorCode::InvalidFrame)?;
            Some(PageCursor {
                query_key: self.query_key.clone(),
                epoch: cursor.epoch.clone(),
                revision: cursor.revision.clone(),
                anchor_id: last.id.clone(),
                anchor_revision: last.revision.clone(),
            })
        } else {
            None
        };
        let page = ListPage {
            request_key: self.request_key.clone(),
            rows,
            next,
        };
        self.validate_page(&page, cursor)?;
        Ok(page)
    }
    pub fn diff(
        &self,
        cursor: &Cursor,
        before: &ListPage,
        after: &ListPage,
        departures: Vec<ListDeparture>,
    ) -> Result<ListPatch, ErrorCode> {
        self.bounded_rows(&before.rows)?;
        self.validate_page(after, cursor)?;
        if before.request_key != self.request_key
            || before.rows.len() > self.request.query.limit as usize
            || departures.len() > before.rows.len()
        {
            return Err(ErrorCode::InvalidFrame);
        }
        let old: std::collections::HashMap<_, _> = before.rows.iter().map(|r| (&r.id, r)).collect();
        if old.len() != before.rows.len() {
            return Err(ErrorCode::InvalidFrame);
        }
        let mut upserts = vec![];
        for row in &after.rows {
            if let Some(previous) = old.get(&row.id) {
                row_transition(previous, row)?;
                if previous != &row {
                    upserts.push(row.clone());
                }
            } else {
                upserts.push(row.clone());
            }
        }
        let present: HashSet<_> = after.rows.iter().map(|r| &r.id).collect();
        let mut reasons = std::collections::HashMap::new();
        for departure in departures {
            if !old.contains_key(&departure.id)
                || present.contains(&departure.id)
                || reasons.insert(departure.id, departure.reason).is_some()
            {
                return Err(ErrorCode::InvalidFrame);
            }
        }
        let departures = before
            .rows
            .iter()
            .filter(|r| !present.contains(&r.id))
            .map(|r| ListDeparture {
                id: r.id.clone(),
                reason: reasons
                    .get(&r.id)
                    .copied()
                    .unwrap_or(DepartureReason::WindowExit),
            })
            .collect();
        let patch = ListPatch {
            request_key: self.request_key.clone(),
            upserts,
            departures,
            order: after.rows.iter().map(|r| r.id.clone()).collect(),
            next: after.next.clone(),
        };
        self.wire_budget(&patch)?;
        Ok(patch)
    }
    pub fn apply_patch(
        &self,
        cursor: &Cursor,
        before: &ListPage,
        patch: &ListPatch,
    ) -> Result<ListPage, ErrorCode> {
        self.bounded_rows(&before.rows)?;
        self.bounded_rows(&patch.upserts)?;
        if patch.request_key != self.request_key
            || patch.upserts.len() > self.request.query.limit as usize
            || patch.departures.len() > self.request.query.limit as usize
            || patch.order.len() > self.request.query.limit as usize
        {
            return Err(ErrorCode::InvalidFrame);
        }
        let mut available: std::collections::HashMap<_, _> =
            before.rows.iter().map(|r| (&r.id, r)).collect();
        let mut upserts = HashSet::new();
        for row in &patch.upserts {
            if !upserts.insert(&row.id) {
                return Err(ErrorCode::InvalidFrame);
            }
            available.insert(&row.id, row);
        }
        let rows = patch
            .order
            .iter()
            .map(|id| {
                available
                    .get(id)
                    .map(|row| (*row).clone())
                    .ok_or(ErrorCode::InvalidFrame)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let after = ListPage {
            request_key: self.request_key.clone(),
            rows,
            next: patch.next.clone(),
        };
        if self.diff(cursor, before, &after, patch.departures.clone())? != *patch {
            return Err(ErrorCode::InvalidFrame);
        }
        Ok(after)
    }
    pub fn query_key(&self) -> &str {
        &self.query_key
    }
    pub fn validate_page(&self, page: &ListPage, cursor: &Cursor) -> Result<(), ErrorCode> {
        self.bounded_rows(&page.rows)?;
        self.wire_budget(page)?;
        if page.request_key != self.request_key || !validate::identifier(&cursor.epoch) {
            return Err(ErrorCode::InvalidFrame);
        }
        stream::revision(&cursor.revision)?;
        if let Some(after) = &self.request.after
            && (after.epoch != cursor.epoch
                || stream::revision(&after.revision)? > stream::revision(&cursor.revision)?)
        {
            return Err(ErrorCode::Stale);
        }
        if page.rows.len() > self.request.query.limit as usize {
            return Err(ErrorCode::PayloadTooLarge);
        }
        let mut ids = HashSet::new();
        for row in &page.rows {
            if !validate::identifier(&row.id) || !ids.insert(&row.id) {
                return Err(ErrorCode::InvalidFrame);
            }
            stream::revision(&row.revision)?;
        }
        if let Some(next) = &page.next {
            validate_cursor(next, &self.query_key)?;
            let last = page.rows.last().ok_or(ErrorCode::InvalidFrame)?;
            if next.epoch != cursor.epoch
                || next.revision != cursor.revision
                || next.anchor_id != last.id
                || next.anchor_revision != last.revision
            {
                return Err(ErrorCode::InvalidFrame);
            }
        }
        Ok(())
    }
    fn wire_budget<T: serde::Serialize>(&self, value: &T) -> Result<(), ErrorCode> {
        let data = serde_json::to_value(value).map_err(|_| ErrorCode::InvalidFrame)?;
        payload::Payload::new(data).size(self.config.stream.max_payload_bytes)?;
        Ok(())
    }
    fn bounded_rows(&self, rows: &[ListRow]) -> Result<(), ErrorCode> {
        if rows.len() > self.request.query.limit as usize {
            return Err(ErrorCode::PayloadTooLarge);
        }
        let mut size = 0u64;
        for row in rows {
            size += u64::from(payload::Payload::measure(
                &row.value,
                self.config.stream.max_payload_bytes,
            )?);
        }
        if size > u64::from(self.config.stream.max_payload_bytes) {
            return Err(ErrorCode::PayloadTooLarge);
        }
        Ok(())
    }
}
fn validate_cursor(cursor: &PageCursor, key: &str) -> Result<(), ErrorCode> {
    if cursor.query_key != key
        || !validate::identifier(&cursor.epoch)
        || !validate::identifier(&cursor.anchor_id)
    {
        return Err(ErrorCode::InvalidFrame);
    }
    stream::revision(&cursor.revision)?;
    stream::revision(&cursor.anchor_revision)?;
    Ok(())
}

pub(crate) fn row_transition(before: &ListRow, after: &ListRow) -> Result<(), ErrorCode> {
    let old = stream::revision(&before.revision)?;
    let new = stream::revision(&after.revision)?;
    if new < old || (new == old && before.value != after.value) {
        return Err(ErrorCode::InvalidRevision);
    }
    Ok(())
}
