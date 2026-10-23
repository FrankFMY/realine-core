use crate::*;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum StreamAction {
    Open { grant: Grant },
    Snapshot { snapshot: Snapshot },
    Event { event: Event },
    Take { limit: u32 },
    Tick {},
    View {},
    Disconnect {},
    Revoke {},
    Dispose {},
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct StreamInput {
    #[ts(type = "number")]
    pub now_ms: u64,
    pub action: StreamAction,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum StreamResult {
    None,
    Sync { request: SyncRequest },
    Receive { received: Receive },
    Deliveries { items: Vec<Delivery> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct StreamOutput {
    pub view: StreamView,
    pub result: StreamResult,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum BindingReply<T> {
    Ok { value: T },
    Error { code: ErrorCode },
}
