/**
 * CrewNativeMcp - the MCP servers a crew role's own provider starts, next to `t3-code`.
 * `McpSessionRegistry` spreads `forThread` into every session config it issues. A thread that
 * works for no crew run gets nothing, so nothing changes for it.
 *
 * @module CrewNativeMcp
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import type { ExtraMcpServer } from "../../../../../../packages/provider-core/src/server/fork/crewMcpServers.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import { makeCrewRunStore } from "../CrewRunStore.ts";
import { readCrewSecret } from "./CrewMcpGateway.ts";
import { crewMcpDelivery, resolveCrewMcpEnv } from "./crewMcpDelivery.ts";

type Lookup = (threadId: ThreadId) => Effect.Effect<ReadonlyArray<ExtraMcpServer>>;

// Set while the fork layer runs, the way the registry itself is reached by provider sessions.
let active: Lookup | undefined;

/** `extraMcpServers` for a crew thread's session config, or nothing to spread. */
export const forThread = (
  threadId: ThreadId,
): Effect.Effect<{ readonly extraMcpServers?: ReadonlyArray<ExtraMcpServer> }> =>
  active === undefined
    ? Effect.succeed({})
    : Effect.map(active(threadId), (servers) =>
        servers.length === 0 ? {} : { extraMcpServers: servers },
      );

const make = Effect.gen(function* () {
  const store = makeCrewRunStore(yield* SqlClient.SqlClient);
  const readSecret = readCrewSecret(yield* ServerSecretStore.ServerSecretStore);

  const lookup: Lookup = (threadId) =>
    Effect.gen(function* () {
      const entry = yield* store.findThread(threadId);
      const run = entry === null ? null : yield* store.getRun(entry.runId);
      if (entry === null || run === null) return [];
      // The card the thread works for, or the lead in its home thread between its own steps.
      const roleId =
        run.snapshot.cards.find((card) => card.id === entry.cardId)?.roleId ??
        (run.homeThreadId === threadId ? run.snapshot.lead?.roleId : undefined);
      if (roleId === undefined || roleId === null) return [];
      const driver = run.roles[roleId]?.driver ?? null;
      const servers: Array<ExtraMcpServer> = [];
      for (const server of run.toolboxes[roleId]?.mcp ?? []) {
        if (crewMcpDelivery(driver, server) !== "native") continue;
        const resolved = yield* resolveCrewMcpEnv(server, readSecret);
        // Left out; through the gateway the role is told which secret is missing.
        if ("missing" in resolved) {
          yield* Effect.logWarning("crew MCP server left out: a secret is not set", {
            server: server.name,
            secret: resolved.missing,
          });
          continue;
        }
        servers.push({
          name: server.name,
          command: server.command,
          args: server.args,
          env: resolved.env,
        });
      }
      return servers;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("crew MCP servers could not be read", cause).pipe(Effect.as([])),
      ),
    );

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      active = lookup;
    }),
    () =>
      Effect.sync(() => {
        if (active === lookup) active = undefined;
      }),
  );
});

export const layer = Layer.effectDiscard(make);
