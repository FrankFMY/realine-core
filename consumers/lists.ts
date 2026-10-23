import type { Grant, JsonValue, StreamListener, SyncRequest } from "@frankfmy/realine-core";
import { RealineError } from "@frankfmy/realine-core";
import type { ListConfig, ListInput, ListRequest, ListView } from "@frankfmy/realine-core/lists";
import { ListClient, ListCore, ListPlan } from "@frankfmy/realine-core/lists";

export interface ListScenarios {
	request: ListRequest;
	config: ListConfig;
	inputs: ListInput[];
}
const assert = (condition: unknown, message: string): void => {
	if (!condition) throw new Error(message);
};
export const run_list_consumer = (scenario: ListScenarios): unknown[] => {
	const plan = new ListPlan(scenario.request, scenario.config);
	const core = new ListCore(scenario.request, scenario.config);
	try {
		const trace = scenario.inputs.map((input): unknown => {
			const step = structuredClone(input);
			if (step.action.kind === "stream") {
				const action = step.action.action;
				if (action.kind === "snapshot" || action.kind === "event") {
					const frame = action.kind === "snapshot" ? action.snapshot : action.event;
					(frame.data as Record<string, JsonValue>).request_key = plan.key;
				}
			}
			try {
				return { status: "ok", value: core.action(step.action, step.now_ms) };
			} catch (error) {
				if (!(error instanceof RealineError)) throw error;
				return { status: "error", code: error.code };
			}
		});
		const view = (index: number): ListView => (trace[index] as { value: { view: ListView } }).value.view;
		assert(view(3).slots[0]?.departure === "deleted" && view(3).slots[0]?.row === null, "departure must keep a data-free stable slot");
		assert(view(3).slots[1]?.conflict, "dirty row must expose a remote revision conflict");
		assert((trace[6] as { code: string }).code === "busy", "dirty departed work cannot be compacted implicitly");
		assert((trace[16] as { code: string }).code === "denied", "revoked handle must reject late data");
		assert(view(19).stream.state === "disposed" && view(21).slots.length === 0, "terminal disposal must erase protected rows");
		return trace;
	} finally {
		core.dispose();
		plan.dispose();
	}
};

export const run_list_client = async (
	scenario: ListScenarios,
	grant: Grant,
): Promise<{ draft_preserved: boolean; focus_preserved: boolean; late_denied: boolean }> => {
	const { request, config } = scenario;
	const plan = new ListPlan(request, config);
	let cursor = { epoch: "client-db", revision: "10" };
	let page = plan.page(
		cursor,
		[
			{ id: "a", revision: "1", value: { name: "A" } },
			{ id: "b", revision: "1", value: { name: "B" } },
		],
		false,
	);
	let active: { request: SyncRequest; listener: StreamListener } | null = null;
	const client = new ListClient<JsonValue, { quantity: string }>({
		request,
		config,
		now: (): number => 100,
		decode: (value): JsonValue => value,
		transport: {
			authorize: (): Promise<Grant> => Promise.resolve(grant),
			listen: (request, listener): Promise<() => void> => {
				active = { request, listener };
				return Promise.resolve((): void => {
					/* No external resource in this injected browser fixture. */
				});
			},
			snapshot: (sync): Promise<unknown> => Promise.resolve({ scope: sync.scope, generation: sync.generation, ...cursor, data: page }),
		},
	});
	try {
		await client.connect();
		client.interaction({ focus: "b", selection: ["b"], anchor: { id: "b", offset_px: -21 } });
		client.edit("b", { quantity: "invalid unsent" });
		if (!active) throw new Error("list listener absent");
		const first = active as { request: SyncRequest; listener: StreamListener };
		const next_cursor = { ...cursor, revision: "12" };
		const next = plan.page(
			next_cursor,
			[
				{ id: "c", revision: "1", value: { name: "C" } },
				{ id: "b", revision: "2", value: { name: "B changed" } },
			],
			false,
		);
		const patch = plan.diff(next_cursor, page, next, [{ id: "a", reason: "deleted" }]);
		first.listener.event({
			scope: request.query.scope,
			generation: first.request.generation,
			epoch: cursor.epoch,
			previous: cursor.revision,
			revision: next_cursor.revision,
			data: patch,
		});
		cursor = next_cursor;
		page = next;
		assert(client.view().slots[1]?.draft?.value.quantity === "invalid unsent", "unsent input must survive a real remote patch");
		client.accept();
		assert(
			client.view().custody.focus === "b" && client.view().custody.anchor?.offset_px === -21,
			"controlled movement preserves semantic focus and scroll anchor",
		);
		client.disconnect();
		await client.connect();
		assert(
			client.view().slots.find((slot) => slot.id === "b")?.draft?.value.quantity === "invalid unsent",
			"same-authority reconnect must preserve the local draft",
		);
		const current = active as { request: SyncRequest; listener: StreamListener };
		current.listener.revoked();
		first.listener.event({
			scope: request.query.scope,
			generation: first.request.generation,
			epoch: cursor.epoch,
			previous: "12",
			revision: "14",
			data: patch,
		});
		assert(
			client.view().stream.state === "revoked" && client.view().slots.length === 0 && client.view().custody.dirty.length === 0,
			"denial and late callbacks cannot restore any old window",
		);
		return { draft_preserved: true, focus_preserved: true, late_denied: true };
	} finally {
		client.dispose();
		plan.dispose();
	}
};
