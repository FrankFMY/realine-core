import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { initSync, WasmStream } from "../generated/wasm/realine_core.js";

test("Bun loads the real Rust Wasm stream and executes its scoped state machine", async (): Promise<void> => {
	// oxlint-disable-next-line node/no-sync -- Wasm instantiation, after asynchronous file loading.
	initSync({ module: await readFile(new URL("../generated/wasm/realine_core_bg.wasm", import.meta.url)) });
	const scope = { product: "ide", tenant: "workspace", resource: "project", channel: "source" };
	const core = new WasmStream(JSON.stringify(scope), JSON.stringify({ max_events: 4, max_buffer_bytes: 1024, max_payload_bytes: 256 }));
	try {
		const reply = JSON.parse(
			core.call(
				JSON.stringify({
					now_ms: 100,
					action: {
						kind: "open",
						grant: {
							scope,
							actor_id: "author",
							session_id: "session",
							permission_version: "1",
							expires_at_ms: 1000,
						},
					},
				}),
			),
		);
		expect(reply.status).toBe("ok");
		expect(reply.value.view.state).toBe("syncing");
		expect(reply.value.result.request.generation).toBe(1);
	} finally {
		core.free();
	}
});
