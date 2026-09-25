import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProviderValidationError } from "../../provider/Errors.ts";

import type * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { RuntimeInstructionTeam } from "./TeamRuntimeInstructions.ts";
import { PLAN_LOOP_INVOCATION, resolvePlanLoopInvocation } from "./PlanLoopSkill.ts";

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
      workflow:
        orchestratorShell?.team?.role === "orchestrator"
          ? orchestratorShell.team.workflow
          : undefined,
    } satisfies RuntimeInstructionTeam;
  },
  Effect.catch((cause) =>
    Effect.logWarning("Could not resolve team instructions for provider session.", {
      cause,
    }).pipe(Effect.as(undefined)),
  ),
);

export const normalizePlanLoopPrompt = Effect.fn("ProviderService.normalizePlanLoopPrompt")(
  function* (projectionQuery: ProjectionQuery, threadId: ThreadId, prompt: string | undefined) {
    if (prompt === undefined || !PLAN_LOOP_INVOCATION.test(prompt)) return prompt;
    const team = yield* resolveRuntimeInstructionTeam(projectionQuery, threadId);
    const invocation = resolvePlanLoopInvocation(prompt, team);
    if (invocation.error) {
      return yield* new ProviderValidationError({
        operation: "ProviderService.sendTurn",
        issue: invocation.error,
      });
    }
    return invocation.input ?? prompt;
  },
);
