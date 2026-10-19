# Fork changes

Every edit this fork makes to an upstream file (`FORK.md` rule 11). This is the
checklist for resolving conflicts after `git merge upstream/main`: keep
upstream's version, then re-apply each row.

Files that only exist in the fork (`FORK.md`, this file, anything under a
`fork/` directory, `docs/fork/`) are not listed.

## Touch points

| File                                                                | What changed                                                                                                                                                                           | Why                                                                                                                                                                                  |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AGENTS.md`                                                         | Fork notice at the top, pointing to `FORK.md`.                                                                                                                                         | Agents read `AGENTS.md` first and must load the fork rules.                                                                                                                          |
| `packages/contracts/src/rpc.ts`                                     | Imports `ForkCrewsRpcs` and spreads it into `WsRpcGroup` as the last entry (`// FORK: crews rpc`).                                                                                     | Serves the `forkCrews.*` RPCs on the existing WebSocket, behind the same scope authorization.                                                                                        |
| `packages/contracts/src/clientRpcPermissions.ts`                    | Imports `FORK_CREWS_GUARDED_RPC_SCOPES` and spreads it first into `CLIENT_GUARDED_RPC_SCOPES` (`// FORK: crews writes`).                                                               | Crew settings writes need `settings:write`; clients check before sending.                                                                                                            |
| `apps/server/src/auth/RpcAuthorization.ts`                          | Imports `FORK_CREWS_READ_RPC_SCOPES` and spreads it into `RPC_REQUIRED_SCOPES` after the guarded scopes (`// FORK: crews reads`).                                                      | That map must name a scope for every RPC in `WsRpcGroup`, or the server fails to typecheck.                                                                                          |
| `apps/server/src/observability/RpcInstrumentation.ts`               | Imports `FORK_CREWS_RPC_AGGREGATES` and spreads it first into `RPC_AGGREGATES` (`// FORK: crews rpc`).                                                                                 | The same exhaustiveness rule, for the `rpc.aggregate` span label.                                                                                                                    |
| `apps/server/src/ws.ts`                                             | Imports `fork/crews/crewRpcHandlers.ts`, omits its methods from upstream handler inference, merges its handler layer, and rejoins its group at `RpcServer.make` (marked).              | Keeps upstream and fork handler inference below TypeScript's depth limit while sharing the WebSocket, authorization, and instrumentation. Steve approved option (a) before phase 10. |
| `apps/server/src/orchestration-v2/runtimeLayer.ts`                  | Imports `fork/layer.ts` and merges it last into `layerProduction` (`FORK-BEGIN` / `FORK-END`). The block provides the services used by the catalog's orchestration capabilities query. | Provides the crew catalog and settings store and runs fork migrations at startup. New fork services go in `fork/layer.ts`, not here.                                                 |
| `packages/client-runtime/src/rpc/client.ts`                         | Type-imports `ForkCrewsSubscriptionRpcTag` and adds it first in `EnvironmentSubscriptionRpcTag` (`// FORK: crews rpc`).                                                                | That union decides which RPCs the client treats as streams. New crews streams extend the fork type, not this file.                                                                   |
| `apps/server/src/mcp/McpHttpServer.ts`                              | Imports `fork/crews/mcp/handlers.ts` and adds `toolkitRegistration(ForkCrewMcp.CrewToolkit, ForkCrewMcp.layer)` last in the `layer` merge (`// FORK: crew tools`).                     | Serves the five init tools and two disabled gateway tools on the existing `t3-code` MCP endpoint. Only this file may register MCP tools.                                             |
| `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`      | Imports `CLAUDE_READ_ONLY_CREW_MCP_ALLOWED_TOOLS` and spreads it last into `CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS` (`// FORK: ...`).                                                   | A read-only Claude thread can still use the five `/crew-init` tools. Gateway tools stay off the allowlist.                                                                           |
| `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts` | Imports `CrewToolkit` and adds its tools to the toolkits the read-only allowlist is checked against (`// FORK: crew tools`).                                                           | Upstream's test requires the allowlist to equal the read-only-annotated tools of the toolkits it names, so it has to name the crew toolkit.                                          |
| `apps/server/src/mcp/toolkits/worktree/registration.test.ts`        | Imports `CrewCatalog` and adds `Layer.mock(CrewCatalog.CrewCatalog)({})` to `layerStubServices` (`// FORK: crew tools`).                                                               | Upstream's test builds the whole MCP layer from stubs; the crew init toolkit needs the catalog like the other toolkits need their services.                                          |

`packages/contracts/src/fork/crews/crewRpc.test.ts` and
`apps/server/src/fork/crews/crewRpcScopes.test.ts` fail when one of the RPC rows above is lost in a
merge. `ClaudeAdapterV2.test.ts` fails when the allowlist spread is lost, and the server typecheck
fails when MCP registration or runtime service wiring is lost.

Phase 1 of Crews v2 removes the run engine, run RPCs and client exports, ten old
`crew_*` tools, and all six native MCP injection touch points. The five init tools
use `CrewCatalog` directly. `crew_mcp_list_tools` and `crew_mcp_call` remain registered
but refuse access until the gate supplies role grants. Migration 002 stays in history;
phase 3 will drop its tables. Crew starts are disabled in the shared web/desktop composer.

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

| File                                                           | What changed                                                                                                                                                                                                 | Why                                                                                                                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/components/chat/ChatComposer.tsx`                | Replaces the model-picker import with the fork wrapper and hook; uses the hook's composer props, adds the crew footer block, adjusts hidden-block thresholds, and supplies the compact control (all marked). | Shows the selector only for new drafts with installed crews, explains the fallback model, disables multi-model selection and selected-crew sends, and collapses the control with its neighbours. |
| `apps/web/src/components/chat/CompactComposerControlsMenu.tsx` | Adds an optional `crewControl` prop and renders it in the popup, both marked.                                                                                                                                | Keeps the same selector accessible when the footer collapses.                                                                                                                                    |
| `apps/web/src/components/ChatView.tsx`                         | Imports and calls the fork send hook at component scope, then adds a marked early return before ordinary send handling.                                                                                      | Blocks selected crews while starts are disabled and expands `/crew-init`. Ordinary sends keep their existing path.                                                                               |

Steve approved the extra marked wiring within the same three composer files on 2026-10-14:
React hooks must run at component scope, and validation, model fallback and compact state need
props. Feature logic stays under `fork/`; `CrewRoleCard.tsx` is unchanged. Web and desktop share
the composer. Mobile skips crew selection and crew sends in this phase. Only catalog/settings RPCs and client exports remain; settings mutations use the existing catalog commands.

The server split above replaces the old handler spread. The shared contract and client RPC
wiring stay combined; only handler inference needed splitting. The fork handler tests check
the merged method set and exercise ordinary and crew requests, streams and authorization.

## Retired Crews right-panel touch points

| File                                   | What changed                                                                                                                                    | Why                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/web/src/rightPanelStore.ts`      | Imports `fork/crews/retiredCrewBoard.ts`, filters its retired tab kind during migration, and bumps storage version to 15. All additions marked. | Removes saved Crew tabs while preserving other tabs and selecting a survivor. |
| `apps/web/src/closedViewStore.ts`      | Bumps storage version to 3, marked, so the upstream validator reruns without the removed Crew tab case.                                         | Discards retired Crew tabs from saved closed-tab history.                     |
| `apps/web/src/closedViewStore.test.ts` | Uses the store's configured version in the existing hydration assertion, marked.                                                                | Keeps the upstream persistence test valid after the fork migration.           |

The board pages, routes, banner, composer chip, sidebar badge/filter and palette
contribution are removed. `Sidebar.tsx`, `Sidebar.logic.ts`, `CommandPalette.tsx`,
`CommandPalette.logic.ts` and `RightPanelTabs.tsx` now match `upstream/main` exactly,
so they need no touch-point rows. `ChatView.tsx` retains only the composer send wiring
listed above. `routeTree.gen.ts` was regenerated; its settings route row still applies.
Retired-tab cleanup tests live in `fork/crews/retiredCrewBoard.test.ts`. Crew secret
confirmation moved to `fork/crews/settings/CrewConfirm.tsx`.
Web and desktop share the removal; mobile UI is unchanged. No RPC, dependency, or
package export changed.

## Crews `/crew-init` touch points

| File                                            | What changed                                                                                                                                                | Why                                                                                                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/chat/ChatComposer.tsx` | Pushes `crewComposer.crewInitCommands(selectedProvider)` into the visible provider slash commands (marked). The React Compiler now handles caching.         | The slash menu offers `/crew-init` and one `/crew-init <crew>` entry per installed crew, through the hook the composer already calls.                    |
| `apps/web/src/components/ChatView.tsx`          | Calls `crewSend.blocksCommand(sendCtx, activeThread.id)` in the marked send block.                                                                          | A typed `/crew-init` is sent as its short skill instruction, or refused with the reason where it cannot run.                                             |
| `packages/contracts/src/settings.ts`            | Imports the fork crew secret schemas and adds `forkCrewSecrets` last to `ServerSettings` and to `ServerSettingsPatch` (all marked).                         | Crew secrets ride the existing settings RPC, settings file and client redaction instead of a new RPC.                                                    |
| `packages/shared/src/serverSettings.ts`         | Takes `forkCrewSecrets` out of the patch before the deep merge and merges it per entry with the file's `mergeSettingsEntries` (marked line and FORK block). | `null` removes one secret; a deep merge would keep it.                                                                                                   |
| `apps/server/src/settingsSecrets.ts`            | Imports `mapForkCrewSecrets` and spreads it last into the object `mapSettingsSecrets` returns (marked).                                                     | Upstream's settings pipeline then stores each value in the secret store as `crew-NAME`, removes it when its entry goes, and sends clients only a marker. |

Steve chose the settings route for crew secrets and the fork-only disabled state for
`/crew-init` on 2026-10-14. The composer menu has no disabled items, so on a provider that
can't reach T3 tools the entry shows that reason as its description and a send is refused
with it. The five `t3_*` MCP tools use the existing crew toolkit and read-only constant
already spread into `ClaudeAdapterV2.ts`. They reach `CrewCatalog` directly, which
the MCP registration test stubs. Settings, Crews has a Crew secrets section using upstream `SecretInput`; the
Repo toolbox section, its empty state and the composer crew popover open a new draft with
`/crew-init`. Web and desktop share this; mobile neither lists nor expands `/crew-init`. No
RPC, dependency or package export was added. `CrewRoleCard.tsx` is unchanged.
