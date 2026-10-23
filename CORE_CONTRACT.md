# Realine core contract

Maintainer/developer contract for `realine-core` and `@frankfmy/realine-core`. This library is
independent of application authoring, execution and business storage. Rust owns stream ordering,
state transitions, validation and presence proposals. TypeScript contains transport/I/O
orchestration and Wasm lifetime management, not an alternative stream or presence algorithm.

## Authority and identity

`Scope` contains four exact consumer-owned identifiers: `product`, `tenant`, `resource`, `channel`.
Each is nonempty UTF-8, at most 128 bytes, without control characters. Identifiers are not
normalized. A descriptor is not a grant and there is no global room, implicit administrator or
default tenant.

`Grant` carries that exact scope, `actor_id`, `session_id`, `permission_version` and fixed
`expires_at_ms`. It contains no bearer secret. It must originate from the host's current
authenticated session/permission path; passing a well-shaped object to a local core cannot grant
server access. Actor/session/version identifiers have the same 128-byte bound. No library method
queries a user schema, database, cookie, environment or provider implicitly.

The server independently authorizes subscription and every snapshot/query/command. It must deliver
revocation/disconnection to the live handle. Client expiry is conservative local fencing, not a
replacement for current server authorization. A changed view/permission needs its own current
scope/version and authoritative baseline. No result here grants business write access.

Times are nonnegative integral milliseconds, at most 9007199254740991, monotonically nondecreasing
within an instance. Server presence uses the host's clock, never a timestamp from an untrusted ping.
A backwards host clock is an explicit `invalid_time`, not an invitation to extend a session.

## Scoped stream

`Stream::new(scope, config)` starts `dormant`. `open(grant, now)` validates the exact scope and
expiry, clears delivery bytes and returns a fresh generation-bound `SyncRequest`; state becomes
`syncing`. The host installs delivery before reading an authorized consistent snapshot. Frames carry
the exact scope and local generation, an opaque epoch and a decimal revision. An obsolete generation
is ignored.

Revisions are canonical decimal strings in 0..9223372036854775807, avoiding JavaScript rounding.
Events include `previous` and `revision`, with `previous < revision`. They form a causal per-stream
chain; numbers need not be consecutive. The provider binds an epoch to one immutable ordered history
and must not reuse it after resetting that history. A snapshot is a consistent full baseline, not an
arbitrary patch. Domain payload validation remains with the consumer.

- Snapshot acceptance enqueues one `snapshot` delivery and enters `live`.
- An event with the current predecessor enqueues an `event`; a repeated/older revision in the same
  epoch is a duplicate and is not redelivered.
- A predecessor gap, new epoch or buffer overflow clears unconsumed data and produces one fresh
  `resync` request. The detecting event establishes a minimum baseline for that epoch.
- Events received while synchronizing advance that minimum without retaining payloads. A snapshot
  below it is `stale`; a different epoch requests another fresh synchronization. There is no silent
  application of an incomplete suffix. An epoch change during recovery is recoverable too.
- Disconnect clears payloads and marks `uncertain`. Reconnect requires fresh authorization and a
  full baseline, not replay from a cached unacknowledged cursor. A same-actor/session/permission
  reconnect retains only the known revision floor, so a known epoch cannot regress. Revocation or
  changed authority discards that floor.
- Expiry and revocation clear queue, cursor, session and recovery metadata. `revoked` is not
  downgraded by a later disconnect. A new explicit authorized `open` is required to recover.
- Disposal is terminal and idempotent. It retains no queue/cursor/grant; reopening is `disposed`.

`take(limit, now)` drains at most that many deliveries and checks session expiry first. Taking data
transfers it to the host; the library does not own the application's materialized view. A host must
clear/protect that view on revocation and must not render a discarded cache as an authoritative
empty result. Preserve drafts separately. This contract does not define business command receipts.

## Bounds and backpressure

Per-stream configuration is explicit, without ambient defaults:

| Setting             | Admitted range                                                               |
| ------------------- | ---------------------------------------------------------------------------- |
| `max_events`        | 1..1024 queued deliveries                                                    |
| `max_buffer_bytes`  | 1..4194304 total queued payload JSON bytes                                   |
| `max_payload_bytes` | 1..1048576 and no greater than `max_buffer_bytes`                            |
| Payload structure   | At most 32 nested levels; node traversal also bounded by payload byte budget |
| Portable request    | At most 1056768 UTF-8 bytes, including envelope                              |

The byte counter counts serialized business payload bytes; bounded envelope/identity overhead is
additional and bounded by event count and identifier limits. Overflow requests a full resync instead
of dropping an event while claiming `live`. Native payloads are adopted before fallible checks and
rejected values are destroyed iteratively, including denial, avoiding recursive-drop stack overflow.
Caller-allocated native input is not an allocation quota: hosts must also bound input before
building arbitrary `serde_json::Value`s. Accepted retained values and serializer traversal are
bounded.

Wasm uses the same Rust methods. The thin JSON boundary rejects unsupported/lossy JS values such as
NaN, Infinity, undefined properties and bigint instead of silently converting/omitting them. Only
JSON-compatible consumer data is admitted. There is no arbitrary native pointer/unsafe FFI API.

The TS `Subscription` keeps one I/O attempt and one coalesced resync request, with no unbounded
promise queue. Concurrent starts return `busy`. Abort is a cancellation signal, not proof that an
external operation rolled back. A provider ignoring cancellation still has to settle before another
explicit start; late replies cannot restore protected state. Disposers run even when listen resolves
after cancellation. `dispose` also frees Rust/Wasm allocations.

## Server presence and journal custody

Presence is per `(scope, actor_id, session_id, connection_id)`. The server owns a unique,
never-reused connection identifier; it is not a user-selected way to modify somebody else's
presence. Hosts own cross-connection aggregation, bounded registries, crash reconciliation and
expiry scheduling.

Signals are `active`, `idle`, `heartbeat`, `uncertain`, `offline`, `tick`. Authentication
establishes who made a claim and the server clock establishes when; neither proves human attention
or work.

- Active sets confirmed seen/activity timestamps; idle/uncertain confirm liveness without inventing
  activity. Heartbeat confirms liveness and derives active/idle from the last activity timestamp.
- Tick does not manufacture a ping. It transitions to uncertain/offline at the configured elapsed
  thresholds, or to idle when recent heartbeats lack activity. Explicit offline preserves the last
  confirmed seen timestamp rather than inventing a new ping.
- `idle_after_ms` and `uncertain_after_ms` are positive and each below `offline_after_ms`; the
  latter is at most one day. All are supplied by the host.
- `prepare(grant, signal, now)` produces one immutable `PreparedPresence`, without exposing the
  proposed state as committed. Its optional entry records a state transition with exact scope,
  connection, sequence, before/after state, signal and observed timestamps.
- Storage atomically stores the observation and optional journal entry, idempotently by exact
  `(scope, key, ticket)`. It must compare exact bytes on duplicate identity and recheck current
  authority/version in its own transaction. The library does not implement a distributed lock or
  database transaction for a provider.
- Commit revalidates the exact actor/session/scope, expiry and prepared permission version. Its
  validation-clock high-water mark is separate from the original observation timestamp.
- Ambiguous storage/acknowledgement failure retains exactly one pending proposal. A new signal is
  `busy`; retry rechecks current authority before giving those same bytes to storage. Retry is not a
  second transition. Authorization/expiry/identity failures revoke and erase the proposal instead.
- Revocation/disposal immediately clears local presence and pending state. It cannot undo a journal
  record already committed externally. Hosts own durable disconnect/revocation reconciliation; local
  disposal does not claim that an offline journal entry was persisted.

Native `PresenceHost<A,S>` injects `PresenceAuthority::current` and `PresenceStorage::store`. TS
`PresenceHost` injects asynchronous `PresenceProvider.current/store` and a server `now()` callback.
Both recheck authority before local commit; durable providers still own their transactional recheck.
Callbacks must never receive real credentials in a descriptor or put business data into journal
identity. Authoritative query/adaptor boundaries remain independent of presence status.

## Typed host API, errors and targets

Rust public types derive portable TypeScript declarations. The build regenerates `protocol.ts` from
those types; `--check-types` rejects drift. The package emits ESM, declarations, generated Wasm glue
and the actual `.wasm`. Its exports are `.`, `./protocol`, `./lists`, `./window`, `./wasm`. Loading the `.wasm`
is explicit: call `init_realine(bytesOrCompiledModule)` before constructing instances. `wasm_url`
resolves the adjacent artifact in Bun and a browser host. There is no JS fallback if Wasm is
missing.

`StreamCore.dispatch` and `PresenceCore.dispatch` are typed low-level entry points.
`Subscription<T>` adds injectable transport and mandatory payload decoding,
`connect/ready/pull/tick`, and explicit `disconnect/revoke/dispose`. `listen` resolves when delivery
is actually installed, before snapshot. Automatic gap/overflow recovery uses the Rust request, not a
second comparer. Failed reads or decode failures fence the handle and expose an error; recovery is
explicit. Hosts call tick and choose their own retry/backoff policy; the library starts no timer,
socket, database or background service.

Rust returns `ErrorCode`; the TS facade throws `RealineError` with that stable `code`. Codes include
invalid configuration/scope/grant/time/revision/frame, oversized payload, denied, expired, disposed,
not ready, busy, stale, exhausted identity counters and storage failure. Parser/provider internals,
stacks and payload text are not serialized into Rust errors. `Subscription.error` distinguishes a
transport failure from Rust codes. Consumer domain errors need their own explicit contract.

The declared compiler baseline is Rust 1.94/edition 2024 and the Wasm target is
`wasm32-unknown-unknown`, with wasm-bindgen-cli 0.2.105. The artifact gate exercises native Linux,
Node 24.20.0, Bun 1.4.2 and real Chromium/WebKit loading. This is not qualification of all browsers,
Windows, macOS, native mobile, native addons or an installed production application. Package
builds/tests are local; no public registry distribution, service deployment or performance speedup
is implied.

## Deliberate boundary and verification

The independent-consumer gate packs the real crate and TS/Wasm package, installs/unpacks them
outside the source workspace, checks public/negative types and executes native, Node, Bun and browser
consumers. It compares real transcripts across targets, exercises current authorization, journal
retry, causal ordering, gap/reconnect, backpressure and disposal, and reports measured
native/binding costs. No timing number is a universal Rust speedup or a business-workload benchmark.

The separate [lists/windows layer](LISTS_CONTRACT.md) reuses this core for strict query/page
identity, bounded deltas, stable slots, client input custody and equal-authority query grouping.
Chat, SharedWorker/multi-tab multiplexing, cold browser storage and graph synchronization are not
implemented. Host transport and permission integration requires its own acceptance. No descriptor, presence status or passing library
suite proves business authorization, deployment or whole-product production readiness.
