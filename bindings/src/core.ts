import { WasmStream } from "../generated/wasm/realine_core.js";
import type { Grant, Scope, StreamAction, StreamConfig, StreamOutput, StreamView, SyncRequest } from "./protocol.js";
import { construct, RealineError, to_json, unpack } from "./wire.js";

/** An owned Rust core driver; Subscription owns its lifetime once injected. */
export interface StreamDriver {
	dispatch(action: StreamAction, now_ms: number): StreamOutput;
	open(grant: Grant, now_ms: number): SyncRequest;
	view(): StreamView;
	dispose(): void;
}

export class StreamCore {
	private core: WasmStream | null;
	private final_view: StreamView | null = null;
	constructor(scope: Scope, config: StreamConfig) {
		this.core = construct((): WasmStream => new WasmStream(to_json(scope), to_json(config)));
	}
	dispatch(action: StreamAction, now_ms: number): StreamOutput {
		if (!this.core) throw new RealineError("disposed");
		return unpack<StreamOutput>(this.core.call(to_json({ action, now_ms })));
	}
	open(grant: Grant, now_ms: number): SyncRequest {
		const { result } = this.dispatch({ kind: "open", grant }, now_ms);
		if (result.kind !== "sync") throw new RealineError("invalid_frame");
		return result.request;
	}
	view(): StreamView {
		return this.core ? this.dispatch({ kind: "view" }, 0).view : structuredClone(this.final_view!);
	}
	dispose(): void {
		if (!this.core) return;
		this.final_view = this.dispatch({ kind: "dispose" }, 0).view;
		this.core.free();
		this.core = null;
	}
}
