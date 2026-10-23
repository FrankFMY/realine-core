import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// One local cache and deterministic compiler paths, including dependency panic strings.
const root = fileURLToPath(new URL("../", import.meta.url));
const flags = [`--remap-path-prefix=${homedir()}=/build`, `--remap-path-prefix=${root}=/realine-core/`];
const result = spawnSync("cargo", ["+1.94.0", ...process.argv.slice(2)], {
	cwd: process.cwd(),
	env: { ...process.env, CARGO_TARGET_DIR: `${root}target`, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f") },
	stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
