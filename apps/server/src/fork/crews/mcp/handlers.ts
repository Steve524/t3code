import { OrchestratorMcpFailure, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CrewMcpFailure } from "../../../../../../packages/contracts/src/fork/crews/crewMcp.ts";
import type { ForkCrewsError } from "../../../../../../packages/contracts/src/fork/crews/crewRpc.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as CrewCatalog from "../CrewCatalog.ts";
import { bundledSkill, bundledSkillNames } from "../skills/bundledSkills.ts";
import { CrewToolkit } from "./tools.ts";

export { CrewToolkit };

/** The calling thread, for a credential allowed to work with threads. */
const callingThread = McpInvocationContext.McpInvocationContext.pipe(
  Effect.filterOrFail(
    (scope) => scope.capabilities.has("orchestration"),
    () =>
      new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "This credential cannot use crew tools.",
      }),
  ),
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "A crew tool")),
  Effect.map((scope) => scope.thread.threadId),
);

const unavailable = (message: string) => () => new CrewMcpFailure({ code: "unavailable", message });

const noProject = new CrewMcpFailure({
  code: "no_project",
  message:
    "This thread has no project. Run /crew-init from a thread in the repo you want to set up.",
});

/** The calling thread's project. A thread in Scratch ("No project") or a removed project has none. */
const callingProject = Effect.gen(function* () {
  const threadId = yield* callingThread;
  const shell = yield* (yield* ThreadManagementService.ThreadManagementService)
    .getThreadShell(threadId)
    .pipe(Effect.mapError(unavailable("This thread could not be read.")));
  if (shell === null) return yield* noProject;
  const project = yield* (yield* ProjectService.ProjectService)
    .getById(shell.projectId)
    .pipe(Effect.mapError(unavailable("This thread's project could not be read.")));
  // The Scratch project is created at the Scratch folder itself.
  const scratch = yield* (yield* ManagedProjectFolders.ManagedProjectFolders).scratchRoot;
  if (
    Option.isNone(project) ||
    Option.exists(scratch, (root) => root === project.value.workspaceRoot)
  ) {
    return yield* noProject;
  }
  return shell.projectId;
});

const fromCatalogError = (error: ForkCrewsError) =>
  new CrewMcpFailure({
    code:
      error.reason === "crew_not_found"
        ? "not_found"
        : error.reason === "project_not_found"
          ? "no_project"
          : error.reason === "invalid_request"
            ? "not_allowed"
            : "unavailable",
    message: error.message,
  });

/** Calls one catalog method for the calling thread's project. Never reaches another project. */
const forProject = <A>(
  call: (
    catalog: CrewCatalog.CrewCatalog["Service"],
    projectId: ProjectId,
  ) => Effect.Effect<A, ForkCrewsError>,
) =>
  Effect.gen(function* () {
    const projectId = yield* callingProject;
    const catalog = yield* CrewCatalog.CrewCatalog;
    return yield* call(catalog, projectId).pipe(Effect.mapError(fromCatalogError));
  });

// Phase 5 binds callers to frozen grants; until then no thread can reach a server.
const gatewayUnavailable = callingThread.pipe(
  Effect.flatMap(() =>
    Effect.fail(
      new CrewMcpFailure({
        code: "unavailable",
        message: "Crew MCP access is disabled while Crews v2 is being built.",
      }),
    ),
  ),
);

const handlers = {
  crew_mcp_list_tools: McpToolAccess.actsAsCaller(() => gatewayUnavailable),
  crew_mcp_call: McpToolAccess.actsAsCaller(() => gatewayUnavailable),
  t3_skill_get: McpToolAccess.readsAsCaller(({ name, file }) =>
    callingProject.pipe(
      Effect.flatMap(() => {
        const skill = bundledSkill(name, file);
        return skill === null
          ? Effect.fail(
              new CrewMcpFailure({
                code: "not_found",
                message: `No bundled T3 skill file "${name}/${file ?? "SKILL.md"}". Bundled skills: ${bundledSkillNames().join(", ")}.`,
              }),
            )
          : Effect.succeed(skill);
      }),
    ),
  ),
  t3_crews_list: McpToolAccess.readsAsCaller(() =>
    forProject((catalog, projectId) => Effect.map(catalog.list(projectId), (crews) => ({ crews }))),
  ),
  t3_crews_get: McpToolAccess.readsAsCaller(({ crewId }) =>
    forProject((catalog, projectId) => catalog.initCrew(projectId, crewId)),
  ),
  t3_crews_toolbox: McpToolAccess.readsAsCaller(() =>
    forProject((catalog, projectId) => catalog.initToolbox(projectId)),
  ),
  t3_crews_validate: McpToolAccess.readsAsCaller(({ files }) =>
    forProject((catalog, projectId) => catalog.initDryRun(projectId, files)),
  ),
} satisfies McpToolAccess.Handlers<typeof CrewToolkit.tools>;

export const layer = McpToolAccess.toLayer(CrewToolkit, handlers);
