/**
 * How a crew role reaches each MCP server in its frozen toolbox, and how `${secret:NAME}`
 * references in a server's env are filled in. The prompt and the session config both ask
 * `crewMcpDelivery`, so a role is told to use a server the way it actually gets it.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { CrewRunToolbox } from "../../../../../../packages/contracts/src/fork/crews/crewRun.ts";
import type { ExtraMcpServer } from "../../../../../../packages/provider-core/src/server/fork/crewMcpServers.ts";

export type CrewMcpServer = CrewRunToolbox["mcp"][number];

/** `${secret:NAME}` in an env value. The name is also a store file name, so it stays plain. */
const SECRET_REFERENCE = /\$\{secret:([\w-]+)\}/gu;

/** Drivers whose adapter starts a session's extra MCP servers with env values off every argv. */
const NATIVE_DRIVERS: ReadonlySet<string> = new Set([
  "codex",
  "claudeAgent",
  "grok",
  "acpRegistry",
]);

const secretNames = (value: string) =>
  [...value.matchAll(SECRET_REFERENCE)].flatMap((match) => (match[1] ? [match[1]] : []));

/** Native when the role's adapter starts the server itself; through `crew_mcp_call` otherwise. */
export function crewMcpDelivery(
  driver: string | null,
  server: CrewMcpServer,
): "native" | "gateway" {
  // The Cursor SDK may hand its config to a process it starts; that was not verified, so a
  // server with a secret reaches Cursor through the gateway only.
  if (driver === "cursor") {
    return Object.values(server.env).some((value) => secretNames(value).length > 0)
      ? "gateway"
      : "native";
  }
  return driver !== null && NATIVE_DRIVERS.has(driver) ? "native" : "gateway";
}

/**
 * The server's env with every secret read through `read`, or the name of the first secret
 * that is not set. Values are read when a server starts, never stored with the run.
 */
export const resolveCrewMcpEnv = Effect.fnUntraced(function* <E, R>(
  server: CrewMcpServer,
  read: (name: string) => Effect.Effect<Option.Option<string>, E, R>,
) {
  const env: Array<ExtraMcpServer["env"][number]> = [];
  for (const [name, value] of Object.entries(server.env)) {
    const secrets = new Map<string, string>();
    for (const secretName of secretNames(value)) {
      const secret = yield* read(secretName);
      if (Option.isNone(secret)) return { missing: secretName } as const;
      secrets.set(secretName, secret.value);
    }
    env.push({
      name,
      // A function replacement, so `$&` in a secret is not read as a pattern.
      value: value.replace(
        SECRET_REFERENCE,
        (match, secretName: string) => secrets.get(secretName) ?? match,
      ),
      secret: secrets.size > 0,
    });
  }
  return { env } as const;
});
