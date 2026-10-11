import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { runForkMigrations } from "../persistence/ForkMigrations.ts";
import * as CrewSettingsStore from "./CrewSettingsStore.ts";

// Built per test, so each one starts from an empty database.
const layerTest = CrewSettingsStore.layer.pipe(
  Layer.provide(Layer.effectDiscard(runForkMigrations())),
  Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const role = { crewId: "feature-trio", roleId: "planner" };
const terra = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-terra" };
const opus = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "high" }],
};

describe("crew settings store", () => {
  it.effect("keeps one override per role and scope, and scopes apart", () =>
    Effect.gen(function* () {
      const store = yield* CrewSettingsStore.CrewSettingsStore;
      yield* store.setRoleOverride({ scope: "environment", ...role, modelSelection: terra });
      yield* store.setRoleOverride({ scope: "environment", ...role, modelSelection: opus });
      yield* store.setRoleOverride({
        scope: "project",
        projectId: projectA,
        ...role,
        modelSelection: terra,
      });

      const environment = yield* store.listRoleOverrides({ scope: "environment" });
      assert.deepStrictEqual(
        environment.map((entry) => [entry.projectId, entry.modelSelection]),
        [[null, opus]],
      );
      const inProjectA = yield* store.listRoleOverrides({ scope: "project", projectId: projectA });
      assert.deepStrictEqual(
        inProjectA.map((entry) => [entry.scope, entry.projectId, entry.modelSelection]),
        [["project", projectA, terra]],
      );
      assert.deepStrictEqual(
        yield* store.listRoleOverrides({ scope: "project", projectId: projectB }),
        [],
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("keeps a field that a write leaves out, and clears one set to null", () =>
    Effect.gen(function* () {
      const store = yield* CrewSettingsStore.CrewSettingsStore;
      const scope = { scope: "environment", ...role } as const;
      yield* store.setRoleOverride({ ...scope, modelSelection: terra, runtimeMode: "auto" });

      const raised = yield* store.setRoleOverride({ ...scope, runtimeMode: "full-access" });
      assert.deepStrictEqual([raised.modelSelection, raised.runtimeMode], [terra, "full-access"]);

      yield* store.setRoleOverride({ ...scope, modelSelection: null });
      const [stored] = yield* store.listRoleOverrides({ scope: "environment" });
      assert.deepStrictEqual([stored?.modelSelection, stored?.runtimeMode], [null, "full-access"]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("resets one role, or every role of a crew, in one scope only", () =>
    Effect.gen(function* () {
      const store = yield* CrewSettingsStore.CrewSettingsStore;
      const inProject = { scope: "project", projectId: projectA, crewId: "feature-trio" } as const;
      for (const roleId of ["planner", "implementer", "reviewer"]) {
        yield* store.setRoleOverride({ ...inProject, roleId, modelSelection: terra });
      }
      yield* store.setRoleOverride({ scope: "environment", ...role, modelSelection: terra });
      const roles = store
        .listRoleOverrides({ scope: "project", projectId: projectA })
        .pipe(Effect.map((entries) => entries.map((entry) => entry.roleId)));

      yield* store.resetRoleOverrides({ ...inProject, roleId: "planner" });
      assert.deepStrictEqual(yield* roles, ["implementer", "reviewer"]);

      yield* store.resetRoleOverrides(inProject);
      assert.deepStrictEqual(yield* roles, []);
      assert.lengthOf(yield* store.listRoleOverrides({ scope: "environment" }), 1);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("defaults a project's toolbox mode to extend and remembers a change", () =>
    Effect.gen(function* () {
      const store = yield* CrewSettingsStore.CrewSettingsStore;
      assert.strictEqual(yield* store.getToolboxMode(projectA), "extend");

      yield* store.setToolboxMode({ projectId: projectA, mode: "override" });
      yield* store.setToolboxMode({ projectId: projectA, mode: "override" });
      assert.strictEqual(yield* store.getToolboxMode(projectA), "override");
      assert.strictEqual(yield* store.getToolboxMode(projectB), "extend");
    }).pipe(Effect.provide(layerTest)),
  );
});
