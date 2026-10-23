import type { Grant, JsonValue, ListCustody, ListRow, Snapshot, StreamListener, SyncRequest } from "@frankfmy/realine-core";
import { PresenceCore, PresenceHost, RealineError, Subscription } from "@frankfmy/realine-core";
import { ListClient, ListHub } from "@frankfmy/realine-core/lists";
import { RevisionedWindow } from "@frankfmy/realine-core/window";

let assertions = 0;
function check(value: unknown, message: string): asserts value {
	assertions++;
	if (!value) throw new Error(message);
}
const canonical = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonical);
	if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
	return value;
};
const equal = (a: unknown, b: unknown, message: string): void => check(JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)), message);
const rejects = async (action: () => unknown, code: string): Promise<void> => {
	try {
		await action();
	} catch (error) {
		check(error instanceof RealineError && error.code === code, `expected ${code}, got ${String(error)}`);
		return;
	}
	throw new Error(`missing rejection: ${code}`);
};
const denied = (action: () => unknown, code: string): void => {
	try {
		action();
	} catch (error) {
		check(error instanceof RealineError && error.code === code, `expected ${code}, got ${String(error)}`);
		return;
	}
	throw new Error(`missing rejection: ${code}`);
};
const deferred = (): { promise: Promise<void>; resolve: () => void } => {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};
const scope = { product: "catalog", tenant: "sample", resource: "items", channel: "changes" };
const grant: Grant = { scope, actor_id: "reader", session_id: "session", permission_version: "1", expires_at_ms: 10000 };
const config = { max_events: 4, max_buffer_bytes: 65536, max_payload_bytes: 32768 };
const row = (id: string, revision = "1"): ListRow => ({
	id,
	revision,
	value: { name: `Current ${id} v${revision}`, absent: null, zero: 0, flag: false },
});

export const run_windows = (): object => {
	for (const count of [275, 751, 1001]) {
		const window = new RevisionedWindow(scope, "summary");
		let rows = Array.from({ length: count }, (_, i) => row(`r${i}`));
		let revision = 1;
		try {
			window.update({ epoch: "first", revision: "1" }, rows);
			equal(
				window.view().slots.map((slot) => slot.row),
				rows,
				`initial ${count}`,
			);
			const focus = "r249";
			let custody: ListCustody = { focus, selection: [focus, "r250"], dirty: [focus], anchor: { id: focus, offset_px: -17 } };
			window.interaction(custody);
			const changes = [
				(before: ListRow[]): ListRow[] => {
					const next = [...before];
					for (let edge = 250; edge < next.length; edge += 250)
						[next[edge - 1], next[edge]] = [row(next[edge]!.id, "2"), row(next[edge - 1]!.id, "2")];
					return next;
				},
				(before: ListRow[]): ListRow[] => [row("front"), ...before],
				(before: ListRow[]): ListRow[] => before.filter((r) => r.id !== "r0"),
				(before: ListRow[]): ListRow[] => [...before].reverse().map((r) => row(r.id, "3")),
				(before: ListRow[]): ListRow[] => [...before, ...Array.from({ length: 501 }, (_, i) => row(`extra${i}`))],
				(before: ListRow[]): ListRow[] => before.filter((r) => [focus, "r250", "front"].includes(r.id)),
			];
			for (const change of changes) {
				const next = change(rows),
					values = new Map(next.map((r) => [r.id, r]));
				window.update({ epoch: "first", revision: String(++revision) }, next);
				const view = window.view();
				equal(
					view.slots.map((s) => s.id),
					rows.map((r) => r.id),
					"visible order before acceptance",
				);
				for (const [index, slot] of view.slots.entries()) {
					equal(slot.row, values.get(slot.id) ?? null, "current cross-part value");
					check((slot.departure === null) === values.has(slot.id), "membership and tombstone agree");
					if (values.has(slot.id)) check(slot.moved === (next.findIndex((r) => r.id === slot.id) !== index), "global moved flag");
				}
				equal(
					view.pending_order,
					next.map((r) => r.id),
					"complete desired order",
				);
				equal(view.custody, custody, "custody before acceptance");
				if (custody.dirty.length) {
					denied(() => window.accept(), "busy");
					custody = { ...custody, dirty: [] };
					window.interaction(custody);
				}
				window.accept();
				equal(
					window.view().slots.map((s) => s.row),
					next,
					"accepted complete selection",
				);
				equal(window.view().custody, custody, "focus/anchor follow records across parts");
				check(new Set(window.view().slots.map((s) => s.id)).size === next.length, "no duplicated slots");
				rows = next;
			}
			const current = { epoch: "first", revision: String(revision) };
			const changed = structuredClone(rows);
			changed[0]!.value = { name: "changed at identical cursor" };
			denied(() => window.update(current, changed), "invalid_revision");
			const before = window.view();
			denied(() => window.update({ ...current, revision: String(revision + 1) }, [...rows, rows[0]!]), "invalid_frame");
			equal(window.view(), before, "duplicate rejection leaves state intact");
			const exposed = window.view();
			exposed.slots[0]!.row!.value = "external mutation";
			equal(window.view(), before, "returned views are detached");
			window.suspend();
			check(window.view().stream.state === "uncertain" && window.view().slots.every((s) => s.row === null), "suspend hides all values");
			window.update(current, rows);
			equal(
				window.view().slots.map((s) => s.row),
				rows,
				"same-authority recovery",
			);
			const epochRows = rows.map((r) => row(r.id));
			window.update({ epoch: "second", revision: "0" }, epochRows);
			check(window.view().stream.cursor?.epoch === "second", "epoch reset with lower revisions");
			equal(
				window.view().slots.map((s) => s.row),
				epochRows,
				"epoch values are current",
			);
			window.revoke();
			check(window.view().stream.state === "revoked", "revoked lifecycle");
			equal(window.view().slots, [], "revoked window empty");
			equal(window.view().custody, { focus: null, anchor: null, selection: [], dirty: [] }, "revoke erases custody");
			window.update({ epoch: "third", revision: "0" }, [row("new-authorized")]);
			check(window.view().stream.state === "live", "explicit new admission after revoke");
		} finally {
			window.stop();
			window.stop();
		}
		denied(() => window.update({ epoch: "fourth", revision: "0" }, []), "disposed");
		check(window.view().slots.length === 0, "terminal window empty");
	}
	const large = new RevisionedWindow(scope, "large");
	const payload = "λ".repeat(300000);
	try {
		large.update({ epoch: "large", revision: "1" }, [{ id: "large", revision: "1", value: payload }]);
		check(large.view().slots[0]?.row?.value === payload, "host-admitted 600000 UTF-8 bytes retained exactly");
		for (const offset of [-2147483648, 2147483647]) {
			large.interaction({ focus: "large", selection: [], dirty: [], anchor: { id: "large", offset_px: offset } });
			check(large.view().custody.anchor?.offset_px === offset, "complete native i32 anchor range");
		}
		large.suspend();
		check(large.view().slots[0]?.row === null, "large payload fenced");
	} finally {
		large.stop();
	}
	return { counts: [275, 751, 1001], large_value_utf8_bytes: 600000, complete: true };
};

export const run_reentry = async (): Promise<object> => {
	for (const finish of ["complete", "dispose"] as const) {
		const entered = deferred(),
			held = deferred();
		const listeners: { request: SyncRequest; listener: StreamListener; signal: AbortSignal; stops: number }[] = [];
		const snapshots: number[] = [];
		const stream = new Subscription({
			scope,
			config,
			now: () => 100,
			decode: (v) => v,
			transport: {
				authorize: () => Promise.resolve(grant),
				listen: (request, listener, signal) => {
					const installed = { request, listener, signal, stops: 0 };
					listeners.push(installed);
					if (listeners.length === 2)
						listener.event({ scope, generation: request.generation, epoch: "C", previous: "0", revision: "1", data: null });
					return Promise.resolve(() => {
						installed.stops++;
					});
				},
				snapshot: async (request): Promise<Snapshot> => {
					snapshots.push(request.generation);
					if (request.generation === 3) {
						entered.resolve();
						await held.promise;
					}
					return {
						scope,
						generation: request.generation,
						epoch: request.generation === 1 ? "A" : "C",
						revision: request.generation === 1 ? "10" : "1",
						data: { newest: request.generation },
					};
				},
			},
		});
		try {
			await stream.connect();
			stream.pull(4);
			listeners[0]!.listener.event({ scope, generation: 1, epoch: "B", previous: "0", revision: "1", data: null });
			await entered.promise;
			let ready = false;
			const waiting = stream.ready().then(() => {
				ready = true;
			});
			await Promise.resolve();
			check(!ready && stream.view().state === "syncing", "newest held result owns ready");
			await rejects(() => stream.connect(), "busy");
			equal(snapshots, [1, 2, 3], "exactly one baseline request per admitted generation");
			equal(
				listeners.map((s) => s.stops),
				[1, 1, 0],
				"old listeners disposed exactly once",
			);
			if (finish === "dispose") stream.dispose();
			held.resolve();
			await waiting;
			if (finish === "complete") {
				check(stream.view().cursor?.epoch === "C", "newest epoch wins");
				equal(
					stream.pull(4).map((d) => d.data),
					[{ newest: 3 }],
					"newest baseline delivered once",
				);
				equal(stream.pull(4), [], "no duplicate baseline");
			} else check(stream.view().state === "disposed", "late baseline cannot restore disposal");
			for (const old of listeners.slice(0, 2)) {
				old.listener.revoked();
				old.listener.disconnected();
				old.listener.event({});
			}
			check(stream.view().state === (finish === "complete" ? "live" : "disposed"), "old callbacks fenced");
		} finally {
			held.resolve();
			stream.dispose();
			await stream.ready();
		}
		equal(
			listeners.map((s) => s.stops),
			[1, 1, 1],
			"exactly once listener disposal",
		);
		check(
			listeners.every((s) => s.signal.aborted),
			"all attempts aborted",
		);
	}
	const entered = deferred(),
		gate = deferred();
	let stops = 0,
		snapshots = 0;
	const late = new Subscription({
		scope,
		config,
		now: () => 100,
		decode: (v) => v,
		transport: {
			authorize: () => Promise.resolve(grant),
			listen: async () => {
				entered.resolve();
				await gate.promise;
				return () => {
					stops++;
				};
			},
			snapshot: () => {
				snapshots++;
				return Promise.reject(new Error("must not read after cancellation"));
			},
		},
	});
	const connection = late.connect();
	await entered.promise;
	late.dispose();
	gate.resolve();
	await connection;
	await late.ready();
	check(stops === 1 && snapshots === 0 && late.view().state === "disposed", "late disposer runs without a baseline read");
	return { synchronous_epoch_reentry: true, newest_held_ready_busy: true, one_baseline_per_generation: true, late_listen_cleanup: true };
};

export const run_scheduler = async (): Promise<object> => {
	let revision = 1,
		reads = 0,
		arm = false;
	let held: ReturnType<typeof deferred> | null = null,
		entered: ReturnType<typeof deferred> | null = null;
	const intent = { scope, projection: "summary", filter: null, sort: [], limit: 3 };
	const hub = new ListHub<string>({
		now: () => 100,
		max_groups: 1,
		max_subscribers: 8,
		max_refresh_rounds: 4,
		provider: {
			authorize: () => Promise.resolve({ grant, access: "same-visible-selection" }),
			read: async () => {
				reads++;
				const at = revision;
				if (held) {
					const local = held;
					held = null;
					entered!.resolve();
					await local.promise;
				}
				if (arm) {
					arm = false;
					let hops = 6;
					const later = (): void => {
						if (--hops) queueMicrotask(later);
						else {
							revision++;
							hub.invalidate();
						}
					};
					queueMicrotask(later);
				}
				return { cursor: { epoch: "provider", revision: String(at) }, rows: [row("a", String(at))], has_more: false };
			},
		},
	});
	const clients: ListClient<JsonValue>[] = [];
	const connect = async (): Promise<ListClient<JsonValue>> => {
		const { request } = await hub.authorize("reader", intent);
		const client = new ListClient({ request, transport: hub.transport("reader", request), now: () => 100, decode: (v) => v });
		clients.push(client);
		await client.connect();
		return client;
	};
	try {
		await Promise.all([connect(), connect(), connect()]);
		check(reads === 1, "equal permitted subscribers share a read");
		revision++;
		for (let i = 0; i < 100; i++) hub.invalidate();
		await hub.flush();
		check(Number(reads) === 2, "100 invalidations coalesce");
		arm = true;
		hub.invalidate();
		await hub.flush();
		await new Promise((r) => setTimeout(r, 0));
		await hub.flush();
		check(Number(reads) === 4, "settlement invalidation runs follow-up");
		check(clients[0]!.view().slots[0]?.row?.revision === String(revision), "newest scheduler result delivered");
		const gate = deferred();
		held = gate;
		entered = deferred();
		revision++;
		hub.invalidate();
		await entered.promise;
		const draining = hub.flush();
		for (const c of clients) c.dispose();
		equal(hub.stats(), { groups: 0, subscribers: 0, reading: 1 }, "cancelled read retains quota until settlement");
		await rejects(() => connect(), "busy");
		gate.resolve();
		await draining;
		equal(hub.stats(), { groups: 0, subscribers: 0, reading: 0 }, "retired read drained");
		check(
			clients.every((c) => c.view().slots.length === 0),
			"late read cannot revive disposed clients",
		);
	} finally {
		held?.resolve();
		for (const c of clients) c.dispose();
		hub.dispose();
		await hub.flush();
	}
	return { coalesced_burst: 100, settlement_followup: true, late_read_fenced: true, reads };
};

export const run_presence_late = async (): Promise<object> => {
	const entered = deferred(),
		gate = deferred();
	let signal: AbortSignal | undefined;
	const core = new PresenceCore(
		scope,
		{ actor_id: grant.actor_id, session_id: grant.session_id, connection_id: "owned" },
		{ idle_after_ms: 100, uncertain_after_ms: 50, offline_after_ms: 200 },
	);
	const host = new PresenceHost(
		core,
		{
			current: () => Promise.resolve(grant),
			store: async (_grant, _proposal, active) => {
				signal = active;
				entered.resolve();
				await gate.promise;
			},
		},
		() => 100,
	);
	const task = host.observe("active");
	await entered.promise;
	await rejects(() => host.observe("idle"), "busy");
	host.dispose();
	check(signal?.aborted, "late storage receives abort");
	gate.resolve();
	await rejects(() => task, "denied");
	check(core.view().state === "offline" && core.view().lifecycle === "disposed", "late presence commit fenced");
	return { late_commit_fenced: true };
};
export const run_qualification = async (): Promise<object> => {
	assertions = 0;
	const windows = run_windows(),
		reentry = await run_reentry(),
		scheduler = await run_scheduler(),
		presence = await run_presence_late();
	return { windows, reentry, scheduler, presence, assertions };
};
