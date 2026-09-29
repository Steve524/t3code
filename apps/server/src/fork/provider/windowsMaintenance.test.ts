import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { windowsHost } from "../testing/platformFixtures.ts";
import {
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../../provider/providerMaintenance.ts";

it.effect.skipIf(!windowsHost)(
  "recognizes native Windows package executables and rejects a missing one",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-maintenance-" });
      const resolver = makePackageManagedProviderMaintenanceResolver({
        provider: ProviderDriverKind.make("packageTool"),
        npmPackageName: "@example/package-tool",
        nativeUpdate: null,
      });
      for (const [manager, directory] of [
        ["npm", "lib/node_modules"],
        ["pnpm", "pnpm/global/5/node_modules"],
      ] as const) {
        const binaryPath = path.join(root, directory, "@example/package-tool/bin/tool.cmd");
        yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(binaryPath, "@echo off\r\n");
        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(resolver, {
          binaryPath,
          env: { PATH: "", PATHEXT: ".CMD;.EXE" },
        });
        expect(capabilities.update?.executable).toBe(manager);
        expect(capabilities.update?.args).toContain("@example/package-tool@latest");
        yield* fs.remove(binaryPath);
        expect(
          (yield* resolveProviderMaintenanceCapabilitiesEffect(resolver, {
            binaryPath,
            env: { PATH: "" },
          })).update,
        ).toBeNull();
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
