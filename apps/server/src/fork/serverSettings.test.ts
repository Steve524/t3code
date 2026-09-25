import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import {
  BUILT_IN_TEAM_WORKFLOW,
  BUILT_IN_TEAM_WORKFLOWS,
  RESEARCH_PLAN_TEAM_WORKFLOW,
} from "@t3tools/shared/team";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettingsModule from "../serverSettings.ts";

const decodePersistedSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings));

const TestLayer = ServerSettingsModule.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-team-settings-test-" })),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("resolves saved Team Workflow settings with both built-in presets", () =>
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
    const settings = yield* serverSettings.getSettings;

    assert.deepEqual(settings.teamWorkflows, BUILT_IN_TEAM_WORKFLOWS);
    const custom = {
      ...BUILT_IN_TEAM_WORKFLOW,
      id: "custom-team",
      name: "Custom team",
      builtIn: false,
      roles: [],
    };
    assert.deepEqual(
      (yield* serverSettings.updateSettings({ teamWorkflows: [custom] })).teamWorkflows,
      [custom, ...BUILT_IN_TEAM_WORKFLOWS],
    );
    assert.deepEqual(
      (yield* serverSettings.updateSettings({ teamWorkflows: [] })).teamWorkflows,
      BUILT_IN_TEAM_WORKFLOWS,
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("persists all three planning role selections", () =>
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
    const { settingsPath } = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const planned = {
      ...RESEARCH_PLAN_TEAM_WORKFLOW,
      roles: RESEARCH_PLAN_TEAM_WORKFLOW.roles.map((role, index) => ({
        ...role,
        modelSelection: {
          instanceId: ProviderInstanceId.make(`provider-${index}`),
          model: `model-${index}`,
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        runtimeMode: "approval-required" as const,
      })),
    };

    yield* serverSettings.updateSettings({ teamWorkflows: [BUILT_IN_TEAM_WORKFLOW, planned] });
    const saved = yield* fileSystem
      .readFileString(settingsPath)
      .pipe(Effect.flatMap(decodePersistedSettings));
    const reloaded = saved.teamWorkflows.find(({ id }) => id === planned.id);
    assert.deepEqual(
      reloaded?.roles.map(({ modelSelection }) => modelSelection),
      planned.roles.map(({ modelSelection }) => modelSelection),
    );
    assert.deepEqual(
      reloaded?.roles.map(({ runtimeMode }) => runtimeMode),
      planned.roles.map(({ runtimeMode }) => runtimeMode),
    );
  }).pipe(Effect.provide(TestLayer)),
);
