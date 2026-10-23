import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import type { PreparedPresence } from "@frankfmy/realine-core";
import { PresenceCore, PresenceHost, RealineError, wasm_url } from "@frankfmy/realine-core";
import type { Scenarios } from "./consumer.js";
import { run_consumer } from "./consumer.js";
import type { ListScenarios } from "./lists.js";
import { run_sql_lists } from "./sql-lists.js";

await readFile(".realine-owned");
const scenarios = JSON.parse(await readFile("scenarios.json", "utf8")) as Scenarios;
const list_scenarios = JSON.parse(await readFile("list-scenarios.json", "utf8")) as ListScenarios;
const output = (await run_consumer(await readFile(wasm_url), scenarios, list_scenarios)) as object;
const sql_lists = await run_sql_lists();
let allowed = true;
let lose_ack = false;
let now = 100;
const core = new PresenceCore(scenarios.scope, scenarios.key, scenarios.presence_config);
const journal: PreparedPresence[] = [];
const host = new PresenceHost(
	core,
	{
		current: (): Promise<typeof scenarios.grant> => (allowed ? Promise.resolve(scenarios.grant) : Promise.reject(new RealineError("denied"))),
		store: async (grant, proposal): Promise<void> => {
			if (!allowed || grant.permission_version !== scenarios.grant.permission_version) throw new RealineError("denied");
			const previous = journal.find((entry) => entry.ticket === proposal.ticket);
			if (previous) assert.deepEqual(previous, proposal);
			else journal.push(structuredClone(proposal));
			await writeFile("bun-journal.json", JSON.stringify(journal));
			if (lose_ack) {
				lose_ack = false;
				throw new Error("synthetic committed acknowledgement loss");
			}
		},
	},
	(): number => now,
);
try {
	assert.equal((await host.observe("active")).state, "active");
	now = 110;
	lose_ack = true;
	await assert.rejects(host.observe("idle"), (error: unknown): boolean => error instanceof RealineError && error.code === "storage");
	const retained = core.dispatch({ kind: "view" }, now).pending;
	now = 112;
	assert.equal((await host.retry()).state, "idle");
	const fresh = JSON.parse(await readFile("bun-journal.json", "utf8"));
	assert.equal(fresh.length, 2);
	assert.deepEqual(fresh[1], retained);
	const before = await readFile("bun-journal.json", "utf8");
	allowed = false;
	now = 113;
	await assert.rejects(host.observe("active"), (error: unknown): boolean => error instanceof RealineError && error.code === "denied");
	assert.equal(core.view().lifecycle, "revoked");
	assert.equal(await readFile("bun-journal.json", "utf8"), before);
} finally {
	host.dispose();
}
console.log(
	JSON.stringify({
		...output,
		sql_lists,
		bun_storage: { entries: journal.length, exact_retry: true, fresh_file_read: true, denial_unchanged: true },
	}),
);
