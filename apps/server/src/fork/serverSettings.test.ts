import * as NodeServices from "@effect/platform-node/NodeServices";
import { BUILT_IN_TEAM_WORKFLOW } from "@t3tools/shared/team";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettingsModule from "../serverSettings.ts";

const TestLayer = ServerSettingsModule.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-team-settings-test-" })),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("resolves an empty Team Workflow setting to the built-in preset", () =>
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
    const settings = yield* serverSettings.getSettings;

    assert.deepEqual(settings.teamWorkflows, [BUILT_IN_TEAM_WORKFLOW]);
    const custom = {
      ...BUILT_IN_TEAM_WORKFLOW,
      id: "custom-team",
      name: "Custom team",
      builtIn: false,
      roles: [],
    };
    assert.deepEqual(
      (yield* serverSettings.updateSettings({ teamWorkflows: [custom] })).teamWorkflows,
      [custom],
    );
    assert.deepEqual((yield* serverSettings.updateSettings({ teamWorkflows: [] })).teamWorkflows, [
      BUILT_IN_TEAM_WORKFLOW,
    ]);
  }).pipe(Effect.provide(TestLayer)),
);
