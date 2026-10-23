import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { init_realine, wasm_url } from "../src/index.js";
import { RevisionedWindow } from "../src/window.js";

init_realine(await readFile(wasm_url));
const scope = { product: "catalog", tenant: "one", resource: "records", channel: "list" };
const row = (id: string, revision: string, name: string) => ({ id, revision, value: { name } });

test("globally retained rows crossing native parts keep their current payload and dirty focus before adoption", () => {
	const window = new RevisionedWindow(scope, "public");
	const rows = Array.from({ length: 275 }, (_, i) => row(`r${i}`, "1", `Record ${i}`));
	try {
		window.update({ epoch: "one", revision: "1" }, rows);
		window.interaction({ focus: "r249", selection: ["r249"], dirty: ["r249"], anchor: { id: "r249", offset_px: 20 } });
		const next = [...rows];
		[next[249], next[250]] = [next[250]!, next[249]!];
		window.update({ epoch: "one", revision: "2" }, next);
		const view = window.view();
		expect(view.slots.map((slot) => slot.id)).toEqual(rows.map((entry) => entry.id));
		expect(view.slots.find((slot) => slot.id === "r249")).toMatchObject({ row: rows[249], departure: null, conflict: false, moved: true });
		expect(view.slots.every((slot) => slot.row !== null)).toBe(true);
		expect(view.custody).toEqual({ focus: "r249", selection: ["r249"], dirty: ["r249"], anchor: { id: "r249", offset_px: 20 } });
		expect(() => window.accept()).toThrow("busy");
		window.interaction({ focus: "r249", selection: ["r249"], dirty: [], anchor: { id: "r249", offset_px: 20 } });
		window.accept();
		expect(window.view().slots.map((slot) => slot.row?.id)).toEqual(next.map((entry) => entry.id));
	} finally {
		window.stop();
	}
});

test("browser subpixel scroll anchors are converted to the native integer pixel contract", () => {
	const window = new RevisionedWindow(scope, "public");
	try {
		window.update({ epoch: "one", revision: "1" }, [row("a", "1", "First")]);
		window.interaction({ focus: "a", selection: ["a"], dirty: [], anchor: { id: "a", offset_px: 12.5 } });
		expect(window.view().custody.anchor).toEqual({ id: "a", offset_px: 13 });
		for (const offset of [-2147483648, 2147483647]) {
			window.interaction({ focus: "a", selection: ["a"], dirty: [], anchor: { id: "a", offset_px: offset } });
			expect(window.view().custody.anchor?.offset_px).toBe(offset);
		}
	} finally {
		window.stop();
	}
});

test("a long loaded register uses bounded native windows without truncating records", () => {
	const window = new RevisionedWindow(scope, "public");
	const original = Array.from({ length: 1001 }, (_, index) => row(`record-${index}`, "1", `Name ${index}`));
	const reordered = [original.at(-1)!, ...original.slice(0, -1)];
	try {
		window.update({ epoch: "one", revision: "1" }, original);
		expect(window.view().slots.map((slot) => slot.id)).toEqual(original.map((entry) => entry.id));
		window.update({ epoch: "one", revision: "2" }, reordered);
		expect(window.view().pending).toBe(true);
		expect(window.view().slots.map((slot) => slot.id)).toEqual(original.map((entry) => entry.id));
		window.accept();
		expect(window.view().slots.map((slot) => slot.row?.id)).toEqual(reordered.map((entry) => entry.id));
	} finally {
		window.stop();
	}
});

test("admitted domain values larger than a realine payload remain intact without entering the ordering engine", () => {
	const window = new RevisionedWindow(scope, "public");
	const text = "large-value".repeat(40_000);
	try {
		window.update({ epoch: "one", revision: "1" }, [row("a", "1", text)]);
		expect(window.view().slots[0]!.row!.value).toEqual({ name: text });
		window.suspend();
		expect(window.view().slots.every((slot) => slot.row === null)).toBe(true);
	} finally {
		window.stop();
	}
});

test("generic window updates values in place and defers structural movement until explicit adoption", () => {
	const window = new RevisionedWindow(scope, "public");
	try {
		window.update({ epoch: "one", revision: "1" }, [row("a", "1", "First"), row("b", "1", "Second")]);
		expect(window.view().slots.map((slot) => slot.id)).toEqual(["a", "b"]);
		window.update({ epoch: "one", revision: "3" }, [row("b", "2", "Changed"), row("c", "1", "Inserted")]);
		expect(window.view().slots.map((slot) => slot.id)).toEqual(["a", "b"]);
		expect(window.view().slots[0]).toMatchObject({ id: "a", row: null, departure: "window_exit" });
		expect(window.view().slots[1]!.row!.value).toEqual({ name: "Changed" });
		expect(window.view().pending).toBe(true);
		window.accept();
		expect(window.view().slots.map((slot) => slot.id)).toEqual(["b", "c"]);
	} finally {
		window.stop();
	}
});

test("adoption is atomic when dirty custody belongs to a later native part", () => {
	const window = new RevisionedWindow(scope, "public");
	const rows = Array.from({ length: 501 }, (_, i) => row(`r${i}`, "1", `Record ${i}`));
	try {
		window.update({ epoch: "one", revision: "1" }, rows);
		window.interaction({ focus: "r500", selection: [], dirty: ["r500"], anchor: null });
		window.update({ epoch: "one", revision: "2" }, [...rows].reverse());
		const before = window.view();
		expect(() => window.accept()).toThrow("busy");
		expect(window.view()).toEqual(before);
	} finally {
		window.stop();
	}
});

test.each([275, 501, 1001])("global membership survives swaps, front insert, reversal and part growth/shrink for %i rows", (count) => {
	const window = new RevisionedWindow(scope, "public");
	let rows = Array.from({ length: count }, (_, i) => row(`r${i}`, "1", `Record ${i}`));
	let revision = 1;
	try {
		window.update({ epoch: "one", revision: String(revision) }, rows);
		const changes = [
			(before: typeof rows): typeof rows => {
				const next = [...before];
				for (let edge = 250; edge < next.length; edge += 250) [next[edge - 1], next[edge]] = [next[edge]!, next[edge - 1]!];
				return next;
			},
			(before: typeof rows): typeof rows => [row("front", "1", "New front"), ...before],
			(before: typeof rows): typeof rows => [...before].reverse().map((entry) => row(entry.id, "2", `Current ${entry.id}`)),
			(before: typeof rows): typeof rows => [...before, ...Array.from({ length: 501 }, (_, i) => row(`added${i}`, "1", `Added ${i}`))],
			(before: typeof rows): typeof rows => before.slice(0, 249),
		];
		for (const change of changes) {
			const next = change(rows);
			const current = new Map(next.map((entry) => [entry.id, entry]));
			window.update({ epoch: "one", revision: String(++revision) }, next);
			const deferred = window.view();
			expect(deferred.slots.map((slot) => slot.id)).toEqual(rows.map((entry) => entry.id));
			for (const slot of deferred.slots) {
				expect(slot.row).toEqual(current.get(slot.id) ?? null);
				expect(slot.departure === null).toBe(current.has(slot.id));
			}
			expect(deferred.pending_order).toEqual(next.map((entry) => entry.id));
			window.accept();
			const adopted = window.view();
			expect(adopted.slots.map((slot) => slot.row)).toEqual(next);
			expect(new Set(adopted.slots.map((slot) => slot.id)).size).toBe(next.length);
			rows = next;
		}
		window.suspend();
		expect(window.view().slots.every((slot) => slot.row === null)).toBe(true);
	} finally {
		window.stop();
	}
});

test.each([275, 751])("cross-part adoption retains focus, selection and anchor for %i rows", (count) => {
	const window = new RevisionedWindow(scope, "public");
	const rows = Array.from({ length: count }, (_, i) => row(`r${i}`, "1", `Record ${i}`));
	try {
		window.update({ epoch: "one", revision: "1" }, rows);
		const custody = { focus: "r249", selection: ["r249", "r250"], dirty: [], anchor: { id: "r249", offset_px: -12 } };
		window.interaction(custody);
		const next = [...rows];
		[next[249], next[250]] = [row("r250", "2", "Current 250"), row("r249", "2", "Current 249")];
		window.update({ epoch: "one", revision: "2" }, next);
		expect(window.view().pending_order).toEqual(next.map((r) => r.id));
		expect(window.view().slots[249]?.row).toEqual(next[250]);
		window.accept();
		expect(window.view().custody).toEqual(custody);
		expect(window.view().slots.map((s) => s.row)).toEqual(next);
	} finally {
		window.stop();
	}
});

test("duplicate identities in different partitions and a malformed later partition reject without partial changes", () => {
	const window = new RevisionedWindow(scope, "public");
	const rows = Array.from({ length: 751 }, (_, i) => row(`r${i}`, "1", `Record ${i}`));
	try {
		window.update({ epoch: "one", revision: "1" }, rows);
		const before = window.view();
		const duplicate = [...rows];
		duplicate[500] = duplicate[0]!;
		expect(() => window.update({ epoch: "one", revision: "2" }, duplicate)).toThrow("invalid_frame");
		expect(window.view()).toEqual(before);
		const bad = [...rows];
		bad[0] = row("r0", "2", "New");
		bad[500] = row("bad", "01", "Invalid revision");
		expect(() => window.update({ epoch: "one", revision: "2" }, bad)).toThrow("invalid_revision");
		expect(window.view()).toEqual(before);
	} finally {
		window.stop();
	}
});

test("same cursor changed payload, exposed-view mutation and cross-part record regression cannot replace accepted values", () => {
	const window = new RevisionedWindow(scope, "public");
	const rows = Array.from({ length: 751 }, (_, i) => row(`r${i}`, "2", `Record ${i}`));
	try {
		window.update({ epoch: "one", revision: "10" }, rows);
		const mutated = window.view();
		(mutated.slots[0]!.row!.value as { name: string }).name = "Changed outside";
		expect(window.view().slots[0]?.row?.value).toEqual({ name: "Record 0" });
		const changed = [...rows];
		changed[500] = row("r500", "2", "Different value");
		expect(() => window.update({ epoch: "one", revision: "10" }, changed)).toThrow("invalid_revision");
		const regressed = [...rows];
		[regressed[249], regressed[500]] = [row("r500", "1", "Older"), rows[249]!];
		expect(() => window.update({ epoch: "one", revision: "11" }, regressed)).toThrow("invalid_revision");
		expect(window.view().slots.map((s) => s.row)).toEqual(rows);
	} finally {
		window.stop();
	}
});

test("epoch changes complete the native recovery generation and revoke permits only explicit new admission", () => {
	const window = new RevisionedWindow(scope, "public");
	try {
		window.update({ epoch: "one", revision: "10" }, [row("a", "5", "Old")]);
		window.interaction({ focus: "a", selection: ["a"], dirty: [], anchor: { id: "a", offset_px: 12 } });
		window.suspend();
		expect(window.view().slots[0]?.row).toBeNull();
		window.update({ epoch: "two", revision: "0" }, [row("a", "1", "New epoch")]);
		expect(window.view().stream.state).toBe("live");
		expect(window.view().stream.cursor).toEqual({ epoch: "two", revision: "0" });
		expect(window.view().slots[0]?.row?.value).toEqual({ name: "New epoch" });
		expect(window.view().custody.focus).toBe("a");
		window.revoke();
		expect(window.view().stream.state).toBe("revoked");
		expect(window.view().slots).toEqual([]);
		window.update({ epoch: "three", revision: "0" }, [row("b", "1", "Reauthorized")]);
		expect(window.view().slots[0]?.id).toBe("b");
	} finally { window.stop(); window.revoke(); window.stop(); }
	expect(() => window.update({ epoch: "four", revision: "0" }, [])).toThrow("disposed");
});
