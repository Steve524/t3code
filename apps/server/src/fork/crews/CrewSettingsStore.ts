/**
 * CrewSettingsStore - what this environment remembers about crews: per-role
 * model and runtime mode overrides, and each project's toolbox mode.
 *
 * @module CrewSettingsStore
 */
import { ModelSelection, ProjectId, RuntimeMode } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import type { CrewRoleOverride } from "../../../../../packages/contracts/src/fork/crews/crewModel.ts";
import type {
  CrewRoleOverrideResetInput,
  CrewRoleOverrideScope,
  CrewRoleOverrideSetInput,
  CrewToolboxSetModeInput,
} from "../../../../../packages/contracts/src/fork/crews/crewRpc.ts";
import { ToolboxMode } from "../../../../../packages/contracts/src/fork/crews/crewToolbox.ts";
import { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

type CrewSettingsStoreError = PersistenceSqlError | PersistenceDecodeError;

export class CrewSettingsStore extends Context.Service<
  CrewSettingsStore,
  {
    /** The overrides stored for exactly this scope. */
    readonly listRoleOverrides: (
      scope: CrewRoleOverrideScope,
    ) => Effect.Effect<ReadonlyArray<CrewRoleOverride>, CrewSettingsStoreError>;
    /** A field left out keeps its stored value; null clears it. */
    readonly setRoleOverride: (
      input: CrewRoleOverrideSetInput,
    ) => Effect.Effect<CrewRoleOverride, CrewSettingsStoreError>;
    /** Without `roleId`, every role of the crew in that scope. */
    readonly resetRoleOverrides: (
      input: CrewRoleOverrideResetInput,
    ) => Effect.Effect<void, CrewSettingsStoreError>;
    /** `extend` for a project that never chose. */
    readonly getToolboxMode: (
      projectId: ProjectId,
    ) => Effect.Effect<ToolboxMode, CrewSettingsStoreError>;
    readonly setToolboxMode: (
      input: CrewToolboxSetModeInput,
    ) => Effect.Effect<void, CrewSettingsStoreError>;
  }
>()("t3/fork/crews/CrewSettingsStore") {}

const ModelSelectionJson = Schema.fromJsonString(ModelSelection);
const encodeModelSelection = Schema.encodeEffect(ModelSelectionJson);

const OverrideRow = Schema.Struct({
  scope: Schema.Literals(["environment", "project"]),
  // '' for the environment scope.
  projectId: Schema.String,
  crewId: Schema.String,
  roleId: Schema.String,
  modelSelection: Schema.NullOr(ModelSelectionJson),
  runtimeMode: Schema.NullOr(RuntimeMode),
  updatedAt: Schema.String,
});

const scopeProjectId = (scope: CrewRoleOverrideScope) =>
  scope.scope === "project" ? scope.projectId : "";

function toStoreError(operation: string) {
  return (cause: unknown): CrewSettingsStoreError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(operation, cause)
      : new PersistenceSqlError({ operation, cause });
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findOverrides = SqlSchema.findAll({
    Request: Schema.Struct({ scope: Schema.String, projectId: Schema.String }),
    Result: OverrideRow,
    execute: ({ scope, projectId }) =>
      sql`
        SELECT
          scope AS "scope",
          project_id AS "projectId",
          crew_id AS "crewId",
          role_id AS "roleId",
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          updated_at AS "updatedAt"
        FROM fork_crew_role_overrides
        WHERE scope = ${scope} AND project_id = ${projectId}
        ORDER BY crew_id, role_id
      `,
  });

  const findToolboxMode = SqlSchema.findAll({
    Request: ProjectId,
    Result: Schema.Struct({ toolboxMode: ToolboxMode }),
    execute: (projectId) =>
      sql`
        SELECT toolbox_mode AS "toolboxMode"
        FROM fork_crew_project_settings
        WHERE project_id = ${projectId}
      `,
  });

  return CrewSettingsStore.of({
    listRoleOverrides: (scope) =>
      findOverrides({ scope: scope.scope, projectId: scopeProjectId(scope) }).pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            ...row,
            projectId: row.projectId === "" ? null : ProjectId.make(row.projectId),
          })),
        ),
        Effect.mapError(toStoreError("listCrewRoleOverrides")),
      ),

    setRoleOverride: (input) =>
      Effect.gen(function* () {
        const projectId = scopeProjectId(input);
        const existing = (yield* findOverrides({ scope: input.scope, projectId })).find(
          (row) => row.crewId === input.crewId && row.roleId === input.roleId,
        );
        const modelSelection =
          input.modelSelection === undefined
            ? (existing?.modelSelection ?? null)
            : input.modelSelection;
        const runtimeMode =
          input.runtimeMode === undefined ? (existing?.runtimeMode ?? null) : input.runtimeMode;
        const modelSelectionJson =
          modelSelection === null ? null : yield* encodeModelSelection(modelSelection);
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          INSERT INTO fork_crew_role_overrides (
            scope,
            project_id,
            crew_id,
            role_id,
            model_selection_json,
            runtime_mode,
            updated_at
          )
          VALUES (
            ${input.scope},
            ${projectId},
            ${input.crewId},
            ${input.roleId},
            ${modelSelectionJson},
            ${runtimeMode},
            ${updatedAt}
          )
          ON CONFLICT (scope, project_id, crew_id, role_id)
          DO UPDATE SET
            model_selection_json = excluded.model_selection_json,
            runtime_mode = excluded.runtime_mode,
            updated_at = excluded.updated_at
        `;
        return {
          scope: input.scope,
          projectId: input.scope === "project" ? input.projectId : null,
          crewId: input.crewId,
          roleId: input.roleId,
          modelSelection,
          runtimeMode,
          updatedAt,
        };
      }).pipe(sql.withTransaction, Effect.mapError(toStoreError("setCrewRoleOverride"))),

    resetRoleOverrides: (input) =>
      (input.roleId === undefined
        ? sql`
            DELETE FROM fork_crew_role_overrides
            WHERE scope = ${input.scope}
              AND project_id = ${scopeProjectId(input)}
              AND crew_id = ${input.crewId}
          `
        : sql`
            DELETE FROM fork_crew_role_overrides
            WHERE scope = ${input.scope}
              AND project_id = ${scopeProjectId(input)}
              AND crew_id = ${input.crewId}
              AND role_id = ${input.roleId}
          `
      ).pipe(Effect.asVoid, Effect.mapError(toStoreError("resetCrewRoleOverrides"))),

    getToolboxMode: (projectId) =>
      findToolboxMode(projectId).pipe(
        Effect.map((rows) => rows[0]?.toolboxMode ?? "extend"),
        Effect.mapError(toStoreError("getCrewToolboxMode")),
      ),

    setToolboxMode: ({ projectId, mode }) =>
      Effect.gen(function* () {
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          INSERT INTO fork_crew_project_settings (project_id, toolbox_mode, updated_at)
          VALUES (${projectId}, ${mode}, ${updatedAt})
          ON CONFLICT (project_id)
          DO UPDATE SET toolbox_mode = excluded.toolbox_mode, updated_at = excluded.updated_at
        `;
      }).pipe(Effect.mapError(toStoreError("setCrewToolboxMode"))),
  });
});

export const layer = Layer.effect(CrewSettingsStore, make);
