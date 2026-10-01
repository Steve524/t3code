import {
  IsoDateTime,
  McpCapabilityUnavailableError,
  ModelSelection,
  NonNegativeInt,
  PositiveInt,
  RuntimeMode,
  TeamRoleId,
  TeamRoleKind,
  ThreadId,
  ThreadPullRequestLink,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as TeamBranchIntegration from "../../git/TeamBranchIntegration.ts";
import * as ThreadBootstrap from "../../orchestration/Services/ThreadBootstrap.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderInstanceRegistry from "../../../provider/Services/ProviderInstanceRegistry.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  GitWorkflowService.GitWorkflowService,
  TeamBranchIntegration.TeamBranchIntegration,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  ThreadBootstrap.ThreadBootstrap,
  FileSystem.FileSystem,
  Path.Path,
  WorkspaceFileSystem.WorkspaceFileSystem,
];

export class TeamThreadNotFoundError extends Schema.TaggedError<TeamThreadNotFoundError>()(
  "TeamThreadNotFoundError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class TeamOrchestratorRequiredError extends Schema.TaggedError<TeamOrchestratorRequiredError>()(
  "TeamOrchestratorRequiredError",
  {},
) {
  override get message(): string {
    return "This team tool can only be called from an orchestrator thread.";
  }
}

export class TeamProjectNotFoundError extends Schema.TaggedError<TeamProjectNotFoundError>()(
  "TeamProjectNotFoundError",
  {},
) {
  override get message(): string {
    return "The orchestrator's project was not found.";
  }
}

export class TeamRoleNotFoundError extends Schema.TaggedError<TeamRoleNotFoundError>()(
  "TeamRoleNotFoundError",
  { roleId: TeamRoleId },
) {
  override get message(): string {
    return `Team role ${this.roleId} was not found.`;
  }
}

export class TeamRoleDisabledError extends Schema.TaggedError<TeamRoleDisabledError>()(
  "TeamRoleDisabledError",
  { roleId: TeamRoleId },
) {
  override get message(): string {
    return `Team role ${this.roleId} is disabled.`;
  }
}

export class TeamWorkerLimitError extends Schema.TaggedError<TeamWorkerLimitError>()(
  "TeamWorkerLimitError",
  { limit: PositiveInt },
) {
  override get message(): string {
    return `The team already has ${this.limit} running workers. Wait for one to finish before spawning another.`;
  }
}

export class TeamReviewRoundLimitError extends Schema.TaggedError<TeamReviewRoundLimitError>()(
  "TeamReviewRoundLimitError",
  { limit: PositiveInt, reviewRound: PositiveInt },
) {
  override get message(): string {
    return `Review round ${this.reviewRound} exceeds this workflow's limit of ${this.limit}. Report the remaining findings to the user.`;
  }
}

export class TeamProviderUnavailableError extends Schema.TaggedError<TeamProviderUnavailableError>()(
  "TeamProviderUnavailableError",
  { instanceId: TrimmedNonEmptyString },
) {
  override get message(): string {
    return `Provider instance ${this.instanceId} is missing, disabled, or unavailable. Choose another configured provider in Workflow settings.`;
  }
}

export class TeamBaseBranchUnavailableError extends Schema.TaggedError<TeamBaseBranchUnavailableError>()(
  "TeamBaseBranchUnavailableError",
  {},
) {
  override get message(): string {
    return "No base branch is available. Pass baseBranch explicitly.";
  }
}

export class TeamWorkerNotFoundError extends Schema.TaggedError<TeamWorkerNotFoundError>()(
  "TeamWorkerNotFoundError",
  { workerThreadId: ThreadId },
) {
  override get message(): string {
    return `Worker thread ${this.workerThreadId} was not found.`;
  }
}

export class TeamWorkerOwnershipError extends Schema.TaggedError<TeamWorkerOwnershipError>()(
  "TeamWorkerOwnershipError",
  { workerThreadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.workerThreadId} is not your worker.`;
  }
}

export class TeamIntegrationBranchOwnershipError extends Schema.TaggedError<TeamIntegrationBranchOwnershipError>()(
  "TeamIntegrationBranchOwnershipError",
  { branch: TrimmedNonEmptyString },
) {
  override get message(): string {
    return `Branch ${this.branch} does not belong to one of your workers.`;
  }
}

export class TeamIntegrationTargetError extends Schema.TaggedError<TeamIntegrationTargetError>()(
  "TeamIntegrationTargetError",
  { branch: TrimmedNonEmptyString },
) {
  override get message(): string {
    return `Integration cannot target the base branch ${this.branch}. Use a dedicated integration branch.`;
  }
}

export class TeamIntegrationUnsupportedError extends Schema.TaggedError<TeamIntegrationUnsupportedError>()(
  "TeamIntegrationUnsupportedError",
  {},
) {
  override get message(): string {
    return "This workflow stops at an approved plan. It has no branches to integrate.";
  }
}

export class TeamPlanFileError extends Schema.TaggedError<TeamPlanFileError>()(
  "TeamPlanFileError",
  { planPath: TrimmedNonEmptyString, reason: Schema.Literals(["outside-checkout", "unreadable"]) },
) {
  override get message(): string {
    return this.reason === "outside-checkout"
      ? `planPath ${this.planPath} must be relative to your checkout and stay inside it.`
      : `Could not read the plan at ${this.planPath}.`;
  }
}

export class TeamPlanWorkflowRequiredError extends Schema.TaggedError<TeamPlanWorkflowRequiredError>()(
  "TeamPlanWorkflowRequiredError",
  {},
) {
  override get message(): string {
    return "Only a plan-type workflow can write plan artifacts.";
  }
}

export class TeamPlanArtifactPathError extends Schema.TaggedError<TeamPlanArtifactPathError>()(
  "TeamPlanArtifactPathError",
  {
    relativePath: Schema.String,
    reason: Schema.Literals(["invalid-path", "outside-allowlist", "symlink"]),
  },
) {
  override get message(): string {
    return `Plan artifact path '${this.relativePath}' was rejected: ${this.reason}. Use a relative .md path under the workflow's plans or research folder, docs/adr/, or a file named CONTEXT.md or CONTEXT-MAP.md, without symlinks.`;
  }
}

export class WorkerBusyError extends Schema.TaggedError<WorkerBusyError>()("WorkerBusyError", {
  workerThreadId: ThreadId,
}) {
  override get message(): string {
    return `Worker ${this.workerThreadId} is still running. Wait for the next team update before messaging it.`;
  }
}

export class TeamOperationFailedError extends Schema.TaggedError<TeamOperationFailedError>()(
  "TeamOperationFailedError",
  {
    operation: Schema.Literals(["roster", "spawn", "get", "message", "stop", "integrate", "write"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return {
      roster: "Could not read the team roster.",
      spawn: "Could not spawn the team worker.",
      get: "Could not read the team worker.",
      message: "Could not message the team worker.",
      stop: "Could not stop the team worker.",
      integrate: "Could not integrate the team branches.",
      write: "Could not write the plan artifact.",
    }[this.operation];
  }
}

export const TeamToolError = Schema.Union([
  McpCapabilityUnavailableError,
  TeamThreadNotFoundError,
  TeamOrchestratorRequiredError,
  TeamProjectNotFoundError,
  TeamRoleNotFoundError,
  TeamRoleDisabledError,
  TeamWorkerLimitError,
  TeamReviewRoundLimitError,
  TeamProviderUnavailableError,
  TeamBaseBranchUnavailableError,
  TeamWorkerNotFoundError,
  TeamWorkerOwnershipError,
  TeamIntegrationBranchOwnershipError,
  TeamIntegrationTargetError,
  TeamIntegrationUnsupportedError,
  TeamPlanFileError,
  TeamPlanWorkflowRequiredError,
  TeamPlanArtifactPathError,
  WorkerBusyError,
  TeamOperationFailedError,
]);

const TeamWorkerState = Schema.String;

const TeamWorkerSummary = Schema.Struct({
  workerThreadId: ThreadId,
  roleId: TeamRoleId,
  roleLabel: TrimmedNonEmptyString,
  taskTitle: TrimmedNonEmptyString,
  reviewRound: Schema.NullOr(NonNegativeInt),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  state: TeamWorkerState,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});

const TeamRosterResult = Schema.Struct({
  roles: Schema.Array(
    Schema.Struct({
      id: TeamRoleId,
      label: TrimmedNonEmptyString,
      kind: TeamRoleKind,
      summary: Schema.String,
      modelSelection: ModelSelection,
      runtimeMode: RuntimeMode,
    }),
  ),
  limits: Schema.Struct({
    maxParallelWorkers: PositiveInt,
    maxReviewRounds: PositiveInt,
  }),
  workers: Schema.Array(TeamWorkerSummary),
});

const SpawnWorkerInput = Schema.Struct({
  roleId: TeamRoleId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(40)),
  task: TrimmedNonEmptyString,
  baseBranch: Schema.optional(TrimmedNonEmptyString),
  reviewRound: Schema.optional(PositiveInt),
  planPath: Schema.optional(TrimmedNonEmptyString),
});

const SpawnWorkerResult = Schema.Struct({
  workerThreadId: ThreadId,
  /** Null for read-only workers that share the orchestrator's checkout. */
  branch: Schema.NullOr(TrimmedNonEmptyString),
});

const WorkerInput = Schema.Struct({ workerThreadId: ThreadId });

const GetWorkerResult = Schema.Struct({
  ...TeamWorkerSummary.fields,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  lastAssistantMessage: Schema.NullOr(Schema.String),
  /** Null for researchers and plan reviewers, which never change files. */
  diffStats: Schema.NullOr(
    Schema.Struct({
      files: NonNegativeInt,
      additions: NonNegativeInt,
      deletions: NonNegativeInt,
    }),
  ),
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  pullRequests: Schema.Array(ThreadPullRequestLink),
});

const MessageWorkerInput = Schema.Struct({
  workerThreadId: ThreadId,
  message: TrimmedNonEmptyString,
  planPath: Schema.optional(TrimmedNonEmptyString),
});

const WorkerActionResult = Schema.Struct({ workerThreadId: ThreadId });

const IntegrateInput = Schema.Struct({
  branches: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
  targetBranch: Schema.optional(TrimmedNonEmptyString),
});

const IntegrateResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("merged"),
    branch: TrimmedNonEmptyString,
    headSha: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    status: Schema.Literal("conflict"),
    branch: TrimmedNonEmptyString,
    conflictingBranch: TrimmedNonEmptyString,
    conflictingFiles: Schema.Array(TrimmedNonEmptyString),
  }),
]);

const RosterTool = Tool.make("team_roster", {
  description:
    "List enabled team roles, workflow limits, and every worker owned by this orchestrator. Use this before spawning workers and do not duplicate an existing task.",
  success: TeamRosterResult,
  failure: TeamToolError,
  dependencies,
})
  .annotate(Tool.Title, "List team roster")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SpawnWorkerTool = Tool.make("team_spawn_worker", {
  description:
    "Start one worker using the selected role's configured provider, model, effort, and permission mode. Implementer and reviewer workers get their own worktree and branch; researcher and plan-reviewer workers are read-only: they share this thread's checkout with no branch where the provider can be held to read-only, and otherwise get an isolated worktree that can't see your uncommitted files. For a plan reviewer, pass planPath (relative to your checkout); an isolated reviewer gets the plan's text inline. Returns as soon as the worker start is committed.",
  parameters: SpawnWorkerInput,
  success: SpawnWorkerResult,
  failure: TeamToolError,
  dependencies,
})
  .annotate(Tool.Title, "Spawn team worker")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const GetWorkerTool = Tool.make("team_get_worker", {
  description:
    "Read one owned worker's state, worktree, latest assistant output, diff totals, pending requests, and linked pull requests.",
  parameters: WorkerInput,
  success: GetWorkerResult,
  failure: TeamToolError,
  dependencies,
})
  .annotate(Tool.Title, "Get team worker")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const MessageWorkerTool = Tool.make("team_message_worker", {
  description:
    "Send a follow-up task to one owned worker. Running workers reject messages; wait for the next team update first. Pass planPath again for a plan reviewer so an isolated reviewer gets the revised plan inline.",
  parameters: MessageWorkerInput,
  success: WorkerActionResult,
  failure: TeamToolError,
  dependencies,
})
  .annotate(Tool.Title, "Message team worker")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const StopWorkerTool = Tool.make("team_stop_worker", {
  description:
    "Stop one owned worker's provider session. An isolated read-only worker's worktree is deleted once its session stops.",
  parameters: WorkerInput,
  success: WorkerActionResult,
  failure: TeamToolError,
  dependencies,
})
  .annotate(Tool.Title, "Stop team worker")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const IntegrateTool = Tool.make("team_integrate", {
  description:
    "Merge owned worker branches in the supplied order into a dedicated integration worktree. Returns the integration head or the first conflict without modifying the base branch.",
  parameters: IntegrateInput,
  success: IntegrateResult,
  failure: TeamToolError,
  dependencies,
})
  .annotate(Tool.Title, "Integrate team branches")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const WritePlanArtifactTool = Tool.make("team_write_plan_artifact", {
  description:
    "Create or replace a Markdown plan artifact in this planner thread's checkout. Only plan-type orchestrators can use this. Pass relativePath and the full contents. Allowed paths: .md files under the workflow's plansDir, researchDir, or docs/adr/, and files named CONTEXT.md or CONTEXT-MAP.md. Paths must be relative, without '..' or symlinks. Creates parent directories as needed.",
  parameters: Schema.Struct({ relativePath: TrimmedNonEmptyString, contents: Schema.String }),
  success: Schema.Struct({ relativePath: TrimmedNonEmptyString }),
  failure: TeamToolError,
  dependencies,
})
  .annotate(Tool.Title, "Write plan artifact")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const TeamToolkit = Toolkit.make(
  RosterTool,
  SpawnWorkerTool,
  GetWorkerTool,
  MessageWorkerTool,
  StopWorkerTool,
  IntegrateTool,
  WritePlanArtifactTool,
);
