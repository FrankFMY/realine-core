import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { init_realine, wasm_url } from "../src/index.js";
import { ListClient } from "../src/list-client.js";
import type { JsonValue } from "../src/protocol.js";
import { intent, list_config, SqlListFixture } from "./list-fixture.js";

test("client preserves invalid unsent buffers and stable interaction while remote values change", async (): Promise<void> => {
	init_realine(await readFile(wasm_url));
	const fixture = new SqlListFixture();
	const hub = fixture.hub();
	const { request } = await hub.authorize("a-0", intent());
	const client = new ListClient<JsonValue, { quantity: string }>({
		request,
		config: list_config,
		transport: hub.transport("a-0", request),
		now: (): number => 100,
		decode: (v): JsonValue => v,
	});
	try {
		await client.connect();
		client.interaction({ focus: "a-001", selection: ["a-001"], anchor: { id: "a-001", offset_px: -21 } });
		const draft = { quantity: "-not-a-number" };
		client.edit("a-001", draft);
		draft.quantity = "caller changed";
		fixture.db.prepare("UPDATE assets SET value=json_set(value,'$.load',9),revision=revision+1 WHERE id=?").run("a-001");
		fixture.revision++;
		hub.invalidate();
		await hub.flush();
		const view = client.view();
		expect(view.slots[1]?.draft).toEqual({ value: { quantity: "-not-a-number" } });
		expect(view.slots[1]?.row?.value).toMatchObject({ load: 9 });
		expect(view.slots[1]?.conflict).toBe(true);
		expect(view.custody).toEqual({ focus: "a-001", selection: ["a-001"], anchor: { id: "a-001", offset_px: -21 }, dirty: ["a-001"] });
		client.revoke();
		expect(client.view().slots).toEqual([]);
		expect(client.view().custody.dirty).toEqual([]);
	} finally {
		client.dispose();
		hub.dispose();
		fixture.close();
	}
});
