import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, statfsSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const stamp = new Date().toISOString().replaceAll(":", "-");
const work = join(root, ".qualification", `consumer-${stamp}`);
mkdirSync(work, { recursive: true });
const receipt = { started: stamp, commands: [], artifacts: {}, consumers: {}, work };
const receiptDir = process.argv[2] ? resolve(process.argv[2]) : work;
mkdirSync(receiptDir, { recursive: true });
const receiptPath = join(receiptDir, `consumers-${stamp}.json`);
const save = () => writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
const run = (label, command, args, cwd = root, expected = 0) => {
	const disk = statfsSync(root);
	const free = disk.bavail * disk.bsize;
	if (free < 10 * 1024 ** 3) throw new Error(`DISK_STOP: ${free} bytes free before ${label}`);
	const start = performance.now();
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
		env: { ...process.env, CARGO_TARGET_DIR: join(root, "target") },
	});
	const log = join(receiptDir, `${stamp}-${label}.log`);
	writeFileSync(log, `$ ${[command, ...args].join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}`, { flag: "wx" });
	receipt.commands.push({
		label,
		command: [command, ...args],
		cwd,
		exit: result.status,
		expected,
		wall_ms: performance.now() - start,
		log,
	});
	save();
	console.log(label, `exit=${result.status}`, `log=${log}`);
	if (result.error) throw result.error;
	if (result.status !== expected) throw new Error(`${label} failed: ${(result.stderr ?? result.stdout).slice(-3500)}`);
	return result.stdout;
};
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const parse = (text) => JSON.parse(text.trim().split("\n").at(-1));
const original = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
try {
	run("build", "bun", ["--no-env-file", "run", "build"]);
	run("pack", "bun", ["--no-env-file", "pm", "pack", "--destination", work], join(root, "bindings"));
	const tgz = join(
		work,
		readdirSync(work).find((f) => f.endsWith(".tgz")),
	);
	assert(existsSync(tgz));
	// Regenerate this owned output from an empty file, including when a file list shrinks.
	rmSync(join(root, "target/package/realine-core-0.1.0.crate"), { force: true });
	run("crate", "node", ["scripts/cargo.mjs", "package", "--locked", "--allow-dirty"]);
	const crate = join(root, "target/package/realine-core-0.1.0.crate");
	assert(existsSync(crate));
	cpSync(crate, join(work, "realine-core-0.1.0.crate"));
	receipt.artifacts = { tarball: { path: tgz, sha256: sha(tgz) }, crate: { path: crate, sha256: sha(crate) } };
	save();
	const project = join(work, "project");
	mkdirSync(project);
	writeFileSync(join(project, ".realine-owned"), "owned synthetic consumer\n");
	mkdirSync(join(project, "patches"));
	cpSync(join(root, "patches/bun-types@1.4.2.patch"), join(project, "patches/bun-types@1.4.2.patch"));
	writeFileSync(
		join(project, "package.json"),
		JSON.stringify(
			{
				name: "realine-external-consumer",
				private: true,
				type: "module",
				dependencies: { "@frankfmy/realine-core": `file:../${tgz.split("/").at(-1)}` },
				devDependencies: {
					typescript: original.devDependencies.typescript,
					"@types/node": original.devDependencies["@types/node"],
					"@types/bun": original.devDependencies["@types/bun"],
				},
				patchedDependencies: original.patchedDependencies,
			},
			null,
			2,
		),
	);
	run("consumer-install", "bun", ["--no-env-file", "install", "--ignore-scripts"], project);
	const installed = join(project, "node_modules/@frankfmy/realine-core");
	assert(realpathSync(installed).startsWith(realpathSync(project) + "/"), "consumer resolved back to workspace source");
	const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
	assert.equal(manifest.private, true);
	assert.equal(manifest.sideEffects, false);
	assert.equal(manifest.license, "MIT OR Apache-2.0");
	assert.deepEqual(Object.keys(manifest.exports), [".", "./protocol", "./lists", "./wasm", "./window"]);
	for (const dir of ["dist", "generated/wasm"]) {
		const visit = (relative) => {
			for (const entry of readdirSync(join(installed, relative), { withFileTypes: true })) {
				const p = join(relative, entry.name);
				if (entry.isDirectory()) visit(p);
				else assert.equal(sha(join(installed, p)), sha(join(root, "bindings", p)), `installed artifact differs: ${p}`);
			}
		};
		visit(dir);
	}
	receipt.installed = { path: installed, realpath: realpathSync(installed), release_bytes_match: true };
	save();
	const sources = join(project, "src");
	mkdirSync(sources);
	for (const f of readdirSync(join(root, "consumers"))) if (f.endsWith(".ts")) cpSync(join(root, "consumers", f), join(sources, f));
	for (const f of ["scenarios.json", "list-scenarios.json"]) cpSync(join(root, "consumers", f), join(project, f));
	writeFileSync(
		join(project, "tsconfig.json"),
		JSON.stringify(
			{
				compilerOptions: {
					target: "ES2023",
					module: "NodeNext",
					moduleResolution: "NodeNext",
					lib: ["ES2023", "DOM"],
					types: ["node", "bun"],
					strict: true,
					noUncheckedIndexedAccess: true,
					skipLibCheck: false,
					outDir: "out",
					rootDir: "src",
				},
				include: ["src/**/*.ts"],
				exclude: ["src/negative.ts"],
			},
			null,
			2,
		),
	);
	run("consumer-types", "node", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], project);
	const negative = run(
		"consumer-negative-types",
		"node",
		[
			"node_modules/typescript/bin/tsc",
			"--noEmit",
			"--ignoreConfig",
			"--strict",
			"--target",
			"ES2023",
			"--module",
			"NodeNext",
			"--types",
			"node",
			"src/negative.ts",
		],
		project,
		1,
	);
	assert(negative.includes("TS2322") && negative.includes("TS2307"));
	assert((negative.match(/error TS/g) ?? []).length >= 9, "negative types did not reject all invalid declarations");
	writeFileSync(
		join(project, "entry.mjs"),
		`import {readFile} from 'node:fs/promises';
import {wasm_url} from '@frankfmy/realine-core';
import {run_consumer} from './out/consumer.js';
import {run_qualification} from './out/qualification.js';
import {run_cold} from './out/cold.js';
const asset=import.meta.resolve('@frankfmy/realine-core/wasm');
if(asset!==wasm_url.href)throw new Error('wasm export mismatch');
if(process.argv[2])console.log(JSON.stringify(await run_cold(process.argv[2],()=>readFile(wasm_url))));
else{
 const scenarios=JSON.parse(await readFile('scenarios.json','utf8'));
 const lists=JSON.parse(await readFile('list-scenarios.json','utf8'));
 const output=await run_consumer(await readFile(wasm_url),scenarios,lists);
 console.log(JSON.stringify({...output,qualification:await run_qualification()}));
}
`,
	);
	const kinds = ["stream", "presence", "subscription", "list", "plan", "client", "window", "hub", "presence-host"];
	for (const runtime of ["node", "bun"]) {
		const cold = [];
		for (const kind of kinds)
			cold.push(
				parse(run(`${runtime}-cold-${kind}`, runtime, [...(runtime === "bun" ? ["--no-env-file"] : []), "entry.mjs", kind], project)),
			);
		receipt.consumers[runtime] = {
			cold,
			full: parse(run(`${runtime}-release`, runtime, [...(runtime === "bun" ? ["--no-env-file"] : []), "entry.mjs"], project)),
		};
		save();
	}
	receipt.consumers.bun.storage_and_sql = parse(run("bun-original-sql-and-storage", "bun", ["--no-env-file", "out/bun.js"], project));
	save();
	const unpack = join(work, "crate");
	mkdirSync(unpack);
	run("crate-unpack", "tar", ["-xzf", crate, "-C", unpack]);
	const native = join(work, "native");
	mkdirSync(join(native, "src"), { recursive: true });
	cpSync(join(root, "consumers/native.rs"), join(native, "src/main.rs"));
	cpSync(join(root, "consumers/lists.rs"), join(native, "src/lists.rs"));
	writeFileSync(
		join(native, "Cargo.toml"),
		'[package]\nname="realine-independent-consumer"\nversion="0.0.0"\nedition="2024"\npublish=false\n[dependencies]\nrealine-core={path="../crate/realine-core-0.1.0"}\nserde_json="=1.0.154"\n[profile.dev]\ndebug=0\nincremental=false\n',
	);
	cpSync(join(root, "Cargo.lock"), join(native, "Cargo.lock"));
	run("consumer-native-lock", "node", [join(root, "scripts/cargo.mjs"), "generate-lockfile", "--offline"], native);
	const storage = join(native, "storage");
	mkdirSync(storage);
	writeFileSync(join(storage, ".realine-owned"), "owned\n");
	receipt.consumers.native = parse(
		run(
			"consumer-native",
			"node",
			[join(root, "scripts/cargo.mjs"), "run", "--locked", "--offline", "--quiet", "--", join(project, "scenarios.json"), storage],
			native,
		),
	);
	save();
	const maps = Object.fromEntries(
		Object.entries(manifest.exports).map(([name, value]) => [
			"@frankfmy/realine-core" + (name === "." ? "" : name.slice(1)),
			"/node_modules/@frankfmy/realine-core/" + (typeof value === "string" ? value : value.import).slice(2),
		]),
	);
	writeFileSync(
		join(project, "index.html"),
		`<!doctype html><meta charset="utf-8"><title>Realine external consumer</title><script type="importmap">${JSON.stringify({ imports: maps })}</script><script type="module" src="/browser.mjs"></script>`,
	);
	writeFileSync(
		join(project, "browser.mjs"),
		`import {init_realine,wasm_url} from '@frankfmy/realine-core';
import {run_consumer} from './out/consumer.js';
import {run_qualification} from './out/qualification.js';
import {run_cold} from './out/cold.js';
const bytes=async()=>{const r=await fetch(wasm_url);if(!r.ok)throw new Error('Wasm HTTP '+r.status);return r.arrayBuffer();};
try{
 if(import.meta.resolve('@frankfmy/realine-core/wasm')!==wasm_url.href)throw new Error('wasm export mismatch');
 const kind=new URL(location.href).searchParams.get('cold');
 if(kind)window.result=await run_cold(kind,bytes);
 else{
  init_realine(await bytes());
  const s=await(await fetch('/scenarios.json')).json(), l=await(await fetch('/list-scenarios.json')).json();
  window.result={...await run_consumer(await bytes(),s,l),qualification:await run_qualification()};
 }
}catch(error){window.failure=String(error.stack??error);}
`,
	);
	const server = createServer((request, response) => {
		try {
			const file = resolve(project, "." + new URL(request.url, "http://localhost").pathname.replace(/\/$/, "/index.html"));
			if (!file.startsWith(project + "/") || !statSync(file).isFile()) throw new Error("not found");
			response.setHeader(
				"Content-Type",
				{
					".html": "text/html",
					".js": "text/javascript",
					".mjs": "text/javascript",
					".json": "application/json",
					".wasm": "application/wasm",
				}[extname(file)] ?? "application/octet-stream",
			);
			response.end(readFileSync(file));
		} catch {
			response.statusCode = 404;
			response.end();
		}
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	const url = `http://127.0.0.1:${server.address().port}/`;
	process.env.PLAYWRIGHT_BROWSERS_PATH = join(root, ".qualification/browsers");
	const { chromium, webkit } = await import("@playwright/test");
	try {
		for (const [name, type] of [
			["chromium", chromium],
			["webkit", webkit],
		]) {
			const browser = await type.launch({ headless: true });
			try {
				const outputs = { version: browser.version(), cold: [], full: null };
				for (const kind of [...kinds, null]) {
					const context = await browser.newContext();
					const page = await context.newPage();
					const errors = [];
					page.on("pageerror", (error) => errors.push(String(error)));
					await page.goto(url + (kind ? `?cold=${kind}` : ""));
					await page.waitForFunction(() => window.result || window.failure, {}, { timeout: 60000 });
					const state = await page.evaluate(() => ({ result: window.result, failure: window.failure }));
					assert.equal(state.failure, undefined, `${name} ${kind}: ${state.failure}`);
					assert.deepEqual(errors, []);
					if (kind) outputs.cold.push(state.result);
					else outputs.full = state.result;
					await context.close();
				}
				receipt.consumers[name] = outputs;
				save();
				console.log(`${name} real browser cold/full gates passed`);
			} finally {
				await browser.close();
			}
		}
	} finally {
		await new Promise((done) => server.close(done));
	}
	for (const runtime of ["node", "bun", "chromium", "webkit"]) {
		for (const key of ["stream", "presence", "lists"])
			assert.deepEqual(receipt.consumers[runtime].full[key], receipt.consumers.native[key], `${runtime} ${key} differs from native crate`);
		assert.deepEqual(
			receipt.consumers[runtime].full.qualification,
			receipt.consumers.node.full.qualification,
			`${runtime} generic qualification differs`,
		);
	}
	receipt.status = "passed";
	receipt.trace_parity = ["native", "node", "bun", "chromium", "webkit"];
	save();
	console.log("EXTERNAL_CONSUMERS_PASS", receiptPath);
} catch (error) {
	receipt.status = "failed";
	receipt.error = String(error.stack ?? error);
	save();
	throw error;
}
