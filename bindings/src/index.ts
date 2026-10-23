import { initSync } from "../generated/wasm/realine_core.js";

export { StreamCore } from "./core.js";
export type { PresenceProvider } from "./presence.js";
export { PresenceCore, PresenceHost } from "./presence.js";
export type * from "./protocol.js";
export type { StreamListener, StreamTransport, SubscriptionOptions, TypedDelivery } from "./subscription.js";
export { Subscription } from "./subscription.js";
export { RealineError } from "./wire.js";
export const wasm_url = new URL("../generated/wasm/realine_core_bg.wasm", import.meta.url);
export const init_realine = (module: BufferSource | WebAssembly.Module): void => {
	// oxlint-disable-next-line node/no-sync -- Explicit Wasm instantiation from already-loaded bytes; no synchronous filesystem I/O.
	initSync({ module });
};
