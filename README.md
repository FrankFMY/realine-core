# realine-core

Scoped realtime streams, server presence, and stable list windows, with one Rust implementation
shared by native hosts and TypeScript through WebAssembly.

I want a realtime view to make its uncertainty visible: a missing event should trigger a fresh
baseline, revoked data should disappear, and a reordered list should not move an editor out from
under its user. I keep those lifecycle and ordering rules in Rust so native and browser hosts can
exercise the same protocol. Transport, authorization and storage remain explicit host interfaces.

The project includes:

- `Stream`: causal snapshot/event delivery with scope, generation, revision and byte bounds.
- `Presence` and `PresenceHost`: prepare/store/commit observations with exact lost-ack retry.
- `ListPlan` and `ListWindow`: bounded page admission, diffs, stable slots and explicit order adoption.
- TypeScript `Subscription`, `ListHub` and `ListClient`: transport orchestration, permitted-query
  sharing, invalidation coalescing, and separate unsent draft custody.
- Optional `RevisionedWindow`: combines bounded native identity projections for a complete selection
  already loaded and authorized by its host, including selections larger than 500 rows.

This is not a server, database, authorization policy, query language, UI framework, or application
controller. It creates no sockets, timers or background services. There is no JavaScript replacement
for the Rust algorithms, and no fallback when Wasm is unavailable.

## Install an artifact

The JavaScript artifact is an ESM package named `@frankfmy/realine-core`, version 0.1.0. Registry
publication is disabled. Download and verify the assets from the
[v0.1.0 release](https://github.com/FrankFMY/realine-core/releases/tag/v0.1.0) before installation:

```sh
# gh is only needed for this download; alternatively use the release page.
gh release download v0.1.0 --repo FrankFMY/realine-core --dir realine-core-release &&
(cd realine-core-release && sha256sum --check SHA256SUMS) &&
npm install ./realine-core-release/frankfmy-realine-core-0.1.0.tgz
```

These instructions do not imply that a registry package or hosted verification run exists.
For Bun, replace the final `npm install` command with `bun add` using the same local archive;
keep the download and checksum commands chained before it.
You can also build and pack the source below. The installed package needs no Rust compiler
and has no runtime npm dependencies.

For native Rust, unpack `realine-core-0.1.0.crate` (a gzip tar archive) and use a path dependency:

```toml
[dependencies]
realine-core = { path = "../realine-core-0.1.0" }
```

The crate has `publish = false`; no crates.io installation is assumed. From a source checkout,
run the minimal [native example](examples/stream.rs):

```sh
node scripts/cargo.mjs run --locked --example stream
```

It opens a synthetic scoped stream, accepts one snapshot and drains the resulting delivery.

## Node and Bun: explicit cold initialization

Use Node 24 or Bun 1.4.2 or newer. These are the tested baseline versions, not a guarantee about
every newer runtime. Save this as `example.mjs` after installing the tarball:

```js
import { readFile } from "node:fs/promises";
import { init_realine, wasm_url, StreamCore } from "@frankfmy/realine-core";

// Reading bytes is asynchronous; init_realine itself is synchronous and idempotent.
init_realine(await readFile(wasm_url));
const scope = { product: "catalog", tenant: "demo", resource: "items", channel: "changes" };
const core = new StreamCore(scope, { max_events: 4, max_buffer_bytes: 4096, max_payload_bytes: 1024 });
try {
  // Synthetic local example. A real grant must come from current server authorization.
  const sync = core.open({ scope, actor_id: "reader", session_id: "session",
    permission_version: "1", expires_at_ms: 1000 }, 100);
  core.dispatch({ kind: "snapshot", snapshot: { scope, generation: sync.generation,
    epoch: "catalog-1", revision: "0", data: { count: 0 } } }, 100);
  console.log(core.dispatch({ kind: "take", limit: 1 }, 100).result);
} finally {
  core.dispose();
}
```

Run `node example.mjs` or `bun example.mjs`. A constructor that needs Wasm reports `not_ready`
before initialization. A successful import alone does not initialize the module. Initialize before
**every application construction path**, including lists, windows and presence; one initialization
per module instance is sufficient. No constructor fetches Wasm implicitly.

## Browser

Serve the installed `dist` and `generated/wasm` directories with their relative layout intact.
This minimal development page uses an import map; a bundler may instead copy the Wasm asset and
preserve the `wasm_url` reference. Serve Wasm as `application/wasm`.

```html
<script type="importmap">
{"imports": {
  "@frankfmy/realine-core": "./node_modules/@frankfmy/realine-core/dist/index.js",
  "@frankfmy/realine-core/window": "./node_modules/@frankfmy/realine-core/dist/window.js"
}}
</script>
<script type="module">
import { init_realine, wasm_url } from "@frankfmy/realine-core";
import { RevisionedWindow } from "@frankfmy/realine-core/window";
const response = await fetch(wasm_url);
if (!response.ok) throw new Error(`Wasm fetch failed: ${response.status}`);
init_realine(await response.arrayBuffer());
const window = new RevisionedWindow(
  { product: "catalog", tenant: "demo", resource: "items", channel: "list" }, "summary"
);
window.update({ epoch: "catalog-1", revision: "1" }, [
  { id: "item-1", revision: "1", value: { name: "Example" } }
]);
console.log(window.view().slots);
window.stop();
</script>
```

The local browser gate runs actual Chromium and WebKit. Browsers require WebAssembly,
TextEncoder/TextDecoder, structuredClone, AbortController and a secure context for randomUUID.
This does not qualify every browser, operating system, bundler or deployment policy.

## Exports and contracts

| Export | Contents |
| --- | --- |
| `@frankfmy/realine-core` | `init_realine`, `wasm_url`, `RealineError`, `StreamCore`, `Subscription`, `PresenceCore`, `PresenceHost`, protocol types |
| `@frankfmy/realine-core/protocol` | Rust-generated protocol types; runtime module is empty |
| `@frankfmy/realine-core/lists` | `ListCore`, `ListPlan`, `ListClient`, `ListHub`, `default_list_config`, list types |
| `@frankfmy/realine-core/window` | `RevisionedWindow` |
| `@frankfmy/realine-core/wasm` | Raw `.wasm` asset, resolved as a URL/path; not a JavaScript module |

Read [API.md](API.md), the [core contract](CORE_CONTRACT.md), [lists contract](LISTS_CONTRACT.md),
[window contract](WINDOW_CONTRACT.md), and [build contract](BUILD.md). The installed package includes
the contracts, licenses and notices in `dist/`.

Hosts must authenticate every subscription/read, issue current grants, validate domain payloads,
keep consistent query revisions and snapshots, enforce total resource quotas, deliver revocations,
drive clocks/ticks, reconcile durable presence and dispose handles. Scope strings and locally
constructed grants are descriptors, never server permissions. Cancellation fences local delivery;
it cannot promise that an external operation rolled back.

The stream queue admits at most 1024 events and 4 MiB of payload JSON, with a 1 MiB per-payload
ceiling. A native list page admits at most 1000 rows and a 256 KiB frame. Defaults are smaller where
specified in the contracts. `RevisionedWindow` partitions identity projections into 250-row native
parts and never truncates the loaded selection. Its host owns the **total loaded rows and payload
bytes**; large values stay outside the native wire budget. It is not a way to send unlimited list
frames. No speed, security audit or production-readiness certification is claimed.

## Build and verify from a clone

Install Rust 1.94.0 with rustfmt, Clippy and the wasm32 target, Node 24, Bun 1.4.2, and the exact
wasm-bindgen CLI. The commands below run from this repository root:

```sh
git clone https://github.com/FrankFMY/realine-core.git
cd realine-core
rustup toolchain install 1.94.0 --profile minimal --component rustfmt --component clippy
rustup target add wasm32-unknown-unknown --toolchain 1.94.0
cargo +1.94.0 install wasm-bindgen-cli --version 0.2.105 --locked
bun install --frozen-lockfile
bun run test:native
bun run format:check
bun run check:native
bun run clippy
bun run build
bun run protocol:check
bun run lint
bun run check
bun run test
bun run pack
node scripts/cargo.mjs package --locked --allow-dirty
```

The toolchain file selects a local toolchain; no default/global toolchain switch is needed. The
wrapper uses one `target/` and remaps compiler paths. See [BUILD.md](BUILD.md) for packed-project
checks and the limits of reproducibility. Hosted workflows are not required for local verification.

[Artem Prianishnikov (FrankFMY)](https://github.com/FrankFMY) maintains this project.
Licensed under **MIT OR Apache-2.0**, at your option. Copyright 2026 Artem Prianishnikov (FrankFMY).
See [LICENSE-MIT](LICENSE-MIT), [LICENSE-APACHE](LICENSE-APACHE), and
[third-party notices](THIRD-PARTY-NOTICES.md), including Unicode-3.0 and ts-rs notices.
