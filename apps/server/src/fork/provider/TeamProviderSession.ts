import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { RuntimeInstructionTeam } from "./TeamRuntimeInstructions.ts";

type ProjectionQuery = Option.Option<ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]>;

export const canUseTeamTools = Effect.fn("ProviderService.canUseTeamTools")(function* (
  projectionQuery: ProjectionQuery,
  threadId: ThreadId,
) {
  if (Option.isNone(projectionQuery)) return false;
  const thread = yield* projectionQuery.value.getThreadShellById(threadId).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not read thread team access; withholding team tools.", {
        cause,
        threadId,
      }).pipe(Effect.as(Option.none())),
    ),
  );
  return Option.isSome(thread) && thread.value.team?.role === "orchestrator";
});

export const resolveRuntimeInstructionTeam = Effect.fn(
  "ProviderService.resolveRuntimeInstructionTeam",
)(
  function* (projectionQuery: ProjectionQuery, threadId: ThreadId) {
    if (Option.isNone(projectionQuery)) return undefined;
    const thread = yield* projectionQuery.value.getThreadShellById(threadId);
    if (Option.isNone(thread) || !thread.value.team) return undefined;
    const { team } = thread.value;
    if (team.role === "orchestrator") {
      return { role: "orchestrator", workflow: team.workflow } satisfies RuntimeInstructionTeam;
    }
    const orchestrator = yield* projectionQuery.value.getThreadShellById(team.orchestratorThreadId);
    const orchestratorShell = Option.getOrUndefined(orchestrator);
    const role =
      orchestratorShell?.team?.role === "orchestrator"
        ? orchestratorShell.team.workflow.roles.find((candidate) => candidate.id === team.roleId)
        : undefined;
    return {
      role: "worker",
      roleId: team.roleId,
      roleLabel: team.roleLabel,
      roleInstructions: role?.instructions ?? "",
      orchestratorTitle: orchestratorShell?.title ?? team.orchestratorThreadId,
      branch: thread.value.branch ?? "the assigned branch",
    } satisfies RuntimeInstructionTeam;
  },
  Effect.catch((cause) =>
    Effect.logWarning("Could not resolve team instructions for provider session.", {
      cause,
    }).pipe(Effect.as(undefined)),
  ),
);
