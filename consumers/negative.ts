import type { Grant, PresenceSignal, Scope } from "@frankfmy/realine-core";
import type { ListRow, ListSort } from "@frankfmy/realine-core/lists";

const invalid_scope: Scope = { product: "dispatch", tenant: 42, resource: "fleet", channel: "changes" };
const invalid_grant: Grant = { scope: invalid_scope, actor_id: "operator", session_id: 42, permission_version: "1", expires_at_ms: 10000 };
const invalid_signal: PresenceSignal = "administrator";
const invalid_sort: ListSort = { field: "name", direction: "sideways", missing: "last" };
const invalid_row: ListRow = { id: "a", revision: 1, value: { amount: 1n } };
void [invalid_grant, invalid_signal, invalid_sort, invalid_row];

import type { Cursor } from "@frankfmy/realine-core/protocol";
import { RevisionedWindow } from "@frankfmy/realine-core/window";
import { to_json } from "@frankfmy/realine-core/dist/wire.js";
const invalid_cursor: Cursor = { epoch: "one", revision: 1 };
new RevisionedWindow(invalid_scope, 42).update(invalid_cursor, []);
void to_json;
