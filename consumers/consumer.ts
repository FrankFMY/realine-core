import type {
	Grant,
	JsonValue,
	PresenceConfig,
	PresenceInput,
	PresenceKey,
	Scope,
	Snapshot,
	StreamConfig,
	StreamInput,
	StreamListener,
	SyncRequest,
} from "@frankfmy/realine-core";
import { init_realine, PresenceCore, RealineError, StreamCore, Subscription } from "@frankfmy/realine-core";
import type { ListScenarios } from "./lists.js";
import { run_list_client, run_list_consumer } from "./lists.js";

export interface Scenarios {
	scope: Scope;
	grant: Grant;
	key: PresenceKey;
	config: StreamConfig;
	presence_config: PresenceConfig;
	stream: StreamInput[];
	presence: PresenceInput[];
}

const assert = (condition: unknown, message: string): void => {
	if (!condition) throw new Error(message);
};
const trace = <I, O>(inputs: I[], apply: (input: I) => O): unknown[] =>
	inputs.map((input): unknown => {
		try {
			return { status: "ok", value: apply(input) };
		} catch (error) {
			if (!(error instanceof RealineError)) throw error;
			return { status: "error", code: error.code };
		}
	});

export const run_consumer = async (bytes: BufferSource, scenarios: Scenarios, lists: ListScenarios): Promise<unknown> => {
	init_realine(bytes);
	const list_trace = run_list_consumer(lists);
	const list_client = await run_list_client(lists, scenarios.grant);
	const stream = new StreamCore(scenarios.scope, scenarios.config);
	const presence = new PresenceCore(scenarios.scope, scenarios.key, scenarios.presence_config);
	let stream_trace: unknown[];
	let presence_trace: unknown[];
	try {
		stream_trace = trace(scenarios.stream, (input) => stream.dispatch(input.action, input.now_ms));
		presence_trace = trace(scenarios.presence, (input) => presence.dispatch(input.action, input.now_ms));
	} finally {
		stream.dispose();
		presence.dispose();
	}

	let active: { request: SyncRequest; listener: StreamListener } | null = null;
	let reads = 0;
	let stops = 0;
	const subscription = new Subscription({
		scope: scenarios.scope,
		config: scenarios.config,
		now: (): number => 100,
		decode: (value: JsonValue): JsonValue => value,
		transport: {
			authorize: (): Promise<Grant> => Promise.resolve(scenarios.grant),
			listen: (request: SyncRequest, listener: StreamListener): Promise<() => void> => {
				active = { request, listener };
				return Promise.resolve((): void => {
					stops += 1;
				});
			},
			snapshot: (request: SyncRequest): Promise<Snapshot> => {
				reads += 1;
				return Promise.resolve({
					scope: scenarios.scope,
					generation: request.generation,
					epoch: "consumer",
					revision: reads === 1 ? "0" : "2",
					data: { count: reads },
				});
			},
		},
	});
	try {
		await subscription.connect();
		assert(subscription.view().state === "live", "outside subscription must load the real core");
		if (!active) throw new Error("listener absent");
		const first = active as { request: SyncRequest; listener: StreamListener };
		for (const revision of ["1", "2"])
			first.listener.event({
				scope: scenarios.scope,
				generation: first.request.generation,
				epoch: "consumer",
				previous: String(Number(revision) - 1),
				revision,
				data: { count: 2 },
			});
		await subscription.ready();
		assert(reads === 2 && stops === 1, "bounded overflow must resubscribe exactly once");
		assert(subscription.pull(2).length === 1, "replacement snapshot must be the sole delivery");
		(active as { listener: StreamListener }).listener.revoked();
		assert(subscription.view().state === "revoked" && subscription.view().queued_events === 0, "current revocation must erase queued bytes");
	} finally {
		subscription.dispose();
	}
	assert(stops === 2, "all owned listeners must close");

	const iterations = 10_000;
	const bench = new StreamCore(scenarios.scope, { max_events: 4, max_buffer_bytes: 2048, max_payload_bytes: 512 });
	let elapsed_ms: number;
	try {
		const request = bench.open(scenarios.grant, 100);
		bench.dispatch(
			{ kind: "snapshot", snapshot: { scope: scenarios.scope, generation: request.generation, epoch: "bench", revision: "0", data: { count: 0 } } },
			100,
		);
		bench.dispatch({ kind: "take", limit: 4 }, 100);
		const start = performance.now();
		for (let i = 1; i <= iterations; i += 1) {
			const result = bench.dispatch(
				{
					kind: "event",
					event: {
						scope: scenarios.scope,
						generation: request.generation,
						epoch: "bench",
						previous: String(i - 1),
						revision: String(i),
						data: { count: i },
					},
				},
				100,
			).result;
			assert(result.kind === "receive" && result.received.kind === "accepted", "benchmark event must execute");
			bench.dispatch({ kind: "take", limit: 1 }, 100);
		}
		elapsed_ms = performance.now() - start;
		assert(bench.view().cursor?.revision === String(iterations), "benchmark must consume its final event");
	} finally {
		bench.dispose();
	}
	return {
		stream: stream_trace,
		presence: presence_trace,
		lists: list_trace,
		list_client,
		injected_transport: { reads, stops, revoked: true },
		binding_timing: { iterations, elapsed_ms, ns_per_event_and_take: (elapsed_ms * 1_000_000) / iterations },
	};
};
