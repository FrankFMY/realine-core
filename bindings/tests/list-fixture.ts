/* oxlint-disable eslint/require-await -- SQL fixture implements asynchronous provider contracts over an owned synchronous database. */
import { Database } from "bun:sqlite";
import type { ListIntent, ListProvider, ListRead } from "../src/list-hub.js";
import { ListHub } from "../src/list-hub.js";
import type { Grant, JsonValue, ListConfig, ListRow } from "../src/protocol.js";
import { RealineError } from "../src/wire.js";

export const list_config: ListConfig = {
	stream: { max_events: 4, max_buffer_bytes: 131072, max_payload_bytes: 65536 },
	max_rows: 8,
	max_retained_bytes: 262144,
};
export const intent = (tenant = "a"): ListIntent => ({
	scope: { product: "inventory", tenant, resource: "assets", channel: "register" },
	projection: "public-v1",
	filter: { active: true },
	sort: [{ field: "name", direction: "asc", missing: "last" }],
	limit: 4,
});
export class SqlListFixture {
	readonly db = new Database(":memory:");
	reads = 0;
	revision = 10;
	readonly provider: ListProvider<string>;
	constructor() {
		this.db.exec(
			"CREATE TABLE access(actor TEXT PRIMARY KEY,tenant TEXT,equivalence TEXT,permission TEXT,allowed INTEGER); CREATE TABLE locations(tenant TEXT,id TEXT,label TEXT,PRIMARY KEY(tenant,id)); CREATE TABLE assets(tenant TEXT,id TEXT,revision INTEGER,name TEXT,active INTEGER,value TEXT,location TEXT,secret TEXT,PRIMARY KEY(tenant,id));",
		);
		const access = this.db.prepare("INSERT INTO access VALUES (?,?,?,?,1)");
		for (let i = 0; i < 16; i++) access.run(`a-${i}`, "a", "dispatchers", "1");
		access.run("b-0", "b", "dispatchers", "1");
		access.run("restricted", "a", "personal", "1");
		const asset = this.db.prepare("INSERT INTO assets VALUES (?,?,1,?,1,?,?,?)");
		this.db.transaction((): void => {
			for (const tenant of ["a", "b"]) {
				this.db.prepare("INSERT INTO locations VALUES (?,?,?)").run(tenant, "depot", `${tenant} depot`);
				for (let i = 0; i < 64; i++) {
					const id = `${tenant}-${String(i).padStart(3, "0")}`;
					asset.run(
						tenant,
						id,
						`Vehicle ${String(i).padStart(3, "0")}`,
						JSON.stringify({ name: `Vehicle ${String(i).padStart(3, "0")}`, available: false, load: 0, ...(i === 0 ? { note: null } : {}) }),
						"depot",
						`${tenant} private price`,
					);
				}
			}
		})();
		this.provider = {
			authorize: async (actor, query, signal): Promise<{ grant: Grant; access: string }> => {
				if (signal.aborted) throw new RealineError("not_ready");
				const access = this.db
					.prepare<{ tenant: string; equivalence: string; permission: string; allowed: number }, [string]>("SELECT * FROM access WHERE actor=?")
					.get(actor);
				if (!access?.allowed || access.tenant !== query.scope.tenant) throw new RealineError("denied");
				return {
					grant: { scope: query.scope, actor_id: actor, session_id: `session-${actor}`, permission_version: access.permission, expires_at_ms: 10000 },
					access: `${access.equivalence}:${access.permission}`,
				};
			},
			read: async (actor, { grant, request, previous }, signal): Promise<ListRead> => {
				const current = await this.provider.authorize(actor, request.query, signal);
				if (current.grant.permission_version !== grant.permission_version || current.access !== request.query.access)
					throw new RealineError("denied");
				this.reads++;
				const query = request.query;
				if (query.projection !== "public-v1" || query.sort.length !== 1 || query.sort[0]?.field !== "name") throw new RealineError("invalid_frame");
				const filter = query.filter as { active?: boolean };
				let anchor = "";
				let anchor_id = "";
				if (request.after) {
					const found = this.db
						.prepare<{ revision: number; name: string }, [string, string]>("SELECT revision,name FROM assets WHERE tenant=? AND id=?")
						.get(query.scope.tenant, request.after.anchor_id);
					if (!found || String(found.revision) !== request.after.anchor_revision) throw new RealineError("stale");
					anchor = found.name;
					anchor_id = request.after.anchor_id;
				}
				const direction = query.sort[0].direction === "asc" ? "ASC" : "DESC";
				const operator = direction === "ASC" ? ">" : "<";
				const rows = this.db
					.prepare<
						{ id: string; revision: number; value: string; location: string },
						[string, number, string, number, string, string, string, number]
					>(
						`SELECT a.id,a.revision,a.value,l.label AS location FROM assets a JOIN locations l ON l.tenant=a.tenant AND l.id=a.location WHERE a.tenant=? AND a.active=? AND a.id>=? AND (?=0 OR a.name ${operator} ? OR (a.name=? AND a.id ${operator} ?)) ORDER BY a.name ${direction},a.id ${direction} LIMIT ?`,
					)
					.all(
						query.scope.tenant,
						filter.active === false ? 0 : 1,
						current.access.startsWith("personal:") ? "a-032" : "",
						request.after ? 1 : 0,
						anchor,
						anchor,
						anchor_id,
						query.limit + 1,
					);
				const selected = rows.slice(0, query.limit).map(
					(row): ListRow => ({
						id: row.id,
						revision: String(row.revision),
						value: { ...(JSON.parse(row.value) as Record<string, JsonValue>), location: row.location },
					}),
				);
				const present = new Set(selected.map((row) => row.id));
				const departures = (previous?.records ?? [])
					.filter((row) => !present.has(row.id))
					.map((row): import("../src/protocol.js").ListDeparture => {
						const current = this.db
							.prepare<{ active: number; revision: number }, [string, string]>("SELECT active,revision FROM assets WHERE tenant=? AND id=?")
							.get(query.scope.tenant, row.id);
						if (!current) return { id: row.id, reason: "deleted" };
						if (Boolean(current.active) !== (filter.active !== false)) return { id: row.id, reason: "filter_exit" };
						return { id: row.id, reason: String(current.revision) === row.revision ? "window_exit" : "moved_out" };
					});
				return { cursor: { epoch: "fixture-db", revision: String(this.revision) }, rows: selected, has_more: rows.length > query.limit, departures };
			},
		};
	}
	hub(overrides: Partial<{ max_groups: number; max_subscribers: number; max_refresh_rounds: number }> = {}): ListHub<string> {
		return new ListHub({
			provider: this.provider,
			config: list_config,
			now: (): number => 100,
			max_groups: 8,
			max_subscribers: 32,
			max_refresh_rounds: 4,
			...overrides,
		});
	}
	update(id: string, name: string): void {
		this.db.prepare("UPDATE assets SET name=?,value=json_set(value,'$.name',?),revision=revision+1 WHERE id=?").run(name, name, id);
		this.revision++;
	}
	revoke(actor: string): void {
		this.db.prepare("UPDATE access SET allowed=0 WHERE actor=?").run(actor);
	}
	close(): void {
		this.db.close();
	}
}
