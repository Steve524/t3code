/**
 * Every fork service the server runtime provides. `runtimeLayer.ts` merges this
 * one layer, so a new fork service is added here and not in upstream.
 */
import * as Layer from "effect/Layer";

import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as CrewCatalog from "./crews/CrewCatalog.ts";
import * as CrewSettingsStore from "./crews/CrewSettingsStore.ts";
import * as ForkMigrations from "./persistence/ForkMigrations.ts";

export const layer = CrewCatalog.layer.pipe(
  Layer.provide(CrewSettingsStore.layer),
  Layer.provide(OrchestratorMcpService.layer),
  // Migration 002 stays in history until phase 3 drops its tables.
  Layer.provide(ForkMigrations.layer.pipe(Layer.orDie)),
);
