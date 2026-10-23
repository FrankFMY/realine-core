use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// Identifies a single consumer-owned security and data boundary. It grants no access.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    pub product: String,
    pub tenant: String,
    pub resource: String,
    pub channel: String,
}

/// Current server-verified session information, not a bearer credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Grant {
    pub scope: Scope,
    pub actor_id: String,
    pub session_id: String,
    pub permission_version: String,
    #[ts(type = "number")]
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct StreamConfig {
    pub max_events: u32,
    pub max_buffer_bytes: u32,
    pub max_payload_bytes: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum StreamState {
    Dormant,
    Syncing,
    Live,
    Uncertain,
    Revoked,
    Disposed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Cursor {
    pub epoch: String,
    pub revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SyncRequest {
    pub generation: u32,
    pub scope: Scope,
    pub session_id: String,
    pub permission_version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub scope: Scope,
    pub generation: u32,
    pub epoch: String,
    pub revision: String,
    pub data: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub scope: Scope,
    pub generation: u32,
    pub epoch: String,
    pub previous: String,
    pub revision: String,
    pub data: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Delivery {
    Snapshot { cursor: Cursor, data: Value },
    Event { cursor: Cursor, data: Value },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SyncReason {
    Gap,
    Epoch,
    Overflow,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Receive {
    Accepted,
    Duplicate,
    Ignored,
    Resync {
        request: SyncRequest,
        reason: SyncReason,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct StreamView {
    pub scope: Scope,
    pub state: StreamState,
    pub generation: u32,
    pub cursor: Option<Cursor>,
    pub queued_events: u32,
    pub queued_bytes: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidConfig,
    InvalidScope,
    InvalidGrant,
    InvalidTime,
    InvalidRevision,
    InvalidFrame,
    PayloadTooLarge,
    Denied,
    Expired,
    Disposed,
    NotReady,
    Busy,
    Stale,
    Exhausted,
    Storage,
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for ErrorCode {}
