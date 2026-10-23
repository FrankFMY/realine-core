import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { init_realine, RealineError, StreamCore, wasm_url } from "../src/index.js";

const scope = { product: "published-app", tenant: "company-a", resource: "orders", channel: "changes" };
const grant = { scope, actor_id: "operator", session_id: "session", permission_version: "1", expires_at_ms: 1000 };

test("portable boundary rejects lossy JSON values and reports typed constructor errors", async (): Promise<void> => {
	init_realine(await readFile(wasm_url));
	for (const value of [Number.NaN, Number.POSITIVE_INFINITY, { omitted: undefined }]) {
		const core = new StreamCore(scope, { max_events: 4, max_buffer_bytes: 1024, max_payload_bytes: 256 });
		try {
			const request = core.open(grant, 100);
			expect(() =>
				core.dispatch(
					{
						kind: "snapshot",
						snapshot: {
							scope,
							generation: request.generation,
							epoch: "one",
							revision: "1",
							data: value as never,
						},
					},
					101,
				),
			).toThrow(RealineError);
			expect(core.view().state).toBe("syncing");
		} finally {
			core.dispose();
		}
	}
	expect(() => new StreamCore(scope, { max_events: 0, max_buffer_bytes: 1024, max_payload_bytes: 256 })).toThrow(RealineError);
});

test("typed API uses Rust delivery and terminal disposal without sharing caller objects", async (): Promise<void> => {
	init_realine(await readFile(wasm_url));
	const core = new StreamCore(scope, { max_events: 4, max_buffer_bytes: 1024, max_payload_bytes: 256 });
	try {
		const request = core.open(grant, 100);
		request.scope.tenant = "foreign";
		expect(core.view().scope.tenant).toBe("company-a");
		const current = core.view();
		const output = core.dispatch(
			{
				kind: "snapshot",
				snapshot: { scope, generation: current.generation, epoch: "one", revision: "9223372036854775807", data: { value: null, flag: false } },
			},
			101,
		);
		expect(output.view.state).toBe("live");
		const taken = core.dispatch({ kind: "take", limit: 1 }, 102).result;
		expect(taken.kind).toBe("deliveries");
		if (taken.kind === "deliveries")
			expect(taken.items[0]).toEqual({
				kind: "snapshot",
				cursor: { epoch: "one", revision: "9223372036854775807" },
				data: { value: null, flag: false },
			});
		core.dispose();
		core.dispose();
		expect(() => core.open(grant, 103)).toThrow(RealineError);
		expect(core.view().state).toBe("disposed");
	} finally {
		core.dispose();
	}
});
