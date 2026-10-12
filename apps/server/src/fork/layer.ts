/**
 * Every fork service the server runtime provides. `runtimeLayer.ts` merges this
 * one layer, so a new fork service is added here and not in upstream.
 */
import * as Layer from "effect/Layer";

import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as CrewCatalog from "./crews/CrewCatalog.ts";
import * as CrewRunService from "./crews/CrewRunService.ts";
import * as CrewSettingsStore from "./crews/CrewSettingsStore.ts";
import * as ForkMigrations from "./persistence/ForkMigrations.ts";

export const layer = CrewRunService.layer.pipe(
  Layer.provideMerge(CrewCatalog.layer),
  Layer.provide(CrewSettingsStore.layer),
  Layer.provide(OrchestratorMcpService.layer),
  // Runs merge, commit and script steps. The same layers the server builds for everything else.
  Layer.provide(GitVcsDriver.layer),
  Layer.provide(ProcessRunner.layer),
  // Fork tables exist before a fork service reads them; a failed migration stops startup.
  Layer.provide(ForkMigrations.layer.pipe(Layer.orDie)),
);
