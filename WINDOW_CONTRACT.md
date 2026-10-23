# RevisionedWindow contract

`@frankfmy/realine-core/window` exposes `RevisionedWindow`, a local adapter for a complete,
already authorized loaded selection. Call `init_realine(bytes)` from the root export before
constructing it. Initialization is explicit and synchronous once bytes are available; fetching
or reading those bytes is asynchronous. A cold constructor reports `not_ready`.

The returned aggregate view is for local presentation; its first partition request key is not a
wire identity for the full selection.

The caller owns selection, filtering, ordering, authorization, payload validation and total
loaded-row and payload-byte quotas. `update(cursor, rows)` supplies a complete current selection,
not a delta or an unbounded server query. There is no total row cap or truncation in this adapter.
The native engines see bounded identity/revision projections in partitions of 250 rows. Their
existing limits still apply. Complete host-admitted values are retained in one current projection
outside the native ordering engine; they do not acquire the native JSON payload-byte guarantee.
A large admitted value can therefore exceed a native wire frame. Hosts must bound those values
before calling this adapter. This distinction is intentional and is tested.

The Rust list engines own membership reconciliation and deferred ordering in each partition.
While changes are pending, visible slot identities stay stable; a retained record exposes its
current value even if it crosses a partition. `pending_order` is the global desired order.
`accept()` adopts the pending structure. Dirty custody requires explicit release first. Focus,
selection and scroll anchor follow surviving identities across partitions. Anchors use integer
pixels; fractional inputs are rounded.

The host binds a cursor to immutable complete input. While live, a changed value or order at the
same epoch and revision is `invalid_revision`. Suspension clears retained values, so payload
identity across a reconnect remains a host responsibility; native cursor and observed record
revision floors still apply. Revisions and identifiers use the native protocol constraints.
Duplicate identities, including across partitions, are invalid. Epoch changes start a new
baseline. Disconnect/recovery must not expose stale values as ready.

`suspend()` hides current payloads while retaining visible identities and interaction custody.
A later `update` can restore a current baseline. `revoke()` erases values and custody and requires
an explicit new authorized update. `stop()` frees every native handle and is terminal and
idempotent. A local handle does not grant server access or detect authorization changes itself.
The host must call revoke/stop when its authority or owning context ends.

This is not a paging provider, database, transport, UI controller, draft store or second list
materializer. Use `ListHub`, `ListClient` and `ListPlan` for authorized bounded wire pages. Use
this adapter only for a selection already loaded and admitted by the host.
