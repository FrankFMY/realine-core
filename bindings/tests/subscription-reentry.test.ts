/* oxlint-disable eslint/require-await -- Fixture authorization is a real asynchronous transport seam. */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { init_realine, Subscription, wasm_url } from "../src/index.js";
import type { Grant, Snapshot, SyncRequest } from "../src/protocol.js";
import type { StreamListener } from "../src/subscription.js";

test.each(["complete", "dispose"] as const)(
	"A to B to synchronous C retains ready/busy custody through the held newest snapshot: %s",
	async (finish): Promise<void> => {
		init_realine(await readFile(wasm_url));
		const scope = { product: "ide", tenant: "a", resource: "projects", channel: "list" };
		const grant: Grant = { scope, actor_id: "actor", session_id: "session", permission_version: "1", expires_at_ms: 10000 };
		const listeners: { request: SyncRequest; listener: StreamListener; signal: AbortSignal; stops: number }[] = [];
		let held!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve): void => {
			held = resolve;
		});
		const gate = new Promise<void>((resolve): void => {
			release = resolve;
		});
		const snapshots: number[] = [];
		const stream = new Subscription({
			scope,
			config: { max_events: 4, max_buffer_bytes: 1024, max_payload_bytes: 256 },
			now: (): number => 100,
			decode: (value) => value,
			transport: {
				authorize: async (): Promise<Grant> => grant,
				listen: async (request, listener, signal): Promise<() => void> => {
					const installed = { request, listener, signal, stops: 0 };
					listeners.push(installed);
					if (listeners.length === 2) listener.event({ scope, generation: request.generation, epoch: "C", previous: "0", revision: "1", data: null });
					return (): void => {
						installed.stops++;
					};
				},
				snapshot: async (request): Promise<Snapshot> => {
					snapshots.push(request.generation);
					if (request.generation === 3) {
						held();
						await gate;
					}
					return {
						scope,
						generation: request.generation,
						epoch: request.generation === 1 ? "A" : "C",
						revision: request.generation === 1 ? "10" : "1",
						data: null,
					};
				},
			},
		});
		try {
			await stream.connect();
			stream.pull(4);
			listeners[0]!.listener.event({ scope, generation: 1, epoch: "B", previous: "0", revision: "1", data: null });
			await entered;
			let ready = false;
			const waiting = stream.ready().then((): void => {
				ready = true;
			});
			await Promise.resolve();
			expect(ready).toBe(false);
			expect(stream.view().state).toBe("syncing");
			await expect(stream.connect()).rejects.toMatchObject({ code: "busy" });
			expect(listeners).toHaveLength(3);
			expect(listeners.map((item) => item.stops)).toEqual([1, 1, 0]);
			if (finish === "dispose") stream.dispose();
			release();
			await waiting;
			expect(ready).toBe(true);
			if (finish === "complete") {
				expect(stream.view().cursor?.epoch).toBe("C");
				expect(stream.pull(4)).toHaveLength(1);
				expect(stream.pull(4)).toHaveLength(0);
			} else expect(stream.view().state).toBe("disposed");
		} finally {
			release();
			stream.dispose();
			await stream.ready();
		}
		expect(listeners.map((item) => item.stops)).toEqual([1, 1, 1]);
		expect(listeners.every((item) => item.signal.aborted)).toBe(true);
		expect(snapshots.at(-1)).toBe(3);
	},
);

test("synchronous listen delivery cannot reenter a recovery attempt before its custody is registered", async (): Promise<void> => {
	init_realine(await readFile(wasm_url));
	const scope = { product: "ide", tenant: "a", resource: "projects", channel: "list" };
	const grant: Grant = { scope, actor_id: "actor", session_id: "session", permission_version: "1", expires_at_ms: 10000 };
	let first: { request: SyncRequest; listener: import("../src/subscription.js").StreamListener } | null = null;
	let calls = 0;
	let entered!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve): void => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve): void => {
		release = resolve;
	});
	const stream = new Subscription({
		scope,
		config: { max_events: 4, max_buffer_bytes: 1024, max_payload_bytes: 256 },
		now: (): number => 100,
		decode: (value) => value,
		transport: {
			authorize: async (): Promise<Grant> => grant,
			listen: async (request, listener): Promise<() => void> => {
				calls++;
				if (calls === 1) first = { request, listener };
				if (calls === 2) {
					listener.event({ scope, generation: request.generation, epoch: "three", previous: "0", revision: "1", data: null });
					entered();
					await gate;
				} else if (calls === 3) await gate;
				return (): void => {
					/* No external listener resource in this synchronous-delivery fixture. */
				};
			},
			snapshot: async (request): Promise<Snapshot> => ({
				scope,
				generation: request.generation,
				epoch: calls === 1 ? "one" : "three",
				revision: calls === 1 ? "10" : "1",
				data: null,
			}),
		},
	});
	try {
		await stream.connect();
		if (!first) throw new Error("first listener missing");
		const active = first as { request: SyncRequest; listener: import("../src/subscription.js").StreamListener };
		active.listener.event({ scope, generation: active.request.generation, epoch: "two", previous: "0", revision: "1", data: null });
		await started;
		expect(calls).toBe(2);
		release();
		await stream.ready();
		expect(calls).toBe(3);
		expect(stream.view().state).toBe("live");
		expect(stream.view().cursor?.epoch).toBe("three");
	} finally {
		release();
		stream.dispose();
		await stream.ready();
	}
});
