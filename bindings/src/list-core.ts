import { WasmList, WasmListPlan } from "../generated/wasm/realine_core.js";
import type { StreamDriver } from "./core.js";
import type {
	Cursor,
	Grant,
	ListAction,
	ListConfig,
	ListCustody,
	ListDeparture,
	ListOutput,
	ListPage,
	ListPatch,
	ListPlanAction,
	ListPlanOutput,
	ListRequest,
	ListRow,
	ListView,
	StreamAction,
	StreamOutput,
	StreamView,
	SyncRequest,
} from "./protocol.js";
import { construct, RealineError, to_json, unpack } from "./wire.js";

export const default_list_config: ListConfig = Object.freeze({
	stream: Object.freeze({ max_events: 32, max_buffer_bytes: 2_097_152, max_payload_bytes: 262_144 }),
	max_rows: 200,
	max_retained_bytes: 4_194_304,
});

export class ListCore implements StreamDriver {
	private core: WasmList | null;
	private final_view: ListView | null = null;
	constructor(request: ListRequest, config: ListConfig = default_list_config) {
		this.core = construct((): WasmList => new WasmList(to_json(request), to_json(config)));
	}
	action(action: ListAction, now_ms: number): ListOutput {
		if (!this.core) throw new RealineError("disposed");
		return unpack<ListOutput>(this.core.call(to_json({ action, now_ms })));
	}
	dispatch(action: StreamAction, now_ms: number): StreamOutput {
		const output = this.action({ kind: "stream", action }, now_ms);
		return { view: output.view.stream, result: output.result };
	}
	open(grant: Grant, now_ms: number): SyncRequest {
		const { result } = this.dispatch({ kind: "open", grant }, now_ms);
		if (result.kind !== "sync") throw new RealineError("invalid_frame");
		return result.request;
	}
	custody(custody: ListCustody, now_ms: number): void {
		this.action({ kind: "custody", custody }, now_ms);
	}
	accept(now_ms: number): void {
		this.action({ kind: "accept" }, now_ms);
	}
	window(): ListView {
		return this.core ? this.action({ kind: "view" }, 0).view : structuredClone(this.final_view!);
	}
	view(): StreamView {
		return this.window().stream;
	}
	dispose(): void {
		if (!this.core) return;
		this.final_view = this.action({ kind: "stream", action: { kind: "dispose" } }, 0).view;
		this.core.free();
		this.core = null;
	}
}

export class ListPlan {
	private core: WasmListPlan | null;
	readonly key: string;
	readonly query_key: string;
	constructor(request: ListRequest, config: ListConfig = default_list_config) {
		this.core = construct((): WasmListPlan => new WasmListPlan(to_json(request), to_json(config)));
		this.key = this.core.key();
		this.query_key = this.core.query_key();
	}
	private call(action: ListPlanAction): ListPlanOutput {
		if (!this.core) throw new RealineError("disposed");
		return unpack<ListPlanOutput>(this.core.call(to_json(action)));
	}
	page(cursor: Cursor, rows: ListRow[], has_more: boolean): ListPage {
		const result = this.call({ kind: "page", cursor, rows, has_more });
		if (result.kind !== "page") throw new RealineError("invalid_frame");
		return result.page;
	}
	advance(before: Cursor, after: Cursor): import("./protocol.js").CursorAdvance {
		const result = this.call({ kind: "advance", before, after });
		if (result.kind !== "advance") throw new RealineError("invalid_frame");
		return result.advance;
	}
	diff(cursor: Cursor, before: ListPage, after: ListPage, departures: ListDeparture[] = []): ListPatch {
		const result = this.call({ kind: "diff", cursor, before, after, departures });
		if (result.kind !== "patch") throw new RealineError("invalid_frame");
		return result.patch;
	}
	dispose(): void {
		this.core?.free();
		this.core = null;
	}
}
