# Realine lists and windows

Maintainer/developer contract for native `realine-core` and `@frankfmy/realine-core/lists`. Rust owns
query/page identity, admission, cursor progression, delta construction and stable window state.
TypeScript owns asynchronous authorization, provider/transport lifetime, query grouping and local
JSON input buffers. The library has no business tables, user schema, SQL compiler, UI framework or
ambient login.

## Start with the ordinary API

Initialize the Wasm module as described in the binding package README. A server host constructs
`ListHub<Context>` with a provider, its clock and explicit group/subscriber/refresh quotas.

1. `hub.authorize(context, intent, after, signal)` returns an authorized `request` and non-secret
   `grant`. `intent` contains scope, projection, JSON filter parameters, ordered sort descriptors
   and page limit. Only the provider supplies the access-equivalence fingerprint.
2. Construct `ListClient<Row, Draft>` with that request, a domain `decode`, a clock and a transport.
   `hub.transport(context, request)` is an in-process transport implementing the same injectable
   interface used by a remote host. It is not an HTTP/WebSocket endpoint or a bearer credential.
3. Call `connect()`, inspect `view().stream.state` and `error`, and await `ready()` for recovery
   already in progress. A settled connection attempt is not proof that a revoked/disconnected
   attempt became live. `changed()` signals a new immutable view; it performs no UI or business
   command.
4. Use `interaction({focus, selection, anchor})`, `edit(id, JSONBuffer)`, `clear_draft(id)` and
   `accept()` for local work. These are read-view operations, not record mutations.
5. Feed committed change hints into `hub.invalidate(matches)`. `await hub.flush()` drains scheduled
   read work and exposes its typed failure. Drive `tick()` and explicit permission/connection
   changes from the host lifecycle. Dispose client and hub handles when their owning context ends.

The source `consumers/sql-lists.ts` is a complete executable Bun/SQLite provider and
multi-subscriber consumer using only the public package. The independent artifact gate installs the
real tarball in an outside project and runs this example. `consumers/lists.ts` exercises the same
public client in Bun and Chromium/WebKit; the native crate runs the shared list script too.

Native hosts use `ListPlan::new`, `page`, `advance`, `diff` and `ListWindow` directly. `JsonList`
and `JsonListPlan` expose the same bounded typed protocol used by Wasm. No generated UUID/AST
assembly is needed: a row is its stable domain ID, decimal revision and JSON value.

## Query, page and cursor identity

`ListQuery` binds the complete `Scope`, `projection`, provider-certified `access`, JSON `filter`,
ordered `sort` descriptors and `limit`. Identifiers retain the core's exact 128-byte rules. Filters
are consumer-defined bounded JSON, not a library predicate language. Object property order is
canonicalized by Rust; absence, null, false, zero and empty strings remain distinct. Array/sort
order is significant. This is exact admitted JSON identity, not logical predicate equivalence or
algebraic normalization of numeric representations.

A query key is the bounded canonical identity itself, not a credential or an unverified caller hash.
A request key additionally binds the complete `after` cursor. Thus equal SQL text is insufficient
for sharing. Different tenants, resources, channels, projections, access fingerprints, filters,
sorts, limits or page positions have different groups. Do not log keys containing sensitive filter
values.

`PageCursor` contains query identity, source epoch/revision and a stable anchor ID/record revision.
It deliberately contains no arbitrary-length stored sort value. `ListPlan.page` constructs `next`
from the last returned row when `has_more` is true; empty pages cannot claim a next anchor. The
client checks exact request identity, unique row IDs, decimal revisions, bounds and the outgoing
anchor. An incoming cursor cannot cross epochs or move below its witnessed revision.

The provider must resolve the anchor under current access and reject a changed/missing/ineligible
anchor as `stale`. It must apply authorization and filters before the page limit and implement the
advertised typed sort/missing policy with a unique stable-ID tie-break. The library does not inspect
SQL or compare domain values. These are live keyset pages, not a promise of one immutable database
snapshot across separate page reads. A stale cursor requires a first-page request under fresh
admission, with explicit custody of any existing local edits.

## Provider and grouped delivery

`ListProvider.authorize(context, intent, signal)` independently verifies the current actor/session,
scope, projection and query policy. It returns a core `Grant` plus an access fingerprint certifying
identical visible rows and projection for every member sharing that fingerprint. Include actor,
policy version, publication/source version or other predicate dependencies when they matter. A
well-shaped fingerprint does not grant access; incorrectly certifying unequal visibility is a
provider defect which a generic library cannot discover.

`read(context, {grant, request, previous}, signal)` returns one consistent
`{cursor, rows, has_more}` and optional exact departure reasons for the previous page. The optional
previous observation contains its cursor and only record IDs/revisions, not old values; it lets a
provider classify departures without maintaining a duplicate baseline cache. The provider owns
domain SQL, transactional authority, record revisions, notification/outbox consistency and anchor
resolution. It must not silently shorten an oversized result to fit. Revisions belong to an ordered
query history, not wall-clock estimates; every result-affecting joined-table change must update the
observation/record revision as appropriate. The host may use narrower invalidation predicates, but
must not omit affected active groups. A missed notification cannot be detected from a
still-well-shaped cached baseline alone.

The hub retains one admitted baseline per equal-authority page group and reuses it for current,
reauthorized subscribers. It takes detached JSON-wire copies of the provider cursor, rows and
optional departures immediately after an active read settles, before further authorization
callbacks. Reusing or changing the provider's returned objects cannot relabel an admitted baseline.
A synchronous invalidation burst sets one dirty bit. One read runs per
group, with a coalesced follow-up when another change arrives during that read. Settlement races
cannot strand that bit. Distinct queries can legitimately require distinct recalculations.

Each member is independently checked before querying, after reading and immediately before event or
cached snapshot delivery. Permission/session/access changes remove that member and revoke its client
view; other still-authorized members can continue. SQL results or tombstone values are never
broadcast across group identity. A source epoch reset closes the old group for explicit reconnect
and fresh authorized admission. Same-epoch regression fails as `stale`; changed bytes at an
unchanged source/record revision fail rather than pretending to be a new observation.

A provider failure is sanitized to a stable code. `StreamListener.failed(code)` lets remote
transports carry that code without server internals; ordinary disconnect/revoke callbacks remain
supported. The hub uses it for stale/oversized/overloaded reads. A client exposes unresolved state
and `error` (for example `stale` or `busy`), never a successful empty page. The host chooses retry,
backoff and first-page recovery. Current provider authorization remains required even for cached
snapshots and no-change refreshes.

## Stable view and input custody

`ListView` separates the latest server page from stable visible `slots`:

- Unmoved rows update in place by ID and revision. The row holds the latest server value; a local
  draft is a separate buffer, not an optimistic server result.
- Insertions and reordering update `pending_order` and `pending`, without replacing visible slot
  identities. `pending` distinguishes a pending empty page from no structural change.
- Departed rows become data-free tombstones with `deleted`, `filter_exit`, `moved_out` or the honest
  generic `window_exit`. The hub's diff defaults to `window_exit` when a provider cannot assert a
  more specific reason. Later unrelated patches preserve the original reason.
- `accept()` deliberately adopts the latest order, retaining focus, selection and scroll-anchor ID
  plus pixel offset when those records remain. It refuses to discard a departed dirty record:
  `clear_draft(id)` or another explicit local release must precede compaction. Missing
  focus/selection and anchors are cleared only by that explicit adoption, not by arbitrary index
  substitution.
- Remote revision changes mark a dirty slot conflicted, including across resync/reconnect. The
  non-payload observed revision survives while the old row value is hidden. Conflict remains until
  the corresponding draft is explicitly released.

`ListClient` stores detached JSON-compatible draft buffers with a total UTF-8 byte budget. Invalid
numeric/text input can be represented as strings. Returned views and caller mutations cannot alter
retained buffers. New editing requires a live admitted slot; uncertain reconnect retains existing
buffers without claiming they are server state. There is no durable browser cache, automatic save,
record command, undo history or DOM focus/scroll implementation. A UI keys controls by record ID,
keeps its editor mounted, applies the returned anchor, and fences navigation/teardown while work is
unsent. Passing the client contract is not application-level visual/interaction acceptance.

Gap/epoch recovery uses the existing Rust stream. While resyncing or disconnected, old business row
values are hidden; same-authority slot identities, observed revisions and local custody survive. A
same-authority reconnect accepts a fresh consistent baseline above its known source floor; within
the same epoch it also rejects regression of a still-observed record revision. Changed
actor/session/permission, revocation, expiry or disposal erases rows, tombstones and local drafts.
Disposal is terminal; late callback generations cannot restore a view. `view()` is pure: the host
must call `tick()` with its monotonic clock to observe expiry without incoming traffic.

## Explicit resource bounds

All byte bounds are UTF-8 serialized JSON, not a claim about total allocator overhead.

| Resource                         | Limit                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| Rows in a page / visible slots   | Configured `max_rows` 1..1000; default 200; query limit 1..`max_rows`                          |
| Retained row values              | Latest page plus at most one bounded visible slot set; no event/version history                |
| Retained row-byte budget         | Configured 1..4194304; admission conservatively charges twice the serialized row vector        |
| List snapshot / delta            | Configured core payload bound, at most 262144; default 262144; no greater than core buffer     |
| Payload structure                | Complete page/delta at most 32 nested levels; existing bounded node traversal                  |
| Filter parameters                | At most 4096 JSON bytes and existing depth/node bounds                                         |
| Sort descriptors                 | 0..8, unique exact field identities; provider always owns stable tie ordering                  |
| Query / request identity         | At most 8192 / 32768 bytes, including cursor identity respectively                             |
| Draft buffers                    | Total configured 1..1048576 bytes; default 262144; IDs bounded by retained slots               |
| Group quota                      | Explicit `max_groups` 1..1024, including retired reads still awaiting settlement               |
| Subscriber / authorization quota | Explicit `max_subscribers` 1..10000 each; aborted authorization retains its slot until settled |
| Refresh work                     | One in-flight read and one dirty bit per group; explicit `max_refresh_rounds` 1..64 per drive  |

The list payload cap deliberately leaves room for composite `diff` input containing two admitted
pages and bounded departures inside the existing portable request cap. Core stream/presence payload
limits are unchanged. Invalid native deep values are adopted and destroyed iteratively before
rejection, including denied/expired calls. Hosts must still bound input before allocating arbitrary
native Values.

At quota admission, new work fails `busy`; existing admitted groups are not evicted silently. A
continuous refresh drive exceeding its limit closes the group with explicit `busy` recovery. Last
member removal deletes its baseline and cancels I/O. An ignoring-cancellation provider still
occupies a retiring slot, preventing unbounded replacement reads. `stats()` exposes
group/subscriber/read counts; `authorizing` includes unsettled authorization calls. `dispose()`
signals cancellation and fences delivery; it is not proof that an external query rolled back or
stopped. `flush()` drains scheduled reads, not unrelated callers' authorization promises. Await
those owned attempts before closing an injected provider.

A transport sink must synchronously accept a frame into its own bounded channel or throw/report
failure. The library does not create an unbounded socket-send queue, timer, global cache or service.
No replay log is retained: revision gaps recover by authorized resync rather than silent truncation.

## Verified boundary

Run `node scripts/cargo.mjs test --locked --all-targets`, the binding package's build/check/test
scripts and `the separate-project consumer gate`. These exercise native and actual Wasm list mechanics, SQL joins
and filter-before-page examples, scoped grouping, races, revocation, stale anchors, draft custody,
backpressure and disposal. The artifact gate compares shared native/Node/Bun/Chromium/WebKit traces and
runs a separately installed SQL consumer. Synthetic query counts are measurements of those examples,
not a zero-SQL-per-mutation, production throughput, PostgreSQL-provider or Rust speedup guarantee.

Application migration, UI acceptance, multi-process query caches, chat, SharedWorker, cold storage
and graph synchronization are outside this library. Hosts retain their own session and command
controllers. See WINDOW_CONTRACT.md for the separate loaded-selection adapter.
