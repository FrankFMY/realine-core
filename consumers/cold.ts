import { init_realine, PresenceCore, PresenceHost, RealineError, StreamCore, Subscription } from "@frankfmy/realine-core";
import { ListClient, ListCore, ListHub, ListPlan } from "@frankfmy/realine-core/lists";
import * as protocol from "@frankfmy/realine-core/protocol";
import { RevisionedWindow } from "@frankfmy/realine-core/window";

const scope = { product: "catalog", tenant: "sample", resource: "items", channel: "changes" };
const config = { max_events: 4, max_buffer_bytes: 4096, max_payload_bytes: 1024 };
const request = { query: { scope, projection: "summary", access: "reader", filter: null, sort: [], limit: 3 }, after: null };
const grant = { scope, actor_id: "reader", session_id: "session", permission_version: "1", expires_at_ms: 1000 };
const transport = {
	authorize: () => Promise.resolve(grant),
	listen: () => Promise.resolve(() => {}),
	snapshot: () => Promise.resolve(null),
};
const presence = (): PresenceCore =>
	new PresenceCore(
		scope,
		{ actor_id: "reader", session_id: "session", connection_id: "cold" },
		{ idle_after_ms: 100, uncertain_after_ms: 50, offline_after_ms: 200 },
	);
export const cold_kinds = ["stream", "presence", "subscription", "list", "plan", "client", "window", "hub", "presence-host"] as const;
export const run_cold = async (kind: string, load: () => Promise<BufferSource>): Promise<object> => {
	const create = (): { dispose(): void } | { stop(): void } => {
		switch (kind) {
			case "stream":
				return new StreamCore(scope, config);
			case "presence":
				return presence();
			case "subscription":
				return new Subscription({ scope, config, transport, decode: (v) => v, now: () => 100 });
			case "list":
				return new ListCore(request);
			case "plan":
				return new ListPlan(request);
			case "client":
				return new ListClient({ request, transport, decode: (v) => v, now: () => 100 });
			case "window":
				return new RevisionedWindow(scope, "summary");
			case "hub":
				return new ListHub({
					max_groups: 1,
					max_subscribers: 1,
					max_refresh_rounds: 1,
					now: () => 100,
					provider: {
						authorize: () => Promise.resolve({ grant, access: "reader" }),
						read: () => Promise.resolve({ cursor: { epoch: "one", revision: "1" }, rows: [], has_more: false }),
					},
				});
			case "presence-host":
				return new PresenceHost(presence(), { current: () => Promise.resolve(grant), store: () => Promise.resolve() }, () => 100);
			default:
				throw new Error(`unknown cold path ${kind}`);
		}
	};
	if (Object.keys(protocol).length !== 0) throw new Error("protocol export must contain only generated types");
	if (kind !== "hub") {
		try {
			create();
			throw new Error(`cold ${kind} unexpectedly constructed`);
		} catch (error) {
			if (!(error instanceof RealineError) || error.code !== "not_ready") throw error;
		}
	}
	const bytes = await load();
	if (!WebAssembly.validate(bytes)) throw new Error("not a real Wasm module");
	init_realine(bytes);
	const owner = create();
	if (owner instanceof ListHub) await owner.authorize("reader", request.query);
	if (owner instanceof RevisionedWindow) {
		owner.update({ epoch: "one", revision: "1" }, [{ id: "a", revision: "1", value: "cold" }]);
		if (owner.view().slots[0]?.row?.value !== "cold") throw new Error("cold window failed");
	}
	if ("dispose" in owner) owner.dispose();
	else owner.stop();
	return { kind, cold_import: true, explicit_initialization: true, constructed_and_disposed: true };
};
