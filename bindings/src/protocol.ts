// Generated from the Rust protocol. Regenerate with the package build; do not edit.

export type JsonValue = number | string | boolean | Array<JsonValue> | { [key in string]: JsonValue } | null;

export type Scope = { product: string; tenant: string; resource: string; channel: string };

export type Grant = { scope: Scope; actor_id: string; session_id: string; permission_version: string; expires_at_ms: number };

export type StreamConfig = { max_events: number; max_buffer_bytes: number; max_payload_bytes: number };

export type StreamState = "dormant" | "syncing" | "live" | "uncertain" | "revoked" | "disposed";

export type Cursor = { epoch: string; revision: string };

export type SyncRequest = { generation: number; scope: Scope; session_id: string; permission_version: string };

export type Snapshot = { scope: Scope; generation: number; epoch: string; revision: string; data: JsonValue };

export type Event = { scope: Scope; generation: number; epoch: string; previous: string; revision: string; data: JsonValue };

export type Delivery = { kind: "snapshot"; cursor: Cursor; data: JsonValue } | { kind: "event"; cursor: Cursor; data: JsonValue };

export type SyncReason = "gap" | "epoch" | "overflow";

export type Receive =
	| { kind: "accepted" }
	| { kind: "duplicate" }
	| { kind: "ignored" }
	| { kind: "resync"; request: SyncRequest; reason: SyncReason };

export type StreamView = {
	scope: Scope;
	state: StreamState;
	generation: number;
	cursor: Cursor | null;
	queued_events: number;
	queued_bytes: number;
};

export type ErrorCode =
	| "invalid_config"
	| "invalid_scope"
	| "invalid_grant"
	| "invalid_time"
	| "invalid_revision"
	| "invalid_frame"
	| "payload_too_large"
	| "denied"
	| "expired"
	| "disposed"
	| "not_ready"
	| "busy"
	| "stale"
	| "exhausted"
	| "storage";

export type StreamAction =
	| { kind: "open"; grant: Grant }
	| { kind: "snapshot"; snapshot: Snapshot }
	| { kind: "event"; event: Event }
	| { kind: "take"; limit: number }
	| { kind: "tick" }
	| { kind: "view" }
	| { kind: "disconnect" }
	| { kind: "revoke" }
	| { kind: "dispose" };

export type StreamInput = { now_ms: number; action: StreamAction };

export type StreamResult =
	| { kind: "none" }
	| { kind: "sync"; request: SyncRequest }
	| { kind: "receive"; received: Receive }
	| { kind: "deliveries"; items: Array<Delivery> };

export type StreamOutput = { view: StreamView; result: StreamResult };

export type BindingReply<T> = { status: "ok"; value: T } | { status: "error"; code: ErrorCode };

export type PresenceKey = { actor_id: string; session_id: string; connection_id: string };

export type PresenceConfig = { idle_after_ms: number; uncertain_after_ms: number; offline_after_ms: number };

export type PresenceSignal = "active" | "idle" | "heartbeat" | "uncertain" | "offline" | "tick";

export type PresenceState = "offline" | "active" | "idle" | "uncertain";

export type PresenceLifecycle = "dormant" | "open" | "revoked" | "disposed";

export type PresenceView = {
	scope: Scope;
	key: PresenceKey;
	lifecycle: PresenceLifecycle;
	state: PresenceState;
	last_seen_ms: number | null;
	last_active_ms: number | null;
	observed_at_ms: number;
};

export type PresenceEntry = {
	scope: Scope;
	key: PresenceKey;
	sequence: number;
	from: PresenceState;
	to: PresenceState;
	reason: PresenceSignal;
	observed_at_ms: number;
	last_seen_ms: number | null;
	last_active_ms: number | null;
};

export type PreparedPresence = { ticket: number; view: PresenceView; entry: PresenceEntry | null };

export type PresenceAction =
	| { kind: "prepare"; grant: Grant; signal: PresenceSignal }
	| { kind: "commit"; ticket: number; grant: Grant }
	| { kind: "pending"; grant: Grant }
	| { kind: "view" }
	| { kind: "revoke" }
	| { kind: "dispose" };

export type PresenceInput = { now_ms: number; action: PresenceAction };

export type PresenceOutput = { view: PresenceView; pending: PreparedPresence | null };

export type SortDirection = "asc" | "desc";

export type MissingPosition = "first" | "last";

export type ListSort = { field: string; direction: SortDirection; missing: MissingPosition };

export type ListQuery = { scope: Scope; projection: string; access: string; filter: JsonValue; sort: Array<ListSort>; limit: number };

export type PageCursor = { query_key: string; epoch: string; revision: string; anchor_id: string; anchor_revision: string };

export type ListRequest = { query: ListQuery; after: PageCursor | null };

export type ListConfig = { stream: StreamConfig; max_rows: number; max_retained_bytes: number };

export type ListRow = { id: string; revision: string; value: JsonValue };

export type ListPage = { request_key: string; rows: Array<ListRow>; next: PageCursor | null };

export type DepartureReason = "deleted" | "filter_exit" | "moved_out" | "window_exit";

export type ListDeparture = { id: string; reason: DepartureReason };

export type ListPatch = {
	request_key: string;
	upserts: Array<ListRow>;
	departures: Array<ListDeparture>;
	order: Array<string>;
	next: PageCursor | null;
};

export type ScrollAnchor = { id: string; offset_px: number };

export type ListCustody = { focus: string | null; selection: Array<string>; anchor: ScrollAnchor | null; dirty: Array<string> };

export type ListSlot = {
	id: string;
	observed_revision: string;
	row: ListRow | null;
	departure: DepartureReason | null;
	moved: boolean;
	conflict: boolean;
};

export type ListView = {
	stream: StreamView;
	request_key: string;
	slots: Array<ListSlot>;
	pending_order: Array<string>;
	pending: boolean;
	next: PageCursor | null;
	custody: ListCustody;
};

export type ListAction =
	| { kind: "stream"; action: StreamAction }
	| { kind: "custody"; custody: ListCustody }
	| { kind: "accept" }
	| { kind: "view" };

export type ListInput = { now_ms: number; action: ListAction };

export type ListOutput = { view: ListView; result: StreamResult };

export type ListPlanAction =
	| { kind: "advance"; before: Cursor; after: Cursor }
	| { kind: "page"; cursor: Cursor; rows: Array<ListRow>; has_more: boolean }
	| { kind: "diff"; cursor: Cursor; before: ListPage; after: ListPage; departures: Array<ListDeparture> };

export type ListPlanOutput =
	| { kind: "advance"; advance: CursorAdvance }
	| { kind: "page"; page: ListPage }
	| { kind: "patch"; patch: ListPatch };

export type CursorAdvance = "same" | "newer" | "epoch";
