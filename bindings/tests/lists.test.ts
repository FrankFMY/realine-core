import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { init_realine, wasm_url } from "../src/index.js";
import { ListCore } from "../src/list-core.js";
import type { Grant, ListConfig, ListRequest } from "../src/protocol.js";

export const request: ListRequest = {
	query: {
		scope: { product: "workbench", tenant: "a", resource: "fleet", channel: "vehicles" },
		projection: "name",
		access: "dispatchers-v1",
		filter: { active: true },
		sort: [{ field: "name", direction: "asc", missing: "last" }],
		limit: 3,
	},
	after: null,
};
export const config: ListConfig = {
	stream: { max_events: 4, max_buffer_bytes: 65536, max_payload_bytes: 32768 },
	max_rows: 3,
	max_retained_bytes: 65536,
};
export const grant: Grant = { scope: request.query.scope, actor_id: "actor", session_id: "session", permission_version: "1", expires_at_ms: 10000 };

test("TS list core materializes rows through the actual owning Rust/Wasm engine", async (): Promise<void> => {
	init_realine(await readFile(wasm_url));
	const core = new ListCore(request, config);
	try {
		const sync = core.open(grant, 1);
		const key = core.window().request_key;
		core.dispatch(
			{
				kind: "snapshot",
				snapshot: {
					scope: grant.scope,
					generation: sync.generation,
					epoch: "db",
					revision: "10",
					data: {
						request_key: key,
						rows: [{ id: "a", revision: "1", value: { name: "Vehicle A", available: false, load: 0, note: null } }],
						next: null,
					},
				},
			},
			2,
		);
		expect(core.window().slots[0]?.row?.value).toEqual({ name: "Vehicle A", available: false, load: 0, note: null });
	} finally {
		core.dispose();
	}
});
