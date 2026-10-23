# API guide

All JavaScript APIs are ESM. Load bytes and call `init_realine(bytesOrWebAssemblyModule)` before
constructing native-backed objects. It returns void, not a readiness promise. `wasm_url` resolves
the adjacent asset. `RealineError.code` exposes the Rust error vocabulary; errors contain no grant
secrets or domain payload text.

## Streams

`StreamCore(scope, config)` provides `open(grant, now_ms)`, `dispatch(action, now_ms)`, `view()` and
idempotent terminal `dispose()`. Dispatch returns `{view, result}`; inspect the discriminant before
using result fields. Decimal string revisions avoid JavaScript integer rounding.

`Subscription<T>(options)` owns its core (including an injected `StreamDriver`) and transport
lifetime. Supply `scope`, `config`, `now`, `decode`, `transport` and optionally `changed`.
`connect()` starts one authorization/listen/snapshot attempt. `listen` must finish installing
delivery before resolving its disposer; `snapshot` supplies a consistent authorized baseline.
`ready()` waits for outstanding recovery, including a new generation requested during the prior
attempt. Concurrent connect is `busy`. `pull(limit)` returns decoded deliveries. `tick`,
`disconnect`, `revoke`, `dispose`, `view`, and `error` are explicit lifecycle surfaces.
A settled promise can reflect cancellation; check state and error before rendering.

## Presence

`PresenceCore(scope, key, config)` provides `dispatch`, `view`, `dispose`. Presence is per exact
actor/session/connection, with injected server time and one pending observation.
`PresenceHost(core, provider, now)` owns that core. The provider implements `current` and
transactional, idempotent `store`. `observe(signal)` prepares, stores and commits; `retry()` retries
the identical pending proposal after an ambiguous storage acknowledgement. `revoke()` and
`dispose()` fence late local commits. They do not roll back external storage.

## Lists

`ListPlan(request, config?)` exposes `key`, `query_key`, `page(cursor, rows, has_more)`,
`advance(before, after)`, `diff(cursor, before, after, departures?)`, and `dispose`.
It validates and constructs pages/deltas; it does not select or sort database rows.
`ListCore(request, config?)` adds a materialized native window with `open`, `dispatch`, `action`,
`window`, `view`, `custody`, `accept`, and `dispose`.

`ListClient<Row, Draft>(options)` supplies decoding and a separate JSON draft budget. Use
`connect`, `ready`, `view`, `edit`, `clear_draft`, `interaction`, `accept`, `tick`, `disconnect`,
`revoke` and `dispose`. Key rendering by slot ID. A departed dirty record cannot be discarded by
acceptance without explicit draft release.

`ListHub<Context>(options)` requires a provider, clock and explicit group/subscriber/refresh quotas.
`authorize` obtains the current permitted request. `transport` implements the in-process stream
seam. `invalidate` schedules coalesced reads; `flush` drains them. `stats`, `authorizing`, and
`dispose` expose lifecycle custody. The provider certifies access-equivalent groups and owns
transactional visibility, filtering, sorting, cursor anchors and complete invalidation.
The runnable Bun/SQLite example is `consumers/sql-lists.ts`; it uses only the public package.

## Loaded windows

`RevisionedWindow(scope, projection, filter?)` consumes complete host-admitted selections via
`update(cursor, rows)`. `view()` returns stable visible slots, current values and a global pending
order. `interaction(custody)` carries focus, selection, dirty IDs and anchor. `accept()` adopts
structure only after dirty custody is released. `suspend()` hides values for reconnect;
`revoke()` erases local authority-dependent state; `stop()` is terminal. Read
[WINDOW_CONTRACT.md](WINDOW_CONTRACT.md) for the distinction between host payload budgets and
bounded native identity projections.

## Native Rust

The crate reexports protocol types, `Stream`, `Presence`, `PresenceHost`, `PresenceAuthority`,
`PresenceStorage`, `ListPlan`, `ListWindow` and JSON facades from its root. Native methods return
`Result<_, ErrorCode>`. The JSON facades return tagged `BindingReply<T>` values and use the same
validation as Wasm. `examples/types.rs` is the declaration generator; edit owning Rust protocol
structures and regenerate rather than editing generated TypeScript.
