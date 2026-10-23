/* oxlint-disable eslint/no-await-in-loop, unicorn/no-useless-spread -- Snapshot finite membership before callbacks; serialize dependent authorization/read rounds without unbounded fan-out. */
import { default_list_config, ListCore, ListPlan } from "./list-core.js";
import type {
	Cursor,
	Grant,
	JsonValue,
	ListConfig,
	ListDeparture,
	ListPage,
	ListQuery,
	ListRequest,
	ListRow,
	PageCursor,
	Snapshot,
	SyncRequest,
} from "./protocol.js";
import type { StreamListener, StreamTransport } from "./subscription.js";
import { RealineError, to_json } from "./wire.js";

export type ListIntent = Omit<ListQuery, "access">;
export interface ListAuthorization {
	grant: Grant;
	access: string;
}
export interface ListRead {
	cursor: Cursor;
	rows: ListRow[];
	has_more: boolean;
	departures?: ListDeparture[];
}
export interface ListReadContext {
	grant: Grant;
	request: ListRequest;
	previous: { cursor: Cursor; records: { id: string; revision: string }[] } | null;
}
export interface ListProvider<C> {
	authorize(context: C, intent: ListIntent, signal: AbortSignal): Promise<ListAuthorization>;
	read(context: C, authorization: ListReadContext, signal: AbortSignal): Promise<ListRead>;
}
export interface ListHubOptions<C> {
	provider: ListProvider<C>;
	now(): number;
	config?: ListConfig;
	max_groups: number;
	max_subscribers: number;
	max_refresh_rounds: number;
}
interface Member<C> {
	context: C;
	grant: Grant;
	sync: SyncRequest;
	listener: StreamListener;
	closed: boolean;
}
interface Group<C> {
	request: ListRequest;
	plan: ListPlan;
	members: Set<Member<C>>;
	controller: AbortController;
	task: Promise<void> | null;
	result: { cursor: Cursor; page: ListPage } | null;
	alive: boolean;
	dirty: boolean;
}
export class ListHub<C> {
	private readonly options: ListHubOptions<C>;
	private readonly config: ListConfig;
	private readonly groups = new Map<string, Group<C>>();
	private readonly in_flight = new Set<Group<C>>();
	private closed = false;
	private readonly authorizations = new Set<AbortController>();
	get authorizing(): number {
		return this.authorizations.size;
	}
	stats(): { groups: number; subscribers: number; reading: number } {
		return { groups: this.groups.size, subscribers: [...this.groups.values()].reduce((n, g) => n + g.members.size, 0), reading: this.in_flight.size };
	}
	dispose(): void {
		this.closed = true;
		for (const controller of this.authorizations) controller.abort();
		for (const group of [...this.groups.values()]) for (const member of [...group.members]) this.close_member(group, member, false);
	}
	invalidate(matches: (request: ListRequest) => boolean = (): boolean => true): void {
		for (const group of this.groups.values()) if (matches(JSON.parse(to_json(group.request)) as ListRequest)) this.schedule(group);
	}
	async flush(): Promise<void> {
		while (this.in_flight.size > 0) await Promise.all([...this.in_flight].map((group) => group.task));
	}
	constructor(options: ListHubOptions<C>) {
		for (const [value, max] of [
			[options.max_groups, 1024],
			[options.max_subscribers, 10000],
			[options.max_refresh_rounds, 64],
		] as const)
			if (!Number.isInteger(value) || value < 1 || value > max) throw new RealineError("invalid_config");
		this.options = { ...options };
		this.config = JSON.parse(to_json(options.config ?? default_list_config)) as ListConfig;
	}
	async authorize(
		context: C,
		intent: ListIntent,
		after: PageCursor | null = null,
		signal: AbortSignal = new AbortController().signal,
	): Promise<{ grant: Grant; request: ListRequest }> {
		if (this.closed) throw new RealineError("disposed");
		if (signal.aborted) throw new RealineError("not_ready");
		if (this.authorizations.size >= this.options.max_subscribers) throw new RealineError("busy");
		const { scope, projection, filter, sort, limit } = JSON.parse(to_json(intent)) as ListIntent;
		const query = { scope, projection, filter, sort, limit };
		const controller = new AbortController();
		const abort = (): void => controller.abort();
		signal.addEventListener("abort", abort, { once: true });
		this.authorizations.add(controller);
		try {
			const authorization = await this.options.provider.authorize(context, query, controller.signal);
			if (this.closed) throw new RealineError("disposed");
			if (controller.signal.aborted) throw new RealineError("not_ready");
			const { grant, access } = JSON.parse(to_json(authorization)) as ListAuthorization;
			const request: ListRequest = { query: { ...query, access }, after: JSON.parse(to_json(after)) as PageCursor | null };
			const core = new ListCore(request, this.config);
			try {
				core.open(grant, this.options.now());
			} finally {
				core.dispose();
			}
			return { grant, request };
		} finally {
			signal.removeEventListener("abort", abort);
			this.authorizations.delete(controller);
		}
	}
	transport(context: C, input: ListRequest): StreamTransport {
		const request = JSON.parse(to_json(input)) as ListRequest;
		let grant: Grant;
		let active: { group: Group<C>; member: Member<C> } | null = null;
		return {
			authorize: async (_scope, signal): Promise<Grant> => {
				const authorization = await this.authorize(context, request.query, request.after, signal);
				if (authorization.request.query.access !== request.query.access) throw new RealineError("denied");
				grant = authorization.grant;
				return grant;
			},
			listen: (sync, listener, signal): Promise<() => void> => {
				if (this.closed) throw new RealineError("disposed");
				if (!grant || signal.aborted) throw new RealineError("denied");
				if (this.stats().subscribers >= this.options.max_subscribers || (active && !active.member.closed)) throw new RealineError("busy");
				const scope = request.query.scope;
				if (
					sync.session_id !== grant.session_id ||
					sync.permission_version !== grant.permission_version ||
					sync.scope.product !== scope.product ||
					sync.scope.tenant !== scope.tenant ||
					sync.scope.resource !== scope.resource ||
					sync.scope.channel !== scope.channel ||
					!Number.isInteger(sync.generation) ||
					sync.generation < 1 ||
					sync.generation > 4294967295
				)
					throw new RealineError("invalid_frame");
				const plan = new ListPlan(request, this.config);
				let group = this.groups.get(plan.key);
				if (group) plan.dispose();
				else {
					if (new Set([...this.groups.values(), ...this.in_flight]).size >= this.options.max_groups) {
						plan.dispose();
						throw new RealineError("busy");
					}
					group = { request, plan, members: new Set(), controller: new AbortController(), task: null, result: null, alive: true, dirty: false };
					this.groups.set(plan.key, group);
				}
				const member: Member<C> = { context, grant: structuredClone(grant), sync: JSON.parse(to_json(sync)) as SyncRequest, listener, closed: false };
				group.members.add(member);
				active = { group, member };
				const close = (): void => {
					this.remove(group, member);
					signal.removeEventListener("abort", close);
				};
				signal.addEventListener("abort", close, { once: true });
				if (signal.aborted) close();
				return Promise.resolve(close);
			},
			snapshot: async (sync, signal): Promise<Snapshot> => {
				if (!active || active.member.closed || signal.aborted) throw new RealineError("not_ready");
				const { group, member } = active;
				if (!group.result && !group.task) {
					this.schedule(group);
				}
				if (group.task) await group.task;
				await this.current(group, member, signal);
				if (!group.alive || member.closed || signal.aborted || !group.result) throw new RealineError("not_ready");
				return { scope: sync.scope, generation: sync.generation, ...group.result.cursor, data: JSON.parse(to_json(group.result.page)) as JsonValue };
			},
		};
	}
	private async current(group: Group<C>, member: Member<C>, signal: AbortSignal): Promise<void> {
		const authorization = await this.authorize(member.context, group.request.query, group.request.after, signal);
		const expected = member.grant;
		const actual = authorization.grant;
		if (
			authorization.request.query.access !== group.request.query.access ||
			actual.actor_id !== expected.actor_id ||
			actual.session_id !== expected.session_id ||
			actual.permission_version !== expected.permission_version ||
			expected.expires_at_ms <= this.options.now()
		)
			throw new RealineError("denied");
	}
	private schedule(group: Group<C>): void {
		if (!group.alive) return;
		group.dirty = true;
		if (group.task) return;
		group.task = Promise.resolve()
			.then(async (): Promise<void> => {
				let rounds = 0;
				while (group.alive && group.dirty) {
					if (rounds++ >= this.options.max_refresh_rounds) throw new RealineError("busy");
					group.dirty = false;
					await this.read_group(group);
				}
			})
			.catch((error: unknown): never => {
				for (const member of [...group.members])
					this.close_member(
						group,
						member,
						error instanceof RealineError && (error.code === "denied" || error.code === "expired"),
						error instanceof RealineError ? error.code : "not_ready",
					);
				throw error instanceof RealineError ? error : new RealineError("not_ready");
			})
			.finally((): void => {
				group.task = null;
				this.in_flight.delete(group);
				if (group.alive && group.dirty) this.schedule(group);
			});
		this.in_flight.add(group);
		void group.task.catch((): void => {
			/* The same rejection remains observable by snapshot/flush. */
		});
	}
	private close_member(group: Group<C>, member: Member<C>, denied: boolean, code: import("./protocol.js").ErrorCode | null = null): void {
		this.remove(group, member);
		try {
			if (code && member.listener.failed) member.listener.failed(code);
			else if (denied) member.listener.revoked();
			else member.listener.disconnected();
		} catch {
			/* A failing transport cannot keep a subscription alive. */
		}
	}
	private async read_group(group: Group<C>): Promise<void> {
		for (const member of [...group.members]) {
			try {
				await this.current(group, member, group.controller.signal);
			} catch (error) {
				this.close_member(group, member, error instanceof RealineError && (error.code === "denied" || error.code === "expired"));
			}
		}
		const member = group.members.values().next().value;
		if (!member || !group.alive) return;
		const received = await this.options.provider.read(
			member.context,
			{
				grant: structuredClone(member.grant),
				request: JSON.parse(to_json(group.request)) as ListRequest,
				previous: group.result
					? { cursor: { ...group.result.cursor }, records: group.result.page.rows.map(({ id, revision }) => ({ id, revision })) }
					: null,
			},
			group.controller.signal,
		);
		if (!group.alive || group.controller.signal.aborted) return;
		// Own the admitted wire values before reauthorization can await or reenter.
		const { cursor, rows, has_more, departures } = received;
		const result: ListRead = {
			cursor: JSON.parse(to_json(cursor)) as Cursor,
			rows: JSON.parse(to_json(rows)) as ListRow[],
			has_more,
		};
		if (departures !== undefined) result.departures = JSON.parse(to_json(departures)) as ListDeparture[];
		for (const current of [...group.members]) {
			try {
				await this.current(group, current, group.controller.signal);
			} catch (error) {
				this.close_member(group, current, error instanceof RealineError && (error.code === "denied" || error.code === "expired"));
			}
		}
		if (!group.alive) return;
		const page = group.plan.page(result.cursor, result.rows, result.has_more);
		const before = group.result;
		const advance = before ? group.plan.advance(before.cursor, result.cursor) : null;
		if (advance === "epoch") {
			for (const member of [...group.members]) this.close_member(group, member, false);
			return;
		}
		if (advance === "same") {
			if (to_json(page) !== to_json(before!.page)) throw new RealineError("invalid_revision");
			return;
		}
		const patch = before ? group.plan.diff(result.cursor, before.page, page, result.departures ?? []) : null;
		group.result = { cursor: result.cursor, page };
		if (!before || !patch) return;
		for (const member of [...group.members]) {
			try {
				await this.current(group, member, group.controller.signal);
				if (!group.alive || member.closed) continue;
				member.listener.event({
					scope: member.sync.scope,
					generation: member.sync.generation,
					epoch: result.cursor.epoch,
					previous: before.cursor.revision,
					revision: result.cursor.revision,
					data: JSON.parse(to_json(patch)) as JsonValue,
				});
			} catch (error) {
				this.close_member(group, member, error instanceof RealineError && (error.code === "denied" || error.code === "expired"));
			}
		}
	}
	private remove(group: Group<C>, member: Member<C>): void {
		member.closed = true;
		group.members.delete(member);
		if (group.members.size === 0 && group.alive) {
			group.alive = false;
			this.groups.delete(group.plan.key);
			group.controller.abort();
			group.result = null;
			group.plan.dispose();
		}
	}
}
