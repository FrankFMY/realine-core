# Contributing

Keep lifecycle and ordering semantics in the owning Rust implementation. Keep TypeScript focused
on host orchestration, explicit ownership and the Wasm boundary. Add a focused failing regression
for a behavior change, including cancellation or revocation where relevant. Do not relax resource
limits to make a fixture pass.

Use the pinned toolchain and locked dependencies, then run the local checks in README.md. Changes
to Rust protocol types require `bun run protocol:generate` and an exact `protocol:check`. Public
API changes also need installed-artifact runtime and type checks. Keep examples generic and free
of credentials, service dependencies or application-specific policy. Preserve third-party notices
and check resolved versions when dependencies change.

Use clear English descriptions of the trigger, resulting behavior, validation and remaining
limits. Keep generated binaries, temporary projects and private verification receipts out of source
changes. This repository makes no promise of a hosted workflow or a reporting service. Contributions
are under the project's MIT OR Apache-2.0 terms unless explicitly agreed otherwise.
