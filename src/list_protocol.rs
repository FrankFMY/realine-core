use crate::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SortDirection {
    Asc,
    Desc,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum MissingPosition {
    First,
    Last,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ListSort {
    pub field: String,
    pub direction: SortDirection,
    pub missing: MissingPosition,
}

/// Access is a provider-certified equivalence class, never client-supplied authority.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ListQuery {
    pub scope: Scope,
    pub projection: String,
    pub access: String,
    pub filter: Value,
    pub sort: Vec<ListSort>,
    pub limit: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PageCursor {
    pub query_key: String,
    pub epoch: String,
    pub revision: String,
    pub anchor_id: String,
    pub anchor_revision: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ListRequest {
    pub query: ListQuery,
    pub after: Option<PageCursor>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ListConfig {
    pub stream: StreamConfig,
    pub max_rows: u32,
    pub max_retained_bytes: u32,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ListRow {
    pub id: String,
    pub revision: String,
    pub value: Value,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ListPage {
    pub request_key: String,
    pub rows: Vec<ListRow>,
    pub next: Option<PageCursor>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum DepartureReason {
    Deleted,
    FilterExit,
    MovedOut,
    WindowExit,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ListDeparture {
    pub id: String,
    pub reason: DepartureReason,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ListPatch {
    pub request_key: String,
    pub upserts: Vec<ListRow>,
    pub departures: Vec<ListDeparture>,
    pub order: Vec<String>,
    pub next: Option<PageCursor>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ScrollAnchor {
    pub id: String,
    pub offset_px: i32,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ListCustody {
    pub focus: Option<String>,
    pub selection: Vec<String>,
    pub anchor: Option<ScrollAnchor>,
    pub dirty: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ListSlot {
    pub id: String,
    pub observed_revision: String,
    pub row: Option<ListRow>,
    pub departure: Option<DepartureReason>,
    pub moved: bool,
    pub conflict: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ListView {
    pub stream: StreamView,
    pub request_key: String,
    pub slots: Vec<ListSlot>,
    pub pending_order: Vec<String>,
    pub pending: bool,
    pub next: Option<PageCursor>,
    pub custody: ListCustody,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ListAction {
    Stream { action: StreamAction },
    Custody { custody: ListCustody },
    Accept {},
    View {},
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ListInput {
    #[ts(type = "number")]
    pub now_ms: u64,
    pub action: ListAction,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ListOutput {
    pub view: ListView,
    pub result: StreamResult,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ListPlanAction {
    Advance {
        before: Cursor,
        after: Cursor,
    },
    Page {
        cursor: Cursor,
        rows: Vec<ListRow>,
        has_more: bool,
    },
    Diff {
        cursor: Cursor,
        before: Box<ListPage>,
        after: Box<ListPage>,
        departures: Vec<ListDeparture>,
    },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ListPlanOutput {
    Advance { advance: CursorAdvance },
    Page { page: ListPage },
    Patch { patch: ListPatch },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum CursorAdvance {
    Same,
    Newer,
    Epoch,
}
