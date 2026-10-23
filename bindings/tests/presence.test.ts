/* oxlint-disable eslint/require-await -- Provider fixture hooks deliberately expose the real asynchronous I/O interface. */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { PreparedPresence } from "../src/index.js";
import { init_realine, PresenceCore, PresenceHost, RealineError, wasm_url } from "../src/index.js";

const scope = { product: "ide", tenant: "workspace", resource: "project", channel: "presence" };
const key = { actor_id: "author", session_id: "session", connection_id: "server-connection" };
const grant = { scope, actor_id: "author", session_id: "session", permission_version: "1", expires_at_ms: 10000 };
const config = { idle_after_ms: 100, uncertain_after_ms: 50, offline_after_ms: 200 };

test("transactional authority errors clear pending presence instead of enabling journal retry", async (): Promise<void> => {
	init_realine(await readFile(wasm_url));
	for (const code of ["denied", "expired", "invalid_grant", "invalid_scope"] as const) {
		let denied = false;
		const core = new PresenceCore(scope, key, config);
		const host = new PresenceHost(
			core,
			{
				current: async (): Promise<typeof grant> => grant,
				store: async (): Promise<void> => {
					if (denied) throw new RealineError(code);
				},
			},
			(): number => 100,
		);
		try {
			await host.observe("active");
			denied = true;
			await expect(host.observe("idle")).rejects.toMatchObject({ code });
			expect(core.view().lifecycle).toBe("revoked");
			expect(core.dispatch({ kind: "view" }, 100).pending).toBeNull();
		} finally {
			host.dispose();
		}
	}
});

test("disposing during a journal acknowledgement fences late commit and new work", async (): Promise<void> => {
	init_realine(await readFile(wasm_url));
	let entered!: () => void;
	let release!: () => void;
	let active_signal: AbortSignal | null = null;
	const started = new Promise<void>((resolve): void => {
		entered = resolve;
	});
	const acknowledgement = new Promise<void>((resolve): void => {
		release = resolve;
	});
	const core = new PresenceCore(scope, key, config);
	const host = new PresenceHost(
		core,
		{
			current: async (): Promise<typeof grant> => grant,
			store: async (_grant, _proposal, signal): Promise<void> => {
				active_signal = signal;
				entered();
				await acknowledgement;
			},
		},
		(): number => 100,
	);
	const observing = host.observe("active");
	await started;
	await expect(host.observe("idle")).rejects.toMatchObject({ code: "busy" });
	host.dispose();
	await expect(host.observe("active")).rejects.toMatchObject({ code: "disposed" });
	if (!active_signal) throw new Error("storage signal missing");
	expect((active_signal as AbortSignal).aborted).toBe(true);
	release();
	await expect(observing).rejects.toMatchObject({ code: "denied" });
	expect(core.view().lifecycle).toBe("disposed");
	expect(core.view().state).toBe("offline");
});

test("TS server host persists the Rust proposal and retries a lost journal acknowledgement exactly", async (): Promise<void> => {
	init_realine(await readFile(wasm_url));
	let now = 100;
	let allowed = true;
	let lose_ack = false;
	const stored = new Map<number, PreparedPresence>();
	const attempts: PreparedPresence[] = [];
	const core = new PresenceCore(scope, key, config);
	const host = new PresenceHost(
		core,
		{
			current: async (): Promise<typeof grant> => {
				if (!allowed) throw new RealineError("denied");
				return grant;
			},
			store: async (_grant, proposal): Promise<void> => {
				attempts.push(proposal);
				const existing = stored.get(proposal.ticket);
				if (existing) expect(proposal).toEqual(existing);
				stored.set(proposal.ticket, structuredClone(proposal));
				if (lose_ack) {
					lose_ack = false;
					throw new Error("synthetic committed response loss");
				}
			},
		},
		(): number => now,
	);
	try {
		expect((await host.observe("active")).state).toBe("active");
		now = 110;
		lose_ack = true;
		await expect(host.observe("idle")).rejects.toMatchObject({ code: "storage" });
		expect(core.view().state).toBe("active");
		const pending = core.dispatch({ kind: "view" }, now).pending;
		if (!pending) throw new Error("Rust must retain the failed proposal");
		await expect(host.observe("active")).rejects.toMatchObject({ code: "busy" });
		now = 111;
		expect((await host.retry()).state).toBe("idle");
		expect(attempts[1]).toEqual(pending);
		expect(attempts[2]).toEqual(pending);
		expect(stored.size).toBe(2);
		allowed = false;
		now = 112;
		await expect(host.observe("active")).rejects.toMatchObject({ code: "denied" });
		expect(core.view().lifecycle).toBe("revoked");
		expect(core.view().state).toBe("offline");
		expect(stored.size).toBe(2);
	} finally {
		host.dispose();
		host.dispose();
	}
});
