import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { init_realine, wasm_url } from "../src/index.js";
import type { ClientListView } from "../src/list-client.js";
import { ListClient } from "../src/list-client.js";
import type { JsonValue } from "../src/protocol.js";
import { intent, list_config, SqlListFixture } from "./list-fixture.js";

test("expiry during a local edit immediately notifies an empty protected view and closes its provider lease", async (): Promise<void> => {
	init_realine(await readFile(wasm_url));
	const fixture = new SqlListFixture();
	const hub = fixture.hub();
	const { request } = await hub.authorize("a-0", intent());
	let now = 100;
	let published: ClientListView<JsonValue, { text: string }> | null = null;
	const client = new ListClient<JsonValue, { text: string }>({
		request,
		config: list_config,
		transport: hub.transport("a-0", request),
		now: (): number => now,
		decode: (v): JsonValue => v,
		changed: (): void => {
			published = client.view();
		},
	});
	try {
		await client.connect();
		client.edit("a-000", { text: "unsent" });
		now = 10000;
		expect(() => client.edit("a-000", { text: "changed after expiry" })).toThrow("expired");
		expect((published as ClientListView<JsonValue, { text: string }> | null)?.stream.state).toBe("revoked");
		expect((published as ClientListView<JsonValue, { text: string }> | null)?.slots).toEqual([]);
		expect(hub.stats().subscribers).toBe(0);
	} finally {
		client.dispose();
		hub.dispose();
		await hub.flush();
		fixture.close();
	}
});
