import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { init_realine, wasm_url } from "../src/index.js";
import { ListClient } from "../src/list-client.js";
import { ListCore } from "../src/list-core.js";
import type { JsonValue, PageCursor } from "../src/protocol.js";
import { intent, list_config, SqlListFixture } from "./list-fixture.js";

test("real SQL filters before paging, continues by checked record anchors and keeps distinct scoped sort windows", async (): Promise<void> => {
	init_realine(await readFile(wasm_url));
	const fixture = new SqlListFixture();
	const hub = fixture.hub();
	const clients: ListClient<JsonValue>[] = [];
	const load = async (actor: string, query = intent(), after: PageCursor | null = null): Promise<ListClient<JsonValue>> => {
		const { request } = await hub.authorize(actor, query, after);
		const client = new ListClient({
			request,
			config: list_config,
			transport: hub.transport(actor, request),
			decode: (v): JsonValue => v,
			now: (): number => 100,
		});
		clients.push(client);
		await client.connect();
		return client;
	};
	try {
		fixture.db.prepare("UPDATE assets SET active=0 WHERE tenant='a' AND id<'a-004'").run();
		fixture.revision++;
		const first = await load("a-0");
		expect(first.view().slots.map((slot) => slot.id)).toEqual(["a-004", "a-005", "a-006", "a-007"]);
		const next = await load("a-0", intent(), first.view().next);
		expect(next.view().slots.map((slot) => slot.id)).toEqual(["a-008", "a-009", "a-010", "a-011"]);
		const inactive = await load("a-0", { ...intent(), filter: { active: false } });
		expect(inactive.view().slots.map((slot) => slot.id)).toEqual(["a-000", "a-001", "a-002", "a-003"]);
		expect(inactive.view().slots[0]?.row?.value).toMatchObject({ load: 0, available: false, note: null });
		expect(inactive.view().slots[1]?.row?.value).not.toHaveProperty("note");
		expect(JSON.stringify(first.view())).not.toContain("private price");
		const reverse = await load("a-0", { ...intent(), sort: [{ field: "name", direction: "desc", missing: "first" }] });
		expect(reverse.view().slots.map((slot) => slot.id)).toEqual(["a-063", "a-062", "a-061", "a-060"]);
		const reverse_next = await load("a-0", { ...intent(), sort: [{ field: "name", direction: "desc", missing: "first" }] }, reverse.view().next);
		expect(reverse_next.view().slots[0]?.id).toBe("a-059");
		const foreign = { query: { ...intent("b"), access: "dispatchers:1" }, after: first.view().next };
		expect(() => new ListCore(foreign, list_config)).toThrow();
		const stale = first.view().next;
		fixture.update("a-007", "Changed anchor");
		hub.invalidate((request): boolean => request.after?.anchor_id === stale?.anchor_id);
		await expect(hub.flush()).rejects.toMatchObject({ code: "stale" });
		const refused = await load("a-0", intent(), stale);
		expect(refused.error).toBe("stale");
		expect(refused.view().stream.state).toBe("uncertain");
		expect(refused.view().slots).toEqual([]);
	} finally {
		for (const client of clients) client.dispose();
		hub.dispose();
		await hub.flush();
		fixture.close();
	}
});

test("client draft bytes are UTF-8 bounded and explicit release clears conflicts without issuing commands", async (): Promise<void> => {
	init_realine(await readFile(wasm_url));
	const fixture = new SqlListFixture();
	const hub = fixture.hub();
	const { request } = await hub.authorize("a-0", intent());
	const client = new ListClient<JsonValue, { text: string }>({
		request,
		config: list_config,
		transport: hub.transport("a-0", request),
		now: (): number => 100,
		decode: (v): JsonValue => v,
		max_draft_bytes: 64,
	});
	try {
		await client.connect();
		client.edit("a-000", { text: "draft" });
		expect(() => client.edit("a-001", { text: "я".repeat(32) })).toThrow();
		expect(client.view().custody.dirty).toEqual(["a-000"]);
		expect(client.view().slots[0]?.draft?.value.text).toBe("draft");
		const mutable = client.view();
		mutable.slots[0]!.draft!.value.text = "mutated returned view";
		expect(client.view().slots[0]?.draft?.value.text).toBe("draft");
		fixture.db.prepare("DELETE FROM assets WHERE id='a-000'").run();
		fixture.revision++;
		hub.invalidate();
		await hub.flush();
		expect(client.view().slots[0]?.row).toBeNull();
		expect(() => client.accept()).toThrow();
		client.clear_draft("a-000");
		client.accept();
		expect(client.view().slots.some((slot) => slot.id === "a-000")).toBe(false);
		expect(client.view().custody.dirty).toEqual([]);
		expect(fixture.reads).toBe(2);
	} finally {
		client.dispose();
		hub.dispose();
		await hub.flush();
		fixture.close();
	}
});

test("equal scope objects do not need a caller-imposed JSON property order", async (): Promise<void> => {
	init_realine(await readFile(wasm_url));
	const fixture = new SqlListFixture();
	const hub = fixture.hub();
	const query = intent();
	query.scope = { channel: query.scope.channel, resource: query.scope.resource, tenant: query.scope.tenant, product: query.scope.product };
	const { request } = await hub.authorize("a-0", query);
	const client = new ListClient({
		request,
		config: list_config,
		transport: hub.transport("a-0", request),
		now: (): number => 100,
		decode: (v): JsonValue => v,
	});
	try {
		await client.connect();
		expect(client.view().stream.state).toBe("live");
		expect(client.view().slots.length).toBe(4);
	} finally {
		client.dispose();
		hub.dispose();
		await hub.flush();
		fixture.close();
	}
});
