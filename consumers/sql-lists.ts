/* oxlint-disable eslint/no-await-in-loop -- Runnable owned SQL example serializes dependent admission/read/cleanup operations. */

import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import type { JsonValue } from "@frankfmy/realine-core";
import { init_realine, RealineError, wasm_url } from "@frankfmy/realine-core";
import type { ListAuthorization, ListIntent, ListProvider, ListRead } from "@frankfmy/realine-core/lists";
import { ListClient, ListHub } from "@frankfmy/realine-core/lists";

interface Summary {
	reference: string;
	total: string;
}
const decode = (value: JsonValue): Summary => {
	if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.reference !== "string" || typeof value.total !== "string")
		throw new TypeError("summary required");
	return { reference: value.reference, total: value.total };
};
const order_intent = (tenant: string): ListIntent => ({
	scope: { product: "orders-example", tenant, resource: "orders", channel: "register" },
	projection: "summary",
	filter: { state: "open" },
	sort: [{ field: "reference", direction: "asc", missing: "last" }],
	limit: 5,
});
export const run_sql_lists = async (): Promise<unknown> => {
	init_realine(await Bun.file(wasm_url).arrayBuffer());
	const db = new Database(":memory:");
	const clients: ListClient<Summary, { total: string }>[] = [];
	let revision = 10;
	let sql_reads = 0;
	let authorization_reads = 0;
	let anchor_reads = 0;
	db.exec(
		"CREATE TABLE memberships(actor TEXT PRIMARY KEY,tenant TEXT,allowed INTEGER);CREATE TABLE orders(tenant TEXT,id TEXT,revision INTEGER,reference TEXT,total TEXT,state TEXT,PRIMARY KEY(tenant,id));",
	);
	for (const tenant of ["a", "b"]) {
		for (let i = 0; i < 8; i++) db.prepare("INSERT INTO memberships VALUES (?,?,1)").run(`${tenant}-${i}`, tenant);
		for (let i = 0; i < 40; i++)
			db.prepare("INSERT INTO orders VALUES (?,?,1,?,'0.00','open')").run(tenant, `${tenant}-${i}`, `ORD-${String(i).padStart(3, "0")}`);
	}
	const facts = (actor: string, intent: ListIntent): ListAuthorization => {
		authorization_reads++;
		const member = db.prepare<{ tenant: string; allowed: number }, [string]>("SELECT tenant,allowed FROM memberships WHERE actor=?").get(actor);
		if (!member?.allowed || member.tenant !== intent.scope.tenant || intent.scope.resource !== "orders" || intent.projection !== "summary")
			throw new RealineError("denied");
		if (intent.filter === null || typeof intent.filter !== "object" || Array.isArray(intent.filter) || intent.filter.state !== "open")
			throw new RealineError("invalid_frame");
		return {
			grant: { scope: intent.scope, actor_id: actor, session_id: `session-${actor}`, permission_version: "member-v1", expires_at_ms: 10000 },
			access: "open-order-summaries-v1",
		};
	};
	const provider: ListProvider<string> = {
		authorize: (actor, intent, signal): Promise<ListAuthorization> =>
			signal.aborted ? Promise.reject(new RealineError("not_ready")) : Promise.resolve(facts(actor, intent)),
		read: (actor, { grant, request }, signal): Promise<ListRead> => {
			const read = db.transaction((): ListRead => {
				const current = facts(actor, request.query);
				if (
					signal.aborted ||
					grant.session_id !== current.grant.session_id ||
					grant.permission_version !== current.grant.permission_version ||
					current.access !== request.query.access
				)
					throw new RealineError("denied");
				const order = request.query.sort;
				if (order.length !== 1 || order[0]?.field !== "reference" || order[0].direction !== "asc") throw new RealineError("invalid_frame");
				let reference = "";
				let anchor_id = "";
				if (request.after) {
					anchor_reads++;
					const anchor = db
						.prepare<{ revision: number; reference: string }, [string, string]>("SELECT revision,reference FROM orders WHERE tenant=? AND id=?")
						.get(request.query.scope.tenant, request.after.anchor_id);
					if (!anchor || String(anchor.revision) !== request.after.anchor_revision) throw new RealineError("stale");
					reference = anchor.reference;
					anchor_id = request.after.anchor_id;
				}
				const rows = db
					.prepare<{ id: string; revision: number; reference: string; total: string }, [string, string, string, string, number]>(
						"SELECT id,revision,reference,total FROM orders WHERE tenant=? AND state='open' AND (reference>? OR (reference=? AND id>?)) ORDER BY reference,id LIMIT ?",
					)
					.all(request.query.scope.tenant, reference, reference, anchor_id, request.query.limit + 1);
				sql_reads++;
				return {
					cursor: { epoch: "owned-sql-example", revision: String(revision) },
					rows: rows
						.slice(0, request.query.limit)
						.map((row) => ({ id: row.id, revision: String(row.revision), value: { reference: row.reference, total: row.total } })),
					has_more: rows.length > request.query.limit,
				};
			});
			return Promise.resolve(read());
		},
	};
	const hub = new ListHub({ provider, now: (): number => 100, max_groups: 8, max_subscribers: 32, max_refresh_rounds: 4 });

	const connect = async (actor: string, tenant: string): Promise<ListClient<Summary, { total: string }>> => {
		const { request } = await hub.authorize(actor, order_intent(tenant));
		const client = new ListClient<Summary, { total: string }>({ request, transport: hub.transport(actor, request), decode, now: (): number => 100 });
		clients.push(client);
		await client.connect();
		return client;
	};
	try {
		await Promise.all(Array.from({ length: 8 }, (_value, index) => connect(`a-${index}`, "a")));
		const equal_initial_reads = sql_reads;
		assert.equal(equal_initial_reads, 1);
		const other = await connect("b-0", "b");
		assert.equal(sql_reads, 2);
		assert.ok(other.view().slots.every((slot) => slot.id.startsWith("b-")));
		const first = clients[0]!;
		first.interaction({ focus: "a-1", selection: ["a-1"], anchor: { id: "a-1", offset_px: -17 } });
		first.edit("a-1", { total: "invalid unsent amount" });
		db.prepare("INSERT INTO orders VALUES ('a','new',1,'ORD--new','1.00','open')").run();
		revision++;
		for (let i = 0; i < 50; i++) hub.invalidate((request): boolean => request.query.scope.tenant === "a");
		await hub.flush();
		const refresh_reads = sql_reads - 2;
		assert.equal(refresh_reads, 1);
		assert.equal(first.view().slots[0]?.id, "a-0");
		assert.ok(first.view().pending);
		first.accept();
		assert.equal(first.view().slots[0]?.id, "new");
		assert.equal(first.view().custody.focus, "a-1");
		assert.equal(first.view().slots.find((slot) => slot.id === "a-1")?.draft?.value.total, "invalid unsent amount");
		db.prepare("UPDATE memberships SET allowed=0 WHERE actor='a-0'").run();
		hub.invalidate((request): boolean => request.query.scope.tenant === "a");
		await hub.flush();
		assert.equal(first.view().stream.state, "revoked");
		assert.deepEqual(first.view().slots, []);
		assert.equal(clients[1]!.view().stream.state, "live");
		for (const client of clients) client.dispose();
		hub.dispose();
		await hub.flush();
		assert.deepEqual(hub.stats(), { groups: 0, subscribers: 0, reading: 0 });
		assert.equal(hub.authorizing, 0);
		return {
			equal_subscribers: 8,
			equal_initial_reads,
			distinct_tenant_initial_reads: 2,
			burst_invalidations: 50,
			refresh_reads,
			sql_counts: { page: sql_reads, authorization: authorization_reads, anchor: anchor_reads },
			revoked_window_empty: true,
			owned_sql_closed: true,
		};
	} finally {
		for (const client of clients) client.dispose();
		hub.dispose();
		await hub.flush();
		db.close();
		assert.throws(() => db.query("SELECT 1").get());
	}
};
if (import.meta.main) console.log(JSON.stringify(await run_sql_lists()));
