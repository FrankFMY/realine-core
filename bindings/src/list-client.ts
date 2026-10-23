import { default_list_config, ListCore } from "./list-core.js";
import type { JsonValue, ListConfig, ListCustody, ListRequest, ListRow, ListSlot, ListView } from "./protocol.js";
import type { StreamTransport } from "./subscription.js";
import { Subscription } from "./subscription.js";
import { RealineError, to_json } from "./wire.js";

export type TypedListRow<T> = Omit<ListRow, "value"> & { value: T };
export type ClientListView<T, D> = Omit<ListView, "slots"> & {
	slots: (Omit<ListSlot, "row"> & { row: TypedListRow<T> | null; draft: { value: D } | null })[];
};
export interface ListClientOptions<T> {
	request: ListRequest;
	config?: ListConfig;
	transport: StreamTransport;
	now(): number;
	decode(value: JsonValue): T;
	max_draft_bytes?: number;
	changed?(): void;
}
export class ListClient<T, D extends JsonValue = JsonValue> {
	private readonly core: ListCore;
	private readonly connection: Subscription<never>;
	private readonly options: ListClientOptions<T>;
	private readonly drafts = new Map<string, { text: string; bytes: number }>();
	private readonly max_draft_bytes: number;
	constructor(options: ListClientOptions<T>) {
		this.options = options;
		const config = options.config ?? default_list_config;
		this.max_draft_bytes = options.max_draft_bytes ?? 262144;
		if (!Number.isInteger(this.max_draft_bytes) || this.max_draft_bytes < 1 || this.max_draft_bytes > 1048576)
			throw new RealineError("invalid_config");
		this.core = new ListCore(options.request, config);
		this.connection = new Subscription({
			core: this.core,
			scope: options.request.query.scope,
			config: config.stream,
			transport: options.transport,
			now: options.now,
			decode: (): never => {
				throw new Error("Materialized by Rust");
			},
			changed: (): void => {
				this.synchronize();
				options.changed?.();
			},
		});
	}
	connect(): Promise<void> {
		return this.connection.connect();
	}
	ready(): Promise<void> {
		return this.connection.ready();
	}
	private synchronize(): ListView {
		const view = this.core.window();
		const retained = new Set(view.custody.dirty);
		for (const id of this.drafts.keys()) if (!retained.has(id)) this.drafts.delete(id);
		return view;
	}
	view(): ClientListView<T, D> {
		const view = this.synchronize();
		return {
			...view,
			slots: view.slots.map((slot) => {
				const draft = this.drafts.get(slot.id);
				return {
					id: slot.id,
					observed_revision: slot.observed_revision,
					departure: slot.departure,
					moved: slot.moved,
					conflict: slot.conflict,
					row: slot.row ? { id: slot.row.id, revision: slot.row.revision, value: this.options.decode(slot.row.value) } : null,
					draft: draft ? { value: JSON.parse(draft.text) as D } : null,
				};
			}),
		};
	}
	edit(id: string, draft: D): void {
		const view = this.synchronize();
		if (view.stream.state !== "live" || !view.slots.some((slot) => slot.id === id && (slot.row !== null || this.drafts.has(id))))
			throw new RealineError("not_ready");
		const text = to_json(draft);
		const bytes = new TextEncoder().encode(text).length;
		const retained = [...this.drafts.values()].reduce((n, value) => n + value.bytes, 0) - (this.drafts.get(id)?.bytes ?? 0);
		if (retained + bytes > this.max_draft_bytes) throw new RealineError("payload_too_large");
		this.guard_local((): void => this.core.custody({ ...view.custody, dirty: [...new Set([...view.custody.dirty, id])] }, this.options.now()));
		this.drafts.set(id, { text, bytes });
		this.options.changed?.();
	}
	clear_draft(id: string): void {
		const view = this.synchronize();
		this.guard_local((): void =>
			this.core.custody({ ...view.custody, dirty: view.custody.dirty.filter((dirty) => dirty !== id) }, this.options.now()),
		);
		this.drafts.delete(id);
		this.options.changed?.();
	}
	interaction(custody: Omit<ListCustody, "dirty">): void {
		this.guard_local((): void => this.core.custody({ ...custody, dirty: this.core.window().custody.dirty }, this.options.now()));
		this.options.changed?.();
	}
	accept(): void {
		this.guard_local((): void => this.core.accept(this.options.now()));
		this.options.changed?.();
	}
	private guard_local(action: () => void): void {
		try {
			action();
		} catch (error) {
			// A rejected local edit may have observed expiry inside Rust. Fence I/O and notify the
			// owning view before rethrowing, rather than leaving a previously published view visible.
			if (this.core.view().state === "revoked") this.connection.revoke();
			throw error;
		}
	}
	disconnect(): void {
		this.connection.disconnect();
	}
	revoke(): void {
		this.connection.revoke();
	}
	tick(): void {
		this.connection.tick();
	}
	dispose(): void {
		this.connection.dispose();
		this.drafts.clear();
	}
	get error(): Subscription<never>["error"] {
		return this.connection.error;
	}
}
