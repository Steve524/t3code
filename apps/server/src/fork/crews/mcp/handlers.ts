import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import * as CrewRunService from "../CrewRunService.ts";
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

/** Calls one run-service method as the calling thread. */
const asCard = <A, E>(
  call: (runs: CrewRunService.CrewRunService["Service"], threadId: ThreadId) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const threadId = yield* callingThread;
    return yield* call(yield* CrewRunService.CrewRunService, threadId);
  });

// A card records while its own turn is live, so its writes act as the caller; nothing here
// reaches beyond the run the calling thread works for.
const handlers = {
  crew_context: McpToolAccess.readsAsCaller(() =>
    asCard((runs, threadId) => runs.context(threadId)),
  ),
  crew_report: McpToolAccess.actsAsCaller((input) =>
    asCard((runs, threadId) => runs.report(threadId, input)),
  ),
  crew_decide: McpToolAccess.actsAsCaller((input) =>
    asCard((runs, threadId) => runs.decide(threadId, input)),
  ),
  crew_artifact_read: McpToolAccess.readsAsCaller(({ name }) =>
    asCard((runs, threadId) => runs.readArtifact(threadId, name)),
  ),
  crew_artifact_write: McpToolAccess.actsAsCaller((input) =>
    asCard((runs, threadId) => runs.writeArtifact(threadId, input)),
  ),
  crew_skill_get: McpToolAccess.readsAsCaller((input) =>
    asCard((runs, threadId) => runs.getSkill(threadId, input)),
  ),
  crew_note: McpToolAccess.actsAsCaller((input) =>
    asCard((runs, threadId) => runs.note(threadId, input)),
  ),
  crew_validate: McpToolAccess.readsAsCaller((input) =>
    asCard((runs, threadId) => runs.validate(threadId, input)),
  ),
  crew_tool_list: McpToolAccess.readsAsCaller(() =>
    asCard((runs, threadId) => runs.listTools(threadId)),
  ),
  crew_tool_run: McpToolAccess.actsAsCaller((input) =>
    asCard((runs, threadId) => runs.runTool(threadId, input)),
  ),
} satisfies McpToolAccess.Handlers<typeof CrewToolkit.tools>;

export const layer = McpToolAccess.toLayer(CrewToolkit, handlers);
