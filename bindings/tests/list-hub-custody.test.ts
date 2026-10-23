import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { init_realine, wasm_url } from "../src/index.js";
import { ListClient } from "../src/list-client.js";
import { ListHub } from "../src/list-hub.js";
import type { ListIntent, ListRead } from "../src/list-hub.js";
import type { Cursor, Grant, JsonValue } from "../src/protocol.js";

const scope = { product: "catalog", tenant: "fixture", resource: "rows", channel: "changes" };
const grant: Grant = { scope, actor_id: "reader", session_id: "session", permission_version: "v1", expires_at_ms: 10000 };
const intent: ListIntent = { scope, projection: "summary", filter: null, sort: [], limit: 3 };

const connect = async (hub: ListHub<string>, clients: ListClient<JsonValue>[]): Promise<ListClient<JsonValue>> => {
  const { request } = await hub.authorize("reader", intent);
  const client = new ListClient<JsonValue>({ request, transport: hub.transport("reader", request), now: () => 1, decode: value => value });
  clients.push(client);
  await client.connect();
  return client;
};

test("ListHub cached baseline owns a reused provider cursor", async () => {
  init_realine(await readFile(wasm_url));
  const cursor: Cursor = { epoch: "db", revision: "1" };
  let revision = 1;
  let reads = 0;
  const hub = new ListHub<string>({
    now: () => 1, max_groups: 1, max_subscribers: 4, max_refresh_rounds: 3,
    provider: {
      authorize: async () => ({ grant, access: "equivalent" }),
      read: async () => {
        reads++;
        return { cursor, rows: [{ id: "a", revision: String(revision), value: { version: revision } }], has_more: false };
      },
    },
  });
  const clients: ListClient<JsonValue>[] = [];
  try {
    const first = await connect(hub, clients);
    revision = 2;
    cursor.revision = "2";
    const second = await connect(hub, clients);
    expect(reads).toBe(1);
    expect(second.view().stream.cursor).toEqual({ epoch: "db", revision: "1" });
    expect(second.view().slots[0]?.row).toMatchObject({ id: "a", revision: "1", value: { version: 1 } });
    hub.invalidate();
    await hub.flush();
    expect(reads).toBe(2);
    for (const client of [first, second]) {
      expect(client.view().stream.state).toBe("live");
      expect(client.view().stream.cursor).toEqual({ epoch: "db", revision: "2" });
      expect(client.view().slots[0]?.row).toMatchObject({ id: "a", revision: "2", value: { version: 2 } });
    }
  } finally {
    for (const client of clients) client.dispose();
    hub.dispose();
    await hub.flush();
  }
});

test("ListHub snapshots read identity and row payloads before reauthorization callbacks", async () => {
  init_realine(await readFile(wasm_url));
  const value = { version: 1 };
  const result: ListRead = { cursor: { epoch: "db", revision: "1" }, rows: [{ id: "a", revision: "1", value }], has_more: false };
  let returned = false;
  let mutated = false;
  const hub = new ListHub<string>({
    now: () => 1, max_groups: 1, max_subscribers: 4, max_refresh_rounds: 3,
    provider: {
      authorize: async () => {
        if (returned && !mutated) {
          mutated = true;
          result.cursor.revision = "2";
          result.rows[0]!.revision = "2";
          value.version = 2;
          result.has_more = true;
        }
        return { grant, access: "equivalent" };
      },
      read: async () => { returned = true; return result; },
    },
  });
  const clients: ListClient<JsonValue>[] = [];
  try {
    const client = await connect(hub, clients);
    expect(mutated).toBe(true);
    expect(client.view().stream.state).toBe("live");
    expect(client.view().stream.cursor).toEqual({ epoch: "db", revision: "1" });
    expect(client.view().slots[0]?.row).toMatchObject({ id: "a", revision: "1", value: { version: 1 } });
    expect(client.view().next).toBeNull();
  } finally {
    for (const client of clients) client.dispose();
    hub.dispose();
    await hub.flush();
  }
});
