/**
 * Stdio MCP servers a session gets next to `t3-code`: a crew role's servers, which the server
 * fills into `McpProviderSessionConfig.extraMcpServers`. Each adapter that can start them spreads
 * one of these into the place it already puts `t3-code`; the others ignore the field.
 *
 * Values are resolved already. Only servers whose values stay off every command line for that
 * adapter are put here; the rest are reached through the crew's MCP gateway.
 */

export interface ExtraMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** `secret` marks a value read from the secret store, which must never be logged. */
  readonly env: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
    readonly secret: boolean;
  }>;
}

type Session = { readonly extraMcpServers?: ReadonlyArray<ExtraMcpServer> } | undefined;

const servers = (session: Session) => session?.extraMcpServers ?? [];
const envRecord = (server: ExtraMcpServer) =>
  Object.fromEntries(server.env.map(({ name, value }) => [name, value]));

/** Codex `mcp_servers` entries. Codex receives them in the app-server request, not argv. */
export const codexExtraMcpServers = (session: Session) =>
  Object.fromEntries(
    servers(session).map((server) => [
      server.name,
      { command: server.command, args: server.args, env: envRecord(server) },
    ]),
  );

/** Cursor SDK `mcpServers` entries. */
export const cursorExtraMcpServers = (session: Session) =>
  Object.fromEntries(
    servers(session).map((server) => [
      server.name,
      {
        type: "stdio" as const,
        command: server.command,
        args: [...server.args],
        env: envRecord(server),
      },
    ]),
  );

/** ACP `mcpServers` stdio entries, sent over the ACP channel. */
export const acpExtraMcpServers = (session: Session) =>
  servers(session).map((server) => ({
    name: server.name,
    command: server.command,
    args: [...server.args],
    env: server.env.map(({ name, value }) => ({ name, value })),
  }));

/**
 * Claude's MCP overrides with the extra servers added and, outside a read-only sandbox,
 * pre-approved. `overrides` is the function that builds them without the extras: the result
 * is spread over its own return, so its `t3-code` entry is computed in one place. Claude's
 * query runner sends `mcpServers` over the CLI's stdin, so env values never reach argv.
 */
export function withExtraClaudeMcpServers<
  I extends { readonly mcpSession: Session; readonly readOnlySandbox: boolean },
  S,
>(
  input: I,
  overrides: (input: I) => {
    readonly allowedTools?: ReadonlyArray<string>;
    readonly mcpServers?: Readonly<Record<string, S>> | undefined;
  },
) {
  const extras = servers(input.mcpSession);
  if (extras.length === 0) return {};
  const base = overrides({ ...input, mcpSession: { ...input.mcpSession, extraMcpServers: [] } });
  return {
    allowedTools: [
      ...(base.allowedTools ?? []),
      ...(input.readOnlySandbox ? [] : extras.map((server) => `mcp__${server.name}__*`)),
    ],
    mcpServers: {
      ...base.mcpServers,
      ...Object.fromEntries(
        extras.map((server) => [
          server.name,
          {
            type: "stdio" as const,
            command: server.command,
            args: [...server.args],
            env: envRecord(server),
          },
        ]),
      ),
    },
  };
}
