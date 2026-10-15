import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import { readCrewSecret } from "./mcp/CrewMcpGateway.ts";

const layerSettings = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-crew-secrets-test-" })),
    ),
  );

it.layer(NodeServices.layer)("crew secrets in server settings", (it) => {
  it.effect(
    "are stored as crew-NAME, shown to clients only as set, and removed one at a time",
    () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const read = readCrewSecret(yield* ServerSecretStore.ServerSecretStore);

        const saved = yield* service.updateSettings({
          forkCrewSecrets: { GITHUB_TOKEN: "crew-secret-one", FIGMA: "crew-secret-two" },
        });
        const client = ServerSettingsModule.redactServerSettingsForClient(saved);
        const disk = yield* fileSystem.readFileString(config.settingsPath);
        for (const value of ["crew-secret-one", "crew-secret-two"]) {
          assert.notInclude(JSON.stringify(client), value);
          assert.notInclude(disk, value);
        }
        assert.deepStrictEqual(client.forkCrewSecrets, { GITHUB_TOKEN: "••••••", FIGMA: "••••••" });
        // What a crew run's MCP servers read for `${secret:GITHUB_TOKEN}`.
        assert.deepStrictEqual(yield* read("GITHUB_TOKEN"), Option.some("crew-secret-one"));

        // A patch names one entry; the other stays saved.
        yield* service.updateSettings({ forkCrewSecrets: { GITHUB_TOKEN: "crew-secret-three" } });
        assert.deepStrictEqual(yield* read("GITHUB_TOKEN"), Option.some("crew-secret-three"));
        assert.deepStrictEqual(yield* read("FIGMA"), Option.some("crew-secret-two"));

        const removed = yield* service.updateSettings({ forkCrewSecrets: { FIGMA: null } });
        assert.deepStrictEqual(
          ServerSettingsModule.redactServerSettingsForClient(removed).forkCrewSecrets,
          { GITHUB_TOKEN: "••••••" },
        );
        assert.isTrue(Option.isNone(yield* read("FIGMA")));
        assert.deepStrictEqual(yield* read("GITHUB_TOKEN"), Option.some("crew-secret-three"));
      }).pipe(Effect.provide(layerSettings())),
  );
});
