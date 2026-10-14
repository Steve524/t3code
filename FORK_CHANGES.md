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
| `apps/server/src/ws.ts`                                             | Imports `fork/crews/crewRpcHandlers.ts`, omits its methods from upstream handler inference, merges its handler layer, and rejoins its group at `RpcServer.make` (marked).                | Keeps upstream and fork handler inference below TypeScript's depth limit while sharing the WebSocket, authorization, and instrumentation. Steve approved option (a) before phase 10.                       |
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

## Crews composer touch points

| File                                                           | What changed                                                                                                                                                                                                 | Why                                                                                                                                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/chat/ChatComposer.tsx`                | Replaces the model-picker import with the fork wrapper and hook; uses the hook's composer props, adds the crew footer block, adjusts hidden-block thresholds, and supplies the compact control (all marked). | Shows the selector only for new drafts with installed crews, explains the fallback model, disables multi-model selection and sends with missing crew inputs, and collapses the control with its neighbours. |
| `apps/web/src/components/chat/CompactComposerControlsMenu.tsx` | Adds an optional `crewControl` prop and renders it in the popup, both marked.                                                                                                                                | Keeps the same selector accessible when the footer collapses.                                                                                                                                               |
| `apps/web/src/components/ChatView.tsx`                         | Imports and calls the fork send hook at component scope, then adds a marked early return before ordinary send handling.                                                                                      | Starts selected crews with the existing run RPC and opens the home thread. Ordinary sends take their existing path without an extra async yield.                                                            |
| `packages/client-runtime/package.json`                         | Exports `fork/crews/runs` and `fork/crews/commands` beside the existing catalog export.                                                                                                                      | Exposes shared run queries, streams and guarded start/control commands to the web composer.                                                                                                                 |
| `packages/contracts/package.json`                              | Exports `fork/crews/crewRun` beside the existing fork exports.                                                                                                                                               | Keeps run input types inside the package boundary for the web typecheck.                                                                                                                                    |

Steve approved the extra marked wiring within the same three composer files on 2026-10-14:
React hooks must run at component scope, and validation, model fallback and compact state need
props. Feature logic stays under `fork/`; `CrewRoleCard.tsx` is unchanged. Web and desktop share
the composer. Mobile skips crew selection and crew sends in this phase. No RPC or dependency
was added; settings mutations still use the phase 3 catalog commands.

The server split above replaces the old handler spread. The shared contract and client RPC
wiring stay combined; only handler inference needed splitting. The fork handler tests check
the merged method set and exercise ordinary and crew requests, streams and authorization.

## Crews board touch points

| File                                              | What changed                                                                                                                                                                       | Why                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/components/ChatView.tsx`            | Imports and calls the fork banner hook, spreads its items into the existing banner list, and includes them in the memo dependencies. All additions marked.                         | Home and role threads show crew counts, gate answers, and a board link.                                      |
| `apps/web/src/components/Sidebar.logic.ts`        | Accepts an optional fork card-thread predicate and applies it alongside the existing filters, marked.                                                                              | Hides crew role threads while preserving the home thread and ordinary sidebar rules.                         |
| `apps/web/src/components/Sidebar.tsx`             | Imports the fork sidebar hook and badge, calls the hook, passes its predicate to the filter with a memo dependency, and renders the badge in the thread row. All additions marked. | The sidebar responds to the crew index and the fork-local preference without per-thread board subscriptions. |
| `apps/web/src/components/CommandPalette.logic.ts` | Accepts optional crew entries and spreads them into the action list, marked.                                                                                                       | Registers Crew settings, Crew runs, and the current thread's board.                                          |
| `apps/web/src/components/CommandPalette.tsx`      | Imports and calls the fork palette hook, then passes its entries to the action builder, marked.                                                                                    | Supplies the active thread and router context that the logic module does not own.                            |
| `apps/web/src/routeTree.gen.ts`                   | Regenerated for the runs list and full-page board route shims.                                                                                                                     | Regenerate after merging upstream; this generated file has no manual fork markers.                           |

Steve approved the additional hook calls, filter argument and memo dependencies on 2026-10-14.
The new route files only register fork components. All board, banner, model controls, sidebar
preference and palette logic lives under `fork/`. Web and desktop share it; mobile UI is skipped.
`CrewRoleCard.tsx` is unchanged. No dependency or RPC was added.

The existing run reads now include optional display fields from the saved run: brief, historical
send-back count, script exit, merge details, budget extensions, and role thread ids. Frozen
toolboxes still arrive only through `runs.get`. The board's Stop action uses `stopCard` on the
existing guarded `runs.control`; it waits for the thread's stop acknowledgement before Retry is
available. The source of a decision no longer duplicates its decision card's needs-you count.
The sidebar refreshes lightweight run lists on thread creation and the shared minute tick.
No right-panel surface, gate notifications or board keybinding was added in this phase.

## Crews right-panel touch points

| File                                         | What changed                                                                                                                    | Why                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/rightPanelStore.ts`            | Imports the fork surface descriptor/type and registers its kind, union member and singleton factory case. All additions marked. | Gives the crew board the existing per-environment/thread tab ordering, persistence and close/reopen behavior. |
| `apps/web/src/components/RightPanelTabs.tsx` | Adds a marked icon import and label/icon cases for `crew-board`.                                                                | Displays the board in the existing draggable tab strip.                                                       |
| `apps/web/src/components/ChatView.tsx`       | Imports and renders the fork panel component as the content fallback, both marked.                                              | Both inline and sheet layouts render the board beside the home thread.                                        |
| `apps/web/src/closedViewStore.ts`            | Adds a marked `crew-board` case to the singleton validation.                                                                    | Keeps closed board tabs available when saved tab history migrates.                                            |

Phase 12 reuses `CrewBoard` for the panel and full page. Navigation from the banner,
composer chip, palette and full-page board lives under `fork/` and opens beside the
run's home thread. Panel lookup uses that thread's existing crew stream. Frozen
toolbox reads no longer subscribe to a second stream or refresh on every card update.
Web and desktop share this code; mobile UI is skipped. No RPC, dependency or package export
was added. `CrewRoleCard.tsx` is unchanged.

Steve approved the additional `ChatView.tsx` and `closedViewStore.ts` wiring on
2026-10-14. The planned `RightPanelSheet.tsx` is only a wrapper and needs no edit.
