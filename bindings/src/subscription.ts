import type { StreamDriver } from "./core.js";
import { StreamCore } from "./core.js";
import type { Cursor, ErrorCode, Event, Grant, JsonValue, Scope, Snapshot, StreamConfig, StreamView, SyncRequest } from "./protocol.js";
import { RealineError } from "./wire.js";

export interface StreamListener {
	failed?(code: ErrorCode): void;
	event(frame: unknown): void;
	disconnected(): void;
	revoked(): void;
}

/** listen resolves only after delivery is installed; snapshot is an authorized consistent baseline. */
export interface StreamTransport {
	authorize(scope: Scope, signal: AbortSignal): Promise<Grant>;
	listen(request: SyncRequest, listener: StreamListener, signal: AbortSignal): Promise<() => void>;
	snapshot(request: SyncRequest, signal: AbortSignal): Promise<unknown>;
}

export interface TypedDelivery<T> {
	kind: "snapshot" | "event";
	cursor: Cursor;
	data: T;
}

export interface SubscriptionOptions<T> {
	core?: StreamDriver;
	scope: Scope;
	config: StreamConfig;
	transport: StreamTransport;
	now(): number;
	decode(value: JsonValue): T;
	changed?(view: StreamView): void;
}

export class Subscription<T> {
	readonly core: StreamDriver;
	private readonly options: SubscriptionOptions<T>;
	private controller: AbortController | null = null;
	private stop: (() => void) | null = null;
	private task: Promise<void> | null = null;
	private queued_sync: SyncRequest | null = null;
	error: RealineError["code"] | "transport" | null = null;
	constructor(options: SubscriptionOptions<T>) {
		this.options = options;
		this.core = options.core ?? new StreamCore(options.scope, options.config);
	}
	connect(): Promise<void> {
		return this.begin();
	}
	async ready(): Promise<void> {
		// oxlint-disable-next-line eslint/no-await-in-loop -- Recovery generations depend on the preceding synchronization; only one I/O attempt exists.
		while (this.task) await this.task;
	}
	pull(limit: number): TypedDelivery<T>[] {
		try {
			const { result } = this.core.dispatch({ kind: "take", limit }, this.options.now());
			if (result.kind !== "deliveries") throw new RealineError("invalid_frame");
			return result.items.map((item): TypedDelivery<T> => ({ kind: item.kind, cursor: item.cursor, data: this.options.decode(item.data) }));
		} catch (error) {
			this.failed(error);
			throw error instanceof RealineError ? error : new RealineError("invalid_frame");
		}
	}
	tick(): void {
		try {
			this.core.dispatch({ kind: "tick" }, this.options.now());
		} catch (error) {
			this.failed(error);
			throw error;
		}
	}
	disconnect(): void {
		this.terminate("disconnect");
	}
	revoke(): void {
		this.terminate("revoke");
	}
	dispose(): void {
		this.cleanup();
		this.queued_sync = null;
		this.core.dispose();
		this.notify();
	}
	view(): StreamView {
		return this.core.view();
	}

	private begin(request?: SyncRequest): Promise<void> {
		if (this.view().state === "disposed") return Promise.reject(new RealineError("disposed"));
		if (this.task) return Promise.reject(new RealineError("busy"));
		this.cleanup();
		if (!request) this.core.dispatch({ kind: "disconnect" }, 0);
		this.error = null;
		const controller = new AbortController();
		this.controller = controller;
		const task = Promise.resolve()
			.then((): Promise<void> => this.synchronize(controller, request))
			.finally((): void => {
				if (this.task === task) this.task = null;
				const queued = this.queued_sync;
				this.queued_sync = null;
				if (queued && !controller.signal.aborted)
					void this.begin(queued).catch((): void => {
						/* Error and fenced state are already exposed by synchronize. */
					});
			});
		this.task = task;
		void task.catch((): void => {
			/* Observe background rejection; connect/ready callers still receive this same rejection. */
		});
		return task;
	}

	private async synchronize(controller: AbortController, request?: SyncRequest): Promise<void> {
		try {
			if (!request) {
				const grant = await this.options.transport.authorize(this.view().scope, controller.signal);
				if (controller.signal.aborted) return;
				request = this.core.open(grant, this.options.now());
			}
			const stop = await this.options.transport.listen(
				request,
				{
					failed: (code): void => {
						if (!controller.signal.aborted) this.failed(new RealineError(code));
					},
					event: (frame): void => this.receive(frame, controller),
					disconnected: (): void => {
						if (!controller.signal.aborted) this.disconnect();
					},
					revoked: (): void => {
						if (!controller.signal.aborted) this.revoke();
					},
				},
				controller.signal,
			);
			if (controller.signal.aborted) {
				stop();
				return;
			}
			this.stop = stop;
			const snapshot = await this.options.transport.snapshot(request, controller.signal);
			if (controller.signal.aborted) return;
			const { result } = this.core.dispatch({ kind: "snapshot", snapshot: snapshot as Snapshot }, this.options.now());
			if (result.kind !== "receive") throw new RealineError("invalid_frame");
			if (result.received.kind === "resync") this.queued_sync = result.received.request;
			this.notify();
		} catch (error) {
			if (controller.signal.aborted) return;
			this.failed(error);
			throw error instanceof RealineError ? error : new RealineError("not_ready");
		}
	}

	private receive(frame: unknown, controller: AbortController): void {
		if (controller.signal.aborted) return;
		try {
			const { result } = this.core.dispatch({ kind: "event", event: frame as Event }, this.options.now());
			if (result.kind !== "receive") throw new RealineError("invalid_frame");
			if (result.received.kind === "resync") {
				if (this.task) this.queued_sync = result.received.request;
				else
					void this.begin(result.received.request).catch((): void => {
						/* synchronize reports failure without a detached rejection. */
					});
			}
			this.notify();
		} catch (error) {
			this.failed(error);
		}
	}

	private failed(error: unknown): void {
		this.error = error instanceof RealineError ? error.code : "transport";
		this.terminate(error instanceof RealineError && (error.code === "denied" || error.code === "expired") ? "revoke" : "disconnect");
	}
	private terminate(kind: "disconnect" | "revoke"): void {
		this.cleanup();
		this.queued_sync = null;
		if (this.view().state !== "disposed") this.core.dispatch({ kind }, 0);
		this.notify();
	}
	private cleanup(): void {
		this.controller?.abort();
		this.controller = null;
		const stop = this.stop;
		this.stop = null;
		if (stop) {
			try {
				stop();
			} catch {
				this.error = "transport";
			}
		}
	}
	private notify(): void {
		this.options.changed?.(this.view());
	}
}
