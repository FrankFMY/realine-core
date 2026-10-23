import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers";
import { init_realine, Subscription, wasm_url } from "../src/index.js";
import { ListCore } from "../src/list-core.js";
import type { ListHub } from "../src/list-hub.js";
import { intent, list_config, SqlListFixture } from "./list-fixture.js";

const connect = async (hub: ListHub<string>, actor: string, tenant = "a"): Promise<{ core: ListCore; stream: Subscription<never> }> => {
	const { request } = await hub.authorize(actor, intent(tenant));
	const core = new ListCore(request, list_config);
	const stream = new Subscription<never>({
		core,
		scope: request.query.scope,
		config: list_config.stream,
		transport: hub.transport(actor, request),
		now: (): number => 100,
		decode: (): never => {
			throw new Error("list materializes inside Rust");
		},
	});
	try {
		await stream.connect();
		return { core, stream };
	} catch (error) {
		stream.dispose();
		throw error;
	}
};

test("twelve equal authorized SQL windows share one real query rather than one per subscriber", async (): Promise<void> => {
	init_realine(await readFile(wasm_url));
	const fixture = new SqlListFixture();
	const hub = fixture.hub();
	const clients: Awaited<ReturnType<typeof connect>>[] = [];
	try {
		clients.push(...(await Promise.all(Array.from({ length: 12 }, (_value, i) => connect(hub, `a-${i}`)))));
		expect(fixture.reads).toBe(1);
		for (const client of clients) {
			expect(client.core.window().slots.length).toBe(4);
			expect(client.core.window().slots[0]?.row?.id).toBe("a-000");
		}
	} finally {
		for (const client of clients) client.stream.dispose();
		fixture.close();
	}
});

test("mutation bursts coalesce per permitted query while tenant and access groups stay separate", async (): Promise<void> => {
	init_realine(await readFile(wasm_url));
	const fixture = new SqlListFixture();
	const hub = fixture.hub();
	const clients: Awaited<ReturnType<typeof connect>>[] = [];
	try {
		clients.push(await connect(hub, "a-0"), await connect(hub, "a-1"), await connect(hub, "b-0", "b"), await connect(hub, "restricted"));
		expect(fixture.reads).toBe(3);
		fixture.update("a-000", "Vehicle 900");
		for (let i = 0; i < 100; i++) hub.invalidate((request): boolean => request.query.scope.tenant === "a");
		await hub.flush();
		expect(fixture.reads).toBe(5);
		expect(clients[0]!.core.window().pending_order).toEqual(["a-001", "a-002", "a-003", "a-004"]);
		expect(clients[0]!.core.window().slots[0]?.row).toBeNull();
		expect(clients[0]!.core.window().slots[0]?.departure).toBe("moved_out");
		expect(clients[1]!.core.window().slots).toEqual(clients[0]!.core.window().slots);
		expect(clients[2]!.core.window().slots[0]?.row?.id).toBe("b-000");
		expect(clients[3]!.core.window().slots[0]?.row?.id).toBe("a-032");
		expect(clients[3]!.core.window().pending).toBe(false);
	} finally {
		for (const client of clients) client.stream.dispose();
		fixture.close();
	}
});

test("revocation during an unchanged SQL read still clears the denied window before any cached delivery", async (): Promise<void> => {
	init_realine(await readFile(wasm_url));
	const fixture = new SqlListFixture();
	let hold = false;
	let entered!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve): void => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve): void => {
		release = resolve;
	});
	const read = fixture.provider.read;
	fixture.provider.read = async (...args): ReturnType<typeof read> => {
		const result = await read(...args);
		if (hold) {
			entered();
			await gate;
		}
		return result;
	};
	const hub = fixture.hub();
	const clients: Awaited<ReturnType<typeof connect>>[] = [];
	try {
		clients.push(await connect(hub, "a-0"), await connect(hub, "a-1"));
		hold = true;
		hub.invalidate();
		await started;
		fixture.revoke("a-0");
		release();
		await hub.flush();
		expect(clients[0]!.core.window().stream.state).toBe("revoked");
		expect(clients[0]!.core.window().slots).toEqual([]);
		expect(clients[1]!.core.window().stream.state).toBe("live");
	} finally {
		release();
		await hub.flush();
		for (const client of clients) client.stream.dispose();
		fixture.close();
	}
});

test("group and subscriber quotas reject new work explicitly and disposal releases exact owned windows", async (): Promise<void> => {
	init_realine(await readFile(wasm_url));
	const fixture = new SqlListFixture();
	const hub = fixture.hub({ max_groups: 1, max_subscribers: 2 });
	const clients: Awaited<ReturnType<typeof connect>>[] = [];
	try {
		clients.push(await connect(hub, "a-0"), await connect(hub, "a-1"));
		await expect(connect(hub, "a-2")).rejects.toMatchObject({ code: "busy" });
		expect(hub.stats()).toEqual({ groups: 1, subscribers: 2, reading: 0 });
		clients[1]!.stream.dispose();
		await expect(connect(hub, "b-0", "b")).rejects.toMatchObject({ code: "busy" });
		hub.dispose();
		expect(hub.stats()).toEqual({ groups: 0, subscribers: 0, reading: 0 });
		expect(clients[0]!.core.window().slots.every((slot): boolean => slot.row === null)).toBe(true);
		await expect(connect(hub, "a-0")).rejects.toMatchObject({ code: "disposed" });
	} finally {
		for (const client of clients) client.stream.dispose();
		hub.dispose();
		fixture.close();
	}
});

test("continuous invalidation hits an explicit bounded recovery state instead of an endless refresh loop", async (): Promise<void> => {
	init_realine(await readFile(wasm_url));
	const fixture = new SqlListFixture();
	const hub = fixture.hub({ max_refresh_rounds: 2 });
	let remaining = 0;
	const read = fixture.provider.read;
	fixture.provider.read = async (...args): ReturnType<typeof read> => {
		const result = await read(...args);
		if (remaining-- > 0) hub.invalidate();
		return result;
	};
	const client = await connect(hub, "a-0");
	try {
		remaining = 3;
		hub.invalidate();
		await expect(hub.flush()).rejects.toMatchObject({ code: "busy" });
		expect(fixture.reads).toBe(3);
		expect(client.core.window().stream.state).toBe("uncertain");
		expect(client.core.window().slots.every((slot): boolean => slot.row === null)).toBe(true);
		remaining = 0;
		await client.stream.connect();
		expect(client.core.window().stream.state).toBe("live");
	} finally {
		remaining = 0;
		client.stream.dispose();
		hub.dispose();
		fixture.close();
	}
});

test("an ignoring-cancellation provider still consumes its quota until settlement and cannot revive a disposed window", async (): Promise<void> => {
	init_realine(await readFile(wasm_url));
	const fixture = new SqlListFixture();
	const hub = fixture.hub({ max_groups: 1 });
	let hold = false;
	let entered!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve): void => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve): void => {
		release = resolve;
	});
	const read = fixture.provider.read;
	fixture.provider.read = async (...args): ReturnType<typeof read> => {
		const result = await read(...args);
		if (hold) {
			hold = false;
			entered();
			await gate;
		}
		return result;
	};
	const client = await connect(hub, "a-0");
	let pending: Promise<void> | null = null;
	try {
		hold = true;
		fixture.update("a-001", "Changed");
		hub.invalidate();
		await started;
		pending = hub.flush();
		client.stream.dispose();
		await expect(connect(hub, "a-1")).rejects.toMatchObject({ code: "busy" });
		expect(hub.stats()).toEqual({ groups: 0, subscribers: 0, reading: 1 });
		release();
		await pending;
		expect(client.core.window().stream.state).toBe("disposed");
		expect(client.core.window().slots).toEqual([]);
		const next = await connect(hub, "a-1");
		next.stream.dispose();
		expect(hub.stats()).toEqual({ groups: 0, subscribers: 0, reading: 0 });
	} finally {
		release();
		await pending;
		client.stream.dispose();
		hub.dispose();
		await hub.flush();
		fixture.close();
	}
});

test("an invalidation arriving during refresh promise settlement is not stranded", async (): Promise<void> => {
	init_realine(await readFile(wasm_url));
	const fixture = new SqlListFixture();
	const hub = fixture.hub();
	const client = await connect(hub, "a-0");
	let armed = true;
	const read = fixture.provider.read;
	fixture.provider.read = async (...args): ReturnType<typeof read> => {
		const result = await read(...args);
		if (armed) {
			armed = false;
			let hops = 6;
			const later = (): void => {
				if (--hops > 0) queueMicrotask(later);
				else {
					fixture.update("a-000", "Vehicle 000 updated");
					hub.invalidate();
				}
			};
			queueMicrotask(later);
		}
		return result;
	};
	try {
		hub.invalidate();
		await hub.flush();
		await new Promise<void>((resolve): void => {
			setImmediate(resolve);
		});
		expect(fixture.reads).toBe(3);
		expect(client.core.window().slots[0]?.row?.value).toMatchObject({ name: "Vehicle 000 updated" });
		expect(hub.stats().reading).toBe(0);
	} finally {
		client.stream.dispose();
		hub.dispose();
		await hub.flush();
		fixture.close();
	}
});

test("authorization attempts retain their quota while an aborted provider ignores cancellation", async (): Promise<void> => {
	init_realine(await readFile(wasm_url));
	const fixture = new SqlListFixture();
	const hub = fixture.hub({ max_groups: 1, max_subscribers: 1 });
	let calls = 0;
	let release!: () => void;
	const gate = new Promise<void>((resolve): void => {
		release = resolve;
	});
	const authorize = fixture.provider.authorize;
	fixture.provider.authorize = async (...args): ReturnType<typeof authorize> => {
		calls++;
		await gate;
		return authorize(...args);
	};
	const controllers = Array.from({ length: 20 }, () => new AbortController());
	const attempts = controllers.map((controller) =>
		hub.authorize("a-0", intent(), null, controller.signal).then(
			() => "unexpected-success",
			(error: unknown) => (error as { code: string }).code,
		),
	);
	try {
		expect(calls).toBe(1);
		expect(hub.authorizing).toBe(1);
		for (const controller of controllers) controller.abort();
		hub.dispose();
		expect(hub.authorizing).toBe(1);
		release();
		const results = await Promise.all(attempts);
		expect(results.filter((code) => code === "busy").length).toBe(19);
		expect(results).not.toContain("unexpected-success");
		expect(hub.authorizing).toBe(0);
	} finally {
		release();
		await Promise.all(attempts);
		hub.dispose();
		fixture.close();
	}
});
