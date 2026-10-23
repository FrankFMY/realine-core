import { WasmPresence } from "../generated/wasm/realine_core.js";
import type {
	Grant,
	PreparedPresence,
	PresenceAction,
	PresenceConfig,
	PresenceKey,
	PresenceOutput,
	PresenceSignal,
	PresenceView,
	Scope,
} from "./protocol.js";
import { construct, RealineError, to_json, unpack } from "./wire.js";

export class PresenceCore {
	private core: WasmPresence | null;
	private final_view: PresenceView | null = null;
	constructor(scope: Scope, key: PresenceKey, config: PresenceConfig) {
		this.core = construct((): WasmPresence => new WasmPresence(to_json(scope), to_json(key), to_json(config)));
	}
	dispatch(action: PresenceAction, now_ms: number): PresenceOutput {
		if (!this.core) throw new RealineError("disposed");
		return unpack<PresenceOutput>(this.core.call(to_json({ action, now_ms })));
	}
	view(): PresenceView {
		return this.core ? this.dispatch({ kind: "view" }, 0).view : structuredClone(this.final_view!);
	}
	dispose(): void {
		if (!this.core) return;
		this.final_view = this.dispatch({ kind: "dispose" }, 0).view;
		this.core.free();
		this.core = null;
	}
}

/** Server-host hooks. Storage rechecks current authority inside its own idempotent transaction. */
export interface PresenceProvider {
	current(scope: Scope, key: PresenceKey, signal: AbortSignal): Promise<Grant>;
	store(grant: Grant, observation: PreparedPresence, signal: AbortSignal): Promise<void>;
}

export class PresenceHost {
	readonly core: PresenceCore;
	private readonly provider: PresenceProvider;
	private readonly now: () => number;
	private controller: AbortController | null = null;
	constructor(core: PresenceCore, provider: PresenceProvider, now: () => number) {
		this.core = core;
		this.provider = provider;
		this.now = now;
	}
	observe(signal: PresenceSignal): Promise<PresenceView> {
		return this.run(signal);
	}
	retry(): Promise<PresenceView> {
		return this.run(null);
	}
	revoke(): void {
		this.controller?.abort();
		if (this.core.view().lifecycle !== "disposed") this.core.dispatch({ kind: "revoke" }, 0);
	}
	dispose(): void {
		this.controller?.abort();
		this.core.dispose();
	}

	private async run(signal: PresenceSignal | null): Promise<PresenceView> {
		if (this.core.view().lifecycle === "disposed") throw new RealineError("disposed");
		if (this.controller) throw new RealineError("busy");
		const controller = new AbortController();
		this.controller = controller;
		try {
			const grant = await this.authorize(controller.signal);
			const { pending } = this.core.dispatch(signal === null ? { kind: "pending", grant } : { kind: "prepare", grant, signal }, this.now());
			if (!pending) throw new RealineError("not_ready");
			try {
				await this.provider.store(grant, pending, controller.signal);
			} catch (error) {
				if (error instanceof RealineError && ["denied", "expired", "invalid_grant", "invalid_scope"].includes(error.code)) {
					this.revoke();
					throw error;
				}
				throw new RealineError("storage");
			}
			const current = await this.authorize(controller.signal);
			return this.core.dispatch({ kind: "commit", ticket: pending.ticket, grant: current }, this.now()).view;
		} finally {
			if (this.controller === controller) this.controller = null;
		}
	}

	private async authorize(signal: AbortSignal): Promise<Grant> {
		if (signal.aborted) throw new RealineError("denied");
		const view = this.core.view();
		let grant: Grant;
		try {
			grant = await this.provider.current(view.scope, view.key, signal);
		} catch (error) {
			this.revoke();
			throw error instanceof RealineError ? error : new RealineError("denied");
		}
		if (signal.aborted) throw new RealineError("denied");
		return grant;
	}
}
