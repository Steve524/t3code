# Fork changes

Every edit this fork makes to an upstream file (`FORK.md` rule 11). This is the
checklist for resolving conflicts after `git merge upstream/main`: keep
upstream's version, then re-apply each row.

Files that only exist in the fork (`FORK.md`, this file, anything under a
`fork/` directory, `docs/fork/`) are not listed.

## Touch points

| File                                                                | What changed                                                                                                                                                                             | Why                                                                                                                                                                                                        |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`                                                         | Fork notice at the top, pointing to `FORK.md`.                                                                                                                                           | Agents read `AGENTS.md` first and must load the fork rules.                                                                                                                                                |
| `packages/contracts/src/rpc.ts`                                     | Imports `ForkCrewsRpcs` and spreads it into `WsRpcGroup` as the last entry (`// FORK: crews rpc`).                                                                                       | Serves the `forkCrews.*` RPCs on the existing WebSocket, behind the same scope authorization.                                                                                                              |
| `packages/contracts/src/clientRpcPermissions.ts`                    | Imports `FORK_CREWS_GUARDED_RPC_SCOPES` and spreads it first into `CLIENT_GUARDED_RPC_SCOPES` (`// FORK: crews writes`).                                                                 | Crew settings writes need `settings:write` and crew run controls need `orchestration:operate`; clients check before sending.                                                                               |
| `apps/server/src/auth/RpcAuthorization.ts`                          | Imports `FORK_CREWS_READ_RPC_SCOPES` and spreads it into `RPC_REQUIRED_SCOPES` after the guarded scopes (`// FORK: crews reads`).                                                        | That map must name a scope for every RPC in `WsRpcGroup`, or the server fails to typecheck.                                                                                                                |
| `apps/server/src/observability/RpcInstrumentation.ts`               | Imports `FORK_CREWS_RPC_AGGREGATES` and spreads it first into `RPC_AGGREGATES` (`// FORK: crews rpc`).                                                                                   | The same exhaustiveness rule, for the `rpc.aggregate` span label.                                                                                                                                          |
| `apps/server/src/ws.ts`                                             | Imports `fork/crews/crewRpcHandlers.ts` and spreads its handlers first into the `ServerWsRpcGroup.of` map (`// FORK: crews rpc`).                                                        | Handles the `forkCrews.*` RPCs. Each handler calls one `CrewCatalog` or `CrewRunService` method.                                                                                                           |
| `apps/server/src/orchestration-v2/runtimeLayer.ts`                  | Imports `fork/layer.ts` and merges it last into `layerProduction` (`FORK-BEGIN` / `FORK-END`). The block provides it `layerThreadLaunchProvided` along with the services it already got. | Provides the fork services and runs fork migrations at startup. Crew runs launch threads. New fork services go in `fork/layer.ts`, not here.                                                               |
| `packages/client-runtime/src/rpc/client.ts`                         | Type-imports `ForkCrewsSubscriptionRpcTag` and adds it first in `EnvironmentSubscriptionRpcTag` (`// FORK: crews rpc`).                                                                  | That union decides which RPCs the client treats as streams. New crews streams extend the fork type, not this file.                                                                                         |
| `apps/server/src/mcp/McpHttpServer.ts`                              | Imports `fork/crews/mcp/handlers.ts` and adds `toolkitRegistration(ForkCrewMcp.CrewToolkit, ForkCrewMcp.layer)` last in the `layer` merge (`// FORK: crew tools`).                       | Serves the `crew_*` tools on the `t3-code` MCP endpoint every provider already receives. Only this file may register MCP tools.                                                                            |
| `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`      | Imports `CLAUDE_READ_ONLY_CREW_MCP_ALLOWED_TOOLS` and spreads it last into `CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS` (`// FORK: ...`).                                                     | A crew role in a read-only sandbox must still report. The constant lists only tools that touch crew state.                                                                                                 |
| `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts` | Imports `CrewToolkit` and adds its tools to the toolkits the read-only allowlist is checked against (`// FORK: crew tools`).                                                             | Upstream's test requires the allowlist to equal the read-only-annotated tools of the toolkits it names, so it has to name the crew toolkit.                                                                |
| `apps/server/src/mcp/toolkits/worktree/registration.test.ts`        | Imports `CrewRunService` and adds `Layer.mock(CrewRunService.CrewRunService)({})` to `layerStubServices` (`// FORK: crew tools`).                                                        | Upstream's test builds the whole MCP layer from stubs; the crew toolkit needs the run service like the other toolkits need theirs.                                                                         |
| `packages/provider-core/src/server/mcpSession.ts`                   | Type-imports `ExtraMcpServer` from `./fork/crewMcpServers.ts` and adds the optional `extraMcpServers` field to `McpProviderSessionConfig` (`// FORK: crew native MCP`).                  | Carries a crew role's MCP servers to the adapters. Sessions of other threads leave it unset.                                                                                                               |
| `apps/server/src/mcp/McpSessionRegistry.ts`                         | Imports `fork/crews/mcp/CrewNativeMcp.ts` and spreads `CrewNativeMcp.forThread(threadId)` last into the config `issue` returns (`// FORK: crew native MCP`).                             | Fills `extraMcpServers` for a crew card or lead thread, secrets resolved; every other thread gets nothing to spread.                                                                                       |
| `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`      | Imports `withExtraClaudeMcpServers` and spreads it last into the object `claudeMcpQueryOverrides` returns (`// FORK: crew native MCP`).                                                  | Adds the servers next to `t3-code` and pre-approves `mcp__<name>__*` outside a read-only sandbox. The helper calls `claudeMcpQueryOverrides` again without the extras, so `t3-code` is built in one place. |
| `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`       | Imports `codexExtraMcpServers` and spreads it into `mcp_servers` in `codexThreadRuntimeParams` (`// FORK: crew native MCP`).                                                             | Codex starts a crew role's servers itself.                                                                                                                                                                 |
| `packages/provider-cursor/src/server/adapter.ts`                    | Imports `cursorExtraMcpServers` and spreads it into the record `cursorMcpServers` returns (`// FORK: crew native MCP`).                                                                  | Cursor starts a crew role's servers itself. Servers with a secret never reach it (see below).                                                                                                              |
| `packages/provider-acp/src/server/adapter.ts`                       | Imports `acpExtraMcpServers` and spreads it after the `t3-code` bridge in the stdio `servers` of `acpMcpContext` (`// FORK: crew native MCP`).                                           | Grok and ACP registry agents start a crew role's servers over ACP. Antigravity shares this adapter but gets none: the delivery rule keeps its servers on the gateway.                                      |

`packages/contracts/src/fork/crews/crewRpc.test.ts` and
`apps/server/src/fork/crews/crewRpcScopes.test.ts` fail when one of the RPC rows above is lost in a
merge. `ClaudeAdapterV2.test.ts` fails when the allowlist spread is lost, and the server typecheck
fails when the MCP registration or the `layerThreadLaunchProvided` line is.

Crew run controls (retry, skip, force outcome, role model, route reset, budget answers) are actions
on `forkCrews.runs.control`, so they added no RPC. `crew_tool_list` joined the read-only allowlist
through the constant already spread into `ClaudeAdapterV2.ts`; `crew_tool_run` runs a command and
stays off it. Parallel work and git (worktrees, auto-commit, merge, script steps) touched no
upstream file and added no dependency: ownership globs use Node's `path.matchesGlob`.

MCP delivery (phase 8) added the six rows from `mcpSession.ts` down, each one import plus one
marked line, and no RPC or dependency. The adapters import their helper from
`packages/provider-core/src/server/fork/crewMcpServers.ts` by relative path, so no package export
was added. Which servers go native is decided in one place, `fork/crews/mcp/crewMcpDelivery.ts`,
which the prompt also reads: Codex, Claude, Grok and ACP registry agents get every server, Cursor
only servers without a `${secret:NAME}` value, every other provider none. Every role can also reach
its servers through the `crew_mcp_list_tools` and `crew_mcp_call` tools of the existing crew
toolkit. `fork/crews/mcp/nativeMcp.test.ts` fails when the Codex, Cursor or Claude line is lost;
the registry and ACP lines have no test that would catch their loss.

Lead mode (the kickoff turn, milestone updates, lead decisions) touched no upstream file and added
no RPC or dependency. `crew_decide` only records a decision, so it joined the read-only allowlist
through the same constant, which lets a read-only Claude lead answer. `ClaudeAdapterV2.test.ts`
checks that constant against the crew toolkit's read-only annotations, so the two cannot drift.

## Added dependencies

Dependencies added to upstream `package.json` files (`FORK.md` rule 8).

| Package file | Dependency | Why |
| ------------ | ---------- | --- |
|              |            |     |

## Crews settings touch points

| File                                                      | What changed                                                                                                                      | Why                                                                                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/settings/settingsSearch.ts`      | Imports fork settings registration; extends `SettingsPath`, section labels, search items, and category scope with marked entries. | Makes `/settings/crews` reachable through settings navigation and search at environment, project, and checkout scopes. |
| `apps/web/src/components/settings/SettingsSidebarNav.tsx` | Imports the fork icon and registers it for `/settings/crews`, both marked.                                                        | Gives the Crews settings entry an icon.                                                                                |
| `apps/web/src/routeTree.gen.ts`                           | Regenerated to register the new `routes/settings.crews.tsx` route.                                                                | TanStack Router owns this generated file. Regenerate it after a merge instead of adding manual fork markers.           |
| `packages/contracts/package.json`                         | Exports `fork/crews/crewFile`, `fork/crews/crewModel`, and `fork/crews/crewRpc`.                                                  | Web imports crew contracts through the package so its composite typecheck does not treat their source as web files.    |
| `packages/shared/package.json`                            | Exports `fork/crews/crewFileSchema`, `fork/crews/parseCrewYaml`, and `fork/crews/resolveRoleToolbox`.                             | Crew settings tests import shared fork logic through the package boundary.                                             |
| `packages/client-runtime/package.json`                    | Exports `fork/crews/catalog`.                                                                                                     | Crew settings import shared query atoms through the package boundary.                                                  |

The settings route renders only `apps/web/src/fork/crews/settings/` code. It uses
the existing crew catalog and guarded commands, with query atoms added to
`packages/client-runtime/src/fork/crews/catalog.ts`. Web and desktop share this
page; mobile UI is outside phase 9. No dependencies were added.
