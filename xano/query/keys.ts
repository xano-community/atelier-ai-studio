// A person's own keys for the recipe API: their agent connections, made read and write. A key is shown once, when it's
// made, and never stored in the clear, so the route that makes one keeps request history off. Each key charges its
// owner's budget, with the key's name on Usage. Guests can't make one.
import { auth, c, cmp, col, fl, inp, input, query, ref, s, withFilters } from "@xano/sdk";
import { agent } from "../agent.js";
import { changed } from "../base/index.js";
import { rbac } from "../rbac.js";
import { user } from "../table/user.js";
import { studioGroup } from "./studio.js";

const conn = agent.agent_connection;
const KEY_FIELDS = ["id", "name", "scope", "revoked", "expires_at", "last_used_at", "created_at"] as const;
/** How long a new key lasts unless the person picks otherwise. */
export const KEY_DAYS = 90;

type Key = { id: number; name: string; scope: "read" | "read_write"; revoked: boolean; expires_at: number | null; last_used_at: number | null; created_at: number };

/** GET studio/keys: your own keys, newest first, with no token in sight. The sign-in row for chat apps isn't a key. */
export const listKeysRoute = query({
  apiGroup: studioGroup, auth: user,
  name: "keys", verb: "GET",
  description: "Your own API keys, newest first: name, scope, when each expires and was last used, and whether it's revoked.",
  stack: [
    ...rbac.require("studio.run", "Guests can't connect an agent or use the recipe API."),
    s.db.query({ table: conn, where: [cmp(col("user_id"), "=", auth("id")), cmp(col("kind"), "!=", c.text("sign-in"))], sort: [{ sortBy: "created_at", dir: "desc" }],
      paging: { per_page: 100, metadata: false }, output: [...KEY_FIELDS], as: "rows" }),
  ],
  response: ref("rows"),
  responseShape: [] as Key[],
});

/** POST studio/keys: a new read-and-write key with this name. The token is in this answer only. */
export const createKeyRoute = query({
  apiGroup: studioGroup, auth: user, history: false,
  name: "keys", verb: "POST",
  description: "Make a named key for the recipe API, for 1 to 90 days. The token is shown once, here.",
  input: { name: input.text({ required: true, methods: ["trim"] }), days: input.int() },
  stack: [
    ...rbac.require("studio.run", "Guests can't connect an agent or use the recipe API."),
    s.function.run({ fn: agent.connectFn, as: "made", input: { user_id: auth("id"), name: inp("name"), scope: c.text("read_write"), days: withFilters(inp("days"), fl.first_notempty(c.int(KEY_DAYS))) } }),
    changed({ entity: "key", id: ref("made.connection.id"), op: "created", privateTo: auth("id") }),
  ],
  response: { key: ref("made.connection"), token: ref("made.token") },
  responseShape: {} as { key: Key; token: string },
});

/** POST studio/keys/{id}/revoke: end one of your keys. Its next call is refused, and runs it started stop before spending more. */
export const revokeKeyRoute = query({
  apiGroup: studioGroup, auth: user,
  name: "keys/{id}/revoke", verb: "POST",
  description: "Revoke one of your keys. Its next call is refused; queued steps of runs it started stop before they're sent.",
  input: { id: input.int({ required: true }) },
  stack: [
    ...rbac.signedIn(),
    s.function.run({ fn: agent.revokeFn, as: "revoked", input: { user_id: auth("id"), id: inp("id") } }),
    changed({ entity: "key", id: inp("id"), op: "updated", privateTo: auth("id") }),
  ],
  response: { id: inp("id"), revoked: c.bool(true) },
  responseShape: {} as { id: number; revoked: boolean },
});

export const keyQueries = [listKeysRoute, createKeyRoute, revokeKeyRoute];
