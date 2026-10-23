import type { BindingReply, ErrorCode } from "./protocol.js";

export class RealineError extends Error {
	readonly code: ErrorCode;
	constructor(code: ErrorCode) {
		super(`realine: ${code}`);
		this.name = "RealineError";
		this.code = code;
	}
}

export const unpack = <T>(raw: string): T => {
	const reply = JSON.parse(raw) as BindingReply<T>;
	if (reply.status === "error") throw new RealineError(reply.code);
	return reply.value;
};

export const to_json = (value: unknown): string => {
	try {
		const text = JSON.stringify(value, (_key, item: unknown): unknown => {
			if (
				item === undefined ||
				typeof item === "function" ||
				typeof item === "symbol" ||
				typeof item === "bigint" ||
				(typeof item === "number" && !Number.isFinite(item))
			)
				throw new RealineError("invalid_frame");
			return item;
		});
		if (text === undefined || text.length > 1_056_768) throw new RealineError("invalid_frame");
		return text;
	} catch {
		throw new RealineError("invalid_frame");
	}
};

export const construct = <T>(create: () => T): T => {
	try {
		return create();
	} catch (error) {
		if (error instanceof RealineError) throw error;
		if (typeof error === "string") {
			try {
				unpack<never>(error);
			} catch (error) {
				if (error instanceof RealineError) throw error;
			}
		}
		throw new RealineError("not_ready");
	}
};
