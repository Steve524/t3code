# Fork changes

Every edit this fork makes to an upstream file (`FORK.md` rule 11). This is the
checklist for resolving conflicts after `git merge upstream/main`: keep
upstream's version, then re-apply each row.

Files that only exist in the fork (`FORK.md`, this file, anything under a
`fork/` directory, `docs/fork/`) are not listed.

## Touch points

| File                                                  | What changed                                                                                                                      | Why                                                                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `AGENTS.md`                                           | Fork notice at the top, pointing to `FORK.md`.                                                                                    | Agents read `AGENTS.md` first and must load the fork rules.                                                        |
| `packages/contracts/src/rpc.ts`                       | Imports `ForkCrewsRpcs` and spreads it into `WsRpcGroup` as the last entry (`// FORK: crews rpc`).                                | Serves the `forkCrews.*` RPCs on the existing WebSocket, behind the same scope authorization.                      |
| `packages/contracts/src/clientRpcPermissions.ts`      | Imports `FORK_CREWS_GUARDED_RPC_SCOPES` and spreads it first into `CLIENT_GUARDED_RPC_SCOPES` (`// FORK: crews writes`).          | Crew writes need `settings:write`, and clients check it before sending.                                            |
| `apps/server/src/auth/RpcAuthorization.ts`            | Imports `FORK_CREWS_READ_RPC_SCOPES` and spreads it into `RPC_REQUIRED_SCOPES` after the guarded scopes (`// FORK: crews reads`). | That map must name a scope for every RPC in `WsRpcGroup`, or the server fails to typecheck.                        |
| `apps/server/src/observability/RpcInstrumentation.ts` | Imports `FORK_CREWS_RPC_AGGREGATES` and spreads it first into `RPC_AGGREGATES` (`// FORK: crews rpc`).                            | The same exhaustiveness rule, for the `rpc.aggregate` span label.                                                  |
| `apps/server/src/ws.ts`                               | Imports `fork/crews/crewRpcHandlers.ts` and spreads its handlers first into the `ServerWsRpcGroup.of` map (`// FORK: crews rpc`). | Handles the `forkCrews.*` RPCs. Each handler calls one `CrewCatalog` method.                                       |
| `apps/server/src/orchestration-v2/runtimeLayer.ts`    | Imports `fork/layer.ts` and merges it last into `layerProduction` (`FORK-BEGIN` / `FORK-END`).                                    | Provides the fork services and runs fork migrations at startup. New fork services go in `fork/layer.ts`, not here. |
| `packages/client-runtime/src/rpc/client.ts`           | Type-imports `ForkCrewsSubscriptionRpcTag` and adds it first in `EnvironmentSubscriptionRpcTag` (`// FORK: crews rpc`).           | That union decides which RPCs the client treats as streams. New crews streams extend the fork type, not this file. |

`packages/contracts/src/fork/crews/crewRpc.test.ts` and
`apps/server/src/fork/crews/crewRpcScopes.test.ts` fail when one of the RPC rows above is lost in a
merge.

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

The settings route renders only `apps/web/src/fork/crews/settings/` code. It uses
the existing crew catalog and guarded commands, with query atoms added to
`packages/client-runtime/src/fork/crews/catalog.ts`. Web and desktop share this
page; mobile UI is outside phase 9. No dependencies were added.
