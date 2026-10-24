# @frankfmy/realine-core

Typed ESM bindings to `realine-core` 0.1.1. The package contains the real Rust WebAssembly module,
its generated loader and declarations. There is no JavaScript replacement and no runtime npm
dependency. Version **0.1.1** is available as
[@frankfmy/realine-core on npm](https://www.npmjs.com/package/@frankfmy/realine-core).

```sh
npm install @frankfmy/realine-core@0.1.1
```

Source builds and the older, immutable **v0.1.0** GitHub archive remain alternatives.
The archive is a different version from npm 0.1.1:

```sh
gh release download v0.1.0 --repo FrankFMY/realine-core --dir realine-core-release &&
(cd realine-core-release && sha256sum --check SHA256SUMS) &&
npm install ./realine-core-release/frankfmy-realine-core-0.1.0.tgz
```

```js
import { readFile } from "node:fs/promises";
import { init_realine, wasm_url, StreamCore } from "@frankfmy/realine-core";
init_realine(await readFile(wasm_url));
const core = new StreamCore(
  { product: "catalog", tenant: "demo", resource: "items", channel: "changes" },
  { max_events: 4, max_buffer_bytes: 4096, max_payload_bytes: 1024 }
);
console.log(core.view().state); // dormant
core.dispose();
```

Node 24 and Bun 1.4.2 are the runtime baselines. In browsers, fetch `wasm_url`, check the response,
and call `init_realine(await response.arrayBuffer())` before any native-backed constructor. Byte
loading is asynchronous; initialization itself is synchronous and idempotent. A cold import is
not initialization. Preserve the adjacent `dist` / `generated/wasm` layout when serving assets.

Exports: the root has initialization, stream/subscription/presence APIs and protocol types;
`/protocol` has generated types; `/lists` has ListCore, ListPlan, ListClient, ListHub and list types;
`/window` has RevisionedWindow; `/wasm` resolves the raw Wasm asset, not a JavaScript module.

Read [API](dist/API.md), [core](dist/CORE_CONTRACT.md), [lists](dist/LISTS_CONTRACT.md),
[window](dist/WINDOW_CONTRACT.md) and [build](dist/BUILD.md) contracts. Hosts own current authority,
domain validation, clocks, total quotas, consistent provider snapshots and revocation delivery.
The loaded window retains complete host-admitted values outside the bounded native identity
projection: it has no implicit total loaded-row or value-byte cap and never silently truncates.
Dispose or stop owned handles. Cancellation cannot undo external storage or queries.

MIT OR Apache-2.0, at your option. Copyright 2026 Artem Prianishnikov (FrankFMY).
Full [MIT](dist/LICENSE-MIT), [Apache](dist/LICENSE-APACHE) and
[third-party notices](dist/THIRD-PARTY-NOTICES.md) are included, with Unicode-3.0 and ts-rs notices.

## Author and contact

Created and maintained by [Artem Prianishnikov (Артем Прянишников / FrankFMY)](https://github.com/FrankFMY).

- Email: [Pryanishnikovartem@gmail.com](mailto:Pryanishnikovartem@gmail.com)
- Telegram: [@FrankFMY](https://t.me/FrankFMY)
- Website: [frankfmy.com](https://frankfmy.com)
- Profiles: [GitHub](https://github.com/FrankFMY) · [LinkedIn](https://www.linkedin.com/in/frankfmy/) · [X](https://x.com/FrankFMY)
