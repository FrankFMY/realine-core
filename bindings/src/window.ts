import type { Cursor, Grant, JsonValue, ListCustody, ListPage, ListRequest, ListRow, ListView, Scope } from "./index.js";
import { RealineError } from "./index.js";
import { ListCore, ListPlan } from "./list-core.js";

/** Current-page materialization only; SQL, permissions and domain cursors remain with the caller. */
export class RevisionedWindow {
	private readonly parts: WindowPart[];
	private readonly scope: Scope;
	private readonly projection: string;
	private readonly filter: JsonValue;
	private previous: Cursor | null = null;
	private count = 0;
	private selection_order: string[] = [];
	private dirty_order: string[] = [];
	// One current authorized payload projection across all bounded native parts.
	// Part boundaries are transport limits, never record or custody boundaries.
	private values = new Map<string, ListRow>();
	private metadata = new Map<string, { revision: string; conflict: boolean }>();
	constructor(scope: Scope, projection: string, filter: JsonValue = null) {
		this.scope = { ...scope };
		this.projection = projection;
		this.filter = structuredClone(filter);
		this.parts = [new WindowPart(this.scope, `${projection}:0`, this.filter)];
	}
	update(cursor: Cursor, rows: ListRow[]): void {
		const previous = this.view();
		if (previous.stream.state === "disposed") throw new RealineError("disposed");
		if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new RealineError("invalid_frame");
		if (this.previous) this.parts[0]!.advance(this.previous, cursor);
		if (
			previous.stream.state === "live" &&
			this.previous?.epoch === cursor.epoch &&
			this.previous.revision === cursor.revision &&
			JSON.stringify([...this.values.values()]) !== JSON.stringify(rows)
		)
			throw new RealineError("invalid_revision");
		const values = new Map(rows.map((row) => [row.id, structuredClone(row)]));
		if (this.previous?.epoch === cursor.epoch) {
			const observed = new Map(previous.slots.map((slot) => [slot.id, slot.observed_revision]));
			for (const row of values.values()) {
				const known = this.values.get(row.id);
				const revision = known?.revision ?? observed.get(row.id);
				if (revision !== undefined) {
					try {
						this.parts[0]!.advance({ epoch: cursor.epoch, revision }, { epoch: cursor.epoch, revision: row.revision });
					} catch {
						throw new RealineError("invalid_revision");
					}
					if (known && revision === row.revision && JSON.stringify(known.value) !== JSON.stringify(row.value))
						throw new RealineError("invalid_revision");
				}
			}
		}
		const dirty = new Set(previous.custody.dirty);
		const needed = Math.max(1, Math.ceil(rows.length / 250));
		const original_parts = this.parts.length;
		const prepared: (() => void)[] = [];
		try {
			for (let index = 0; index < Math.max(needed, this.parts.length); index++) {
				if (!this.parts[index]) {
					const part = new WindowPart(this.scope, `${this.projection}:${index}`, this.filter);
					this.parts.push(part);
					if (this.previous) part.prepare(this.previous, [])();
				}
				prepared.push(this.parts[index]!.prepare(cursor, rows.slice(index * 250, (index + 1) * 250)));
			}
		} catch (error) {
			for (const part of this.parts.splice(original_parts)) part.stop();
			throw error;
		}
		try {
			for (const commit of prepared) commit();
		} catch (error) {
			// A terminal native failure must never expose a partly committed projection.
			this.suspend();
			throw error;
		}
		this.previous = { ...cursor };
		this.count = rows.length;
		this.metadata = new Map(
			previous.slots.map((slot) => {
				const current = values.get(slot.id);
				return [
					slot.id,
					{
						revision: current?.revision ?? slot.observed_revision,
						conflict: slot.conflict || (dirty.has(slot.id) && (!current || current.revision !== slot.observed_revision)),
					},
				];
			}),
		);
		this.values = values;
	}
	accept(): void {
		if (this.parts.some((part) => part.view().custody.dirty.length > 0)) throw new RealineError("busy");
		const custody = this.view().custody;
		for (const part of this.parts) part.accept();
		this.metadata.clear();
		for (const part of this.parts.splice(Math.max(1, Math.ceil(this.count / 250)))) part.stop();
		const known = new Set(this.view().slots.map((slot) => slot.id));
		this.interaction({
			focus: custody.focus && known.has(custody.focus) ? custody.focus : null,
			anchor: custody.anchor && known.has(custody.anchor.id) ? custody.anchor : null,
			selection: custody.selection.filter((id) => known.has(id)),
			dirty: [],
		});
	}
	interaction(custody: ListCustody): void {
		const view = this.view();
		if (view.stream.state === "disposed") throw new RealineError("disposed");
		const known = new Set(view.slots.map((slot) => slot.id));
		if (
			[custody.selection, custody.dirty].some((ids) => new Set(ids).size !== ids.length || ids.some((id) => !known.has(id))) ||
			(custody.focus !== null && !known.has(custody.focus)) ||
			(custody.anchor !== null &&
				(!known.has(custody.anchor.id) ||
					!Number.isFinite(custody.anchor.offset_px) ||
					(Math.round(custody.anchor.offset_px) < -2147483648 || Math.round(custody.anchor.offset_px) > 2147483647)))
		)
			throw new RealineError("invalid_frame");
		for (const part of this.parts) {
			const ids = new Set(part.view().slots.map((slot) => slot.id));
			part.interaction({
				focus: custody.focus && ids.has(custody.focus) ? custody.focus : null,
				selection: custody.selection.filter((id) => ids.has(id)),
				dirty: custody.dirty.filter((id) => ids.has(id)),
				anchor:
					custody.anchor && ids.has(custody.anchor.id) ? { id: custody.anchor.id, offset_px: Math.round(custody.anchor.offset_px) } : null,
			});
		}
		this.selection_order = [...custody.selection];
		this.dirty_order = [...custody.dirty];
		for (const [id, metadata] of this.metadata) if (!custody.dirty.includes(id)) metadata.conflict = false;
	}
	view(): ListView {
		const views = this.parts.map((part) => part.view());
		const first = views[0]!;
		const stream = views.find((view) => view.stream.state !== "live")?.stream ?? first.stream;
		const slots = views.flatMap((view) => view.slots);
		const positions = new Map([...this.values.keys()].map((id, index) => [id, index]));
		for (const [index, slot] of slots.entries()) {
			const row = stream.state === "live" ? this.values.get(slot.id) : undefined;
			slot.row = row ? structuredClone(row) : null;
			if (row) {
				slot.departure = null;
				slot.moved = positions.get(slot.id) !== index;
			}
			const metadata = this.metadata.get(slot.id);
			if (metadata) {
				slot.observed_revision = metadata.revision;
				slot.conflict = metadata.conflict;
			}
		}
		const pending = views.some((view) => view.pending);
		return {
			...first,
			stream,
			slots,
			pending,
			pending_order: pending ? [...this.values.keys()] : [],
			custody: {
				focus: views.find((view) => view.custody.focus)?.custody.focus ?? null,
				anchor: views.find((view) => view.custody.anchor)?.custody.anchor ?? null,
				selection: this.selection_order.filter((id) => views.some((view) => view.custody.selection.includes(id))),
				dirty: this.dirty_order.filter((id) => views.some((view) => view.custody.dirty.includes(id))),
			},
		};
	}
	suspend(): void {
		for (const part of this.parts) part.suspend();
		this.values.clear();
	}
	revoke(): void {
		for (const part of this.parts) part.revoke();
		this.previous = null;
		this.count = 0;
		this.values.clear();
		this.metadata.clear();
		this.selection_order = [];
		this.dirty_order = [];
	}
	stop(): void {
		for (const part of this.parts) part.stop();
		this.previous = null;
		this.selection_order = [];
		this.dirty_order = [];
		this.values.clear();
		this.metadata.clear();
	}
}

/** One bounded native projection, never a second TypeScript ordering engine. */
class WindowPart {
	private readonly core: ListCore;
	private readonly plan: ListPlan;
	private readonly grant: Grant;
	private previous: { cursor: Cursor; page: ListPage } | null = null;
	private readonly scope: Scope;
	constructor(scope: Scope, projection: string, filter: JsonValue = null) {
		this.scope = { ...scope };
		const request: ListRequest = { query: { scope, projection, access: "mounted-reader", filter, sort: [], limit: 1000 }, after: null };
		const config = {
			stream: { max_events: 32, max_buffer_bytes: 2097152, max_payload_bytes: 262144 },
			max_rows: 1000,
			max_retained_bytes: 4194304,
		};
		this.core = new ListCore(request, config);
		this.plan = new ListPlan(request, config);
		// This local handle never grants server access. Every snapshot comes from an
		// authorized domain read; teardown/revocation destroys this exact mounted owner.
		this.grant = {
			scope: this.scope,
			actor_id: "mounted-reader",
			session_id: crypto.randomUUID(),
			permission_version: projection,
			expires_at_ms: Number.MAX_SAFE_INTEGER,
		};
	}
	advance(before: Cursor, after: Cursor): void {
		this.plan.advance(before, after);
	}
	prepare(cursor: Cursor, rows: ListRow[]): () => void {
		const page = this.plan.page(
			cursor,
			rows.map(({ id, revision }) => ({ id, revision, value: null })),
			false,
		);
		const state = this.core.view();
		if (state.state === "disposed") throw new RealineError("disposed");
		const baseline = state.state !== "live" || !this.previous;
		const advance = this.previous ? this.plan.advance(this.previous.cursor, cursor) : null;
		if (!baseline && advance === "same") {
			if (JSON.stringify(this.previous!.page) !== JSON.stringify(page)) throw new RealineError("invalid_revision");
			return (): void => {};
		}
		// Validate every native delta before the owner mutates any partition.
		const patch = !baseline && advance !== "epoch" ? this.plan.diff(cursor, this.previous!.page, page) : null;
		return (): void => {
			if (baseline || advance === "epoch") {
				if (!baseline) this.core.dispatch({ kind: "disconnect" }, 0);
				const sync = this.core.open(this.grant, 0);
				const snapshot = { scope: this.scope, generation: sync.generation, ...cursor, data: page as unknown as JsonValue };
				let { result } = this.core.dispatch({ kind: "snapshot", snapshot }, 0);
				if (result.kind === "receive" && result.received.kind === "resync") {
					// The native stream owns the epoch floor and issues the replacement generation.
					snapshot.generation = result.received.request.generation;
					result = this.core.dispatch({ kind: "snapshot", snapshot }, 0).result;
				}
				if (result.kind !== "receive" || result.received.kind !== "accepted") throw new RealineError("not_ready");
			} else {
				this.core.dispatch(
					{
						kind: "event",
						event: {
							scope: this.scope,
							generation: state.generation,
							epoch: cursor.epoch,
							previous: this.previous!.cursor.revision,
							revision: cursor.revision,
							data: patch as unknown as JsonValue,
						},
					},
					0,
				);
			}
			this.previous = { cursor: { ...cursor }, page };
		};
	}
	accept(): void {
		this.core.accept(0);
	}
	interaction(custody: ListCustody): void {
		this.core.custody(custody, 0);
	}
	view(): ListView {
		return this.core.window();
	}
	suspend(): void {
		this.core.dispatch({ kind: "disconnect" }, 0);
	}
	revoke(): void {
		if (this.core.view().state !== "disposed") this.core.dispatch({ kind: "revoke" }, 0);
		this.previous = null;
	}
	stop(): void {
		this.core.dispose();
		this.plan.dispose();
		this.previous = null;
	}
}
