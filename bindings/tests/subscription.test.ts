/* oxlint-disable eslint/require-await -- Transport fixture hooks deliberately expose the real asynchronous I/O interface. */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { Event, Grant, JsonValue, Snapshot, StreamListener, SyncRequest } from "../src/index.js";
import { init_realine, Subscription, wasm_url } from "../src/index.js";

const scope = { product: "dispatch", tenant: "company-a", resource: "fleet", channel: "vehicles" };
const config = { max_events: 4, max_buffer_bytes: 1024, max_payload_bytes: 256 };
const grant: Grant = { scope, actor_id: "operator", session_id: "session", permission_version: "1", expires_at_ms: 10000 };
const decode = (value: JsonValue): { count: number } => {
	if (typeof value !== "object" || value === null || Array.isArray(value) || typeof value.count !== "number") throw new TypeError("count required");
	return { count: value.count };
};

test("a source restart while its replacement snapshot is in flight completes a new Rust synchronization", async (): Promise<void> => {
	init_realine(await readFile(wasm_url));
	let active: { request: SyncRequest; listener: StreamListener } | null = null;
	let reads = 0;
	const stream = new Subscription({
		scope,
		config,
		now: (): number => 100,
		decode,
		transport: {
			authorize: async (): Promise<Grant> => grant,
			listen: async (request, listener): Promise<() => void> => {
				active = { request, listener };
				return (): void => {
					/* No external resource in this restart fixture. */
				};
			},
			snapshot: async (request): Promise<Snapshot> => {
				reads += 1;
				return {
					scope,
					generation: request.generation,
					epoch: reads === 1 ? "one" : "three",
					revision: reads === 1 ? "10" : "0",
					data: { count: reads },
				};
			},
		},
	});
	try {
		await stream.connect();
		if (!active) throw new Error("listener missing");
		const first = active as { request: SyncRequest; listener: StreamListener };
		first.listener.event({ scope, generation: first.request.generation, epoch: "two", previous: "0", revision: "1", data: { count: 2 } });
		await stream.ready();
		expect(reads).toBe(3);
		expect(stream.view().state).toBe("live");
		expect(stream.view().cursor?.epoch).toBe("three");
	} finally {
		stream.dispose();
	}
});

test("disposal cancels an in-flight read and late callbacks cannot restore protected data", async (): Promise<void> => {
	init_realine(await readFile(wasm_url));
	let release!: (value: Snapshot) => void;
	let entered!: () => void;
	const started = new Promise<void>((resolve): void => {
		entered = resolve;
	});
	const response = new Promise<Snapshot>((resolve): void => {
		release = resolve;
	});
	let active: { request: SyncRequest; listener: StreamListener; signal: AbortSignal } | null = null;
	let stops = 0;
	const stream = new Subscription({
		scope,
		config,
		now: (): number => 100,
		decode,
		transport: {
			authorize: async (): Promise<Grant> => grant,
			listen: async (request, listener, signal): Promise<() => void> => {
				active = { request, listener, signal };
				return (): void => {
					stops += 1;
				};
			},
			snapshot: async (): Promise<Snapshot> => {
				entered();
				return response;
			},
		},
	});
	const connecting = stream.connect();
	await started;
	await expect(stream.connect()).rejects.toMatchObject({ code: "busy" });
	stream.dispose();
	await expect(stream.connect()).rejects.toMatchObject({ code: "disposed" });
	if (!active) throw new Error("listener missing");
	const first = active as { request: SyncRequest; listener: StreamListener; signal: AbortSignal };
	expect(first.signal.aborted).toBe(true);
	release({ scope, generation: first.request.generation, epoch: "one", revision: "10", data: { count: 1 } });
	await connecting;
	first.listener.event({ scope, generation: first.request.generation, epoch: "one", previous: "10", revision: "11", data: { count: 2 } });
	first.listener.disconnected();
	expect(stream.view().state).toBe("disposed");
	expect(stream.view().queued_events).toBe(0);
	expect(stops).toBe(1);
});

test("injected transport connects before snapshot and automatically resyncs Rust-detected gaps", async (): Promise<void> => {
	init_realine(await readFile(wasm_url));
	let request: SyncRequest | null = null;
	let listener: StreamListener | null = null;
	let snapshot_revision = "10";
	let reads = 0;
	let stops = 0;
	const order: string[] = [];
	const stream = new Subscription({
		scope,
		config,
		now: (): number => 100,
		decode,
		transport: {
			authorize: async (): Promise<Grant> => grant,
			listen: async (next, callbacks): Promise<() => void> => {
				request = next;
				listener = callbacks;
				order.push("listen");
				return (): void => {
					stops += 1;
				};
			},
			snapshot: async (next): Promise<Snapshot> => {
				order.push("snapshot");
				reads += 1;
				return { scope, generation: next.generation, epoch: "source", revision: snapshot_revision, data: { count: reads } };
			},
		},
	});
	try {
		await stream.connect();
		expect(stream.view().state).toBe("live");
		expect(order).toEqual(["listen", "snapshot"]);
		expect(stream.pull(4)[0]?.data).toEqual({ count: 1 });
		if (!request || !listener) throw new Error("transport must be installed");
		const first = { request: request as SyncRequest, listener: listener as StreamListener };
		const event = (previous: string, revision: string): Event => ({
			scope,
			generation: first.request.generation,
			epoch: "source",
			previous,
			revision,
			data: { count: 2 },
		});
		first.listener.event(event("10", "15"));
		expect(stream.pull(4)[0]?.cursor.revision).toBe("15");
		snapshot_revision = "20";
		first.listener.event(event("19", "20"));
		await stream.ready();
		expect(reads).toBe(2);
		expect(stops).toBe(1);
		expect(stream.view().state).toBe("live");
		expect(stream.pull(4)[0]?.cursor.revision).toBe("20");
		first.listener.event(event("20", "21"));
		expect(stream.pull(4)).toEqual([]);
		stream.disconnect();
		expect(stream.view().state).toBe("uncertain");
		await stream.connect();
		expect(reads).toBe(3);
		(listener as StreamListener).revoked();
		expect(stream.view().state).toBe("revoked");
		expect(stream.view().queued_events).toBe(0);
	} finally {
		stream.dispose();
	}
	expect(stops).toBe(3);
});
