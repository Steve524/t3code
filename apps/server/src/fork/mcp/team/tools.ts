import {
  IsoDateTime,
  MessageId,
  McpCapabilityUnavailableError,
  ModelSelection,
  NonNegativeInt,
  PositiveInt,
  RuntimeMode,
  TeamRoleId,
  TeamRoleKind,
  ThreadId,
  ThreadPullRequestLink,
  TurnId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as TeamBranchIntegration from "../../git/TeamBranchIntegration.ts";
import * as ThreadBootstrap from "../../orchestration/Services/ThreadBootstrap.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderInstanceRegistry from "../../../provider/Services/ProviderInstanceRegistry.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as ServerConfig from "../../../config.ts";
import { ProjectionTurnRepository } from "../../../persistence/Services/ProjectionTurns.ts";
import { PlanRun, PlanRunError } from "./planRun.ts";
import { PlanRunToolInput } from "./planHandlers.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ServerConfig.ServerConfig,
  GitWorkflowService.GitWorkflowService,
  TeamBranchIntegration.TeamBranchIntegration,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  ThreadBootstrap.ThreadBootstrap,
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

export class WorkerBusyError extends Schema.TaggedError<WorkerBusyError>()("WorkerBusyError", {
  workerThreadId: ThreadId,
}) {
  override get message(): string {
    return `Worker ${this.workerThreadId} is still running. Wait for the next team update before messaging it.`;
  }
}

export class TeamWorkerResultUnavailableError extends Schema.TaggedError<TeamWorkerResultUnavailableError>()(
  "TeamWorkerResultUnavailableError",
  { workerThreadId: ThreadId, turnId: TurnId },
) {
  override get message(): string {
    return `Completed result for turn ${this.turnId} in worker ${this.workerThreadId} is unavailable.`;
  }
}

export class TeamResultCursorError extends Schema.TaggedError<TeamResultCursorError>()(
  "TeamResultCursorError",
  { cursor: NonNegativeInt },
) {
  override get message(): string {
    return `Result cursor ${this.cursor} is past the end of the message.`;
  }
}

export class TeamNotesDestinationRequiredError extends Schema.TaggedError<TeamNotesDestinationRequiredError>()(
  "TeamNotesDestinationRequiredError",
  {},
) {
  override get message(): string {
    return "Choose temporary, custom, or project research notes before exporting the brief.";
  }
}

export class TeamOperationFailedError extends Schema.TaggedError<TeamOperationFailedError>()(
  "TeamOperationFailedError",
  {
    operation: Schema.Literals([
      "roster",
      "spawn",
      "get",
      "result",
      "export",
      "artifacts",
      "message",
      "stop",
      "integrate",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return {
      roster: "Could not read the team roster.",
      spawn: "Could not spawn the team worker.",
      get: "Could not read the team worker.",
      result: "Could not read the completed worker result.",
      export: "Could not export the team artifact.",
      artifacts: "Could not list team artifacts.",
      message: "Could not message the team worker.",
      stop: "Could not stop the team worker.",
      integrate: "Could not integrate the team branches.",
    }[this.operation];
  }
}

export const TeamToolError = Schema.Union([
  PlanRunError,
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
  WorkerBusyError,
  TeamWorkerResultUnavailableError,
  TeamResultCursorError,
  TeamNotesDestinationRequiredError,
  TeamOperationFailedError,
]);

const TeamWorkerState = Schema.String;

const TeamWorkerSummary = Schema.Struct({
  latestTurnId: Schema.NullOr(TurnId),
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
});

const SpawnWorkerResult = Schema.Struct({
  workerThreadId: ThreadId,
  branch: TrimmedNonEmptyString,
});

const WorkerInput = Schema.Struct({ workerThreadId: ThreadId });

const WorkerTurnInput = Schema.Struct({ workerThreadId: ThreadId, turnId: TurnId });

const GetWorkerResultInput = Schema.Struct({
  ...WorkerTurnInput.fields,
  cursor: Schema.optional(NonNegativeInt),
});

const GetWorkerResultPage = Schema.Struct({
  workerThreadId: ThreadId,
  turnId: TurnId,
  messageId: MessageId,
  text: Schema.String,
  totalCharacters: NonNegativeInt,
  totalBytes: NonNegativeInt,
  cursor: NonNegativeInt,
  nextCursor: Schema.NullOr(NonNegativeInt),
  turnCompleted: Schema.Literal(true),
  complete: Schema.Boolean,
  truncated: Schema.Boolean,
});

const ArtifactKind = Schema.Literals(["plan", "research", "review"]);
const NotesDestination = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("temporary") }),
  Schema.Struct({ kind: Schema.Literal("custom"), directory: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("project") }),
]);

const ExportWorkerResultInput = Schema.Struct({
  ...WorkerTurnInput.fields,
  kind: ArtifactKind,
  destination: Schema.optional(NotesDestination),
});

export const TeamArtifact = Schema.Struct({
  artifactId: TrimmedNonEmptyString,
  kind: ArtifactKind,
  sourceWorkerThreadId: ThreadId,
  sourceTurnId: TurnId,
  sourceMessageId: MessageId,
  sha256: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  temporary: Schema.Boolean,
  attachment: Schema.Struct({
    _tag: Schema.Literal("attachment"),
    attachmentId: TrimmedNonEmptyString,
    fileName: TrimmedNonEmptyString,
    mimeType: Schema.Literal("text/markdown"),
  }),
  createdAt: IsoDateTime,
});

const TeamArtifactsResult = Schema.Struct({ artifacts: Schema.Array(TeamArtifact) });

const GetWorkerResult = Schema.Struct({
  ...TeamWorkerSummary.fields,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  lastAssistantMessage: Schema.NullOr(Schema.String),
  diffStats: Schema.Struct({
    files: NonNegativeInt,
    additions: NonNegativeInt,
    deletions: NonNegativeInt,
  }),
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  pullRequests: Schema.Array(ThreadPullRequestLink),
});

const MessageWorkerInput = Schema.Struct({
  workerThreadId: ThreadId,
  message: TrimmedNonEmptyString,
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
    "Start one worker in its own worktree using the selected role's configured provider, model, effort, and permission mode. Returns as soon as the worker start is committed.",
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

const GetWorkerResultTool = Tool.make("team_get_worker_result", {
  description:
    "Read a page of the exact final assistant message from a completed owned worker turn. Follow nextCursor until complete before assessing research or review. Results are never silently truncated.",
  parameters: GetWorkerResultInput,
  success: GetWorkerResultPage,
  failure: TeamToolError,
  dependencies,
})
  .annotate(Tool.Title, "Get complete worker result")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ExportWorkerResultTool = Tool.make("team_export_worker_result", {
  description:
    "Save an immutable copy of a completed worker result as a plan, research brief, or review artifact. Research requires an explicit notes destination. Returns an attachment resource that the connected environment can turn into a download URL.",
  parameters: ExportWorkerResultInput,
  success: TeamArtifact,
  failure: TeamToolError,
  dependencies,
})
  .annotate(Tool.Title, "Export team artifact")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ListArtifactsTool = Tool.make("team_list_artifacts", {
  description:
    "List the durable artifact versions exported by this orchestrator, including source turns and attachment resources for remote download.",
  success: TeamArtifactsResult,
  failure: TeamToolError,
  dependencies,
})
  .annotate(Tool.Title, "List team artifacts")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const MessageWorkerTool = Tool.make("team_message_worker", {
  description:
    "Send a follow-up task to one owned worker. Running workers reject messages; wait for the next team update first.",
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
  description: "Stop one owned worker's provider session.",
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

export const TeamToolkit = Toolkit.make(
  Tool.make("team_plan_run", {
    description:
      "Start, inspect, cancel or resume a durable planning run. Dispatch reserves budgets before launching. Reuse a requestId only for an identical retry. Record-plan and record-review consume exact completed reserved results. End your turn after dispatch; wait for completion reports. Baseline is committed HEAD; uncommitted changes are excluded.",
    parameters: PlanRunToolInput,
    success: PlanRun,
    failure: PlanRunError,
    dependencies: [
      ...dependencies,
      ProjectionTurnRepository,
      ChildProcessSpawner.ChildProcessSpawner,
    ],
  }),
  RosterTool,
  SpawnWorkerTool,
  GetWorkerTool,
  GetWorkerResultTool,
  ExportWorkerResultTool,
  ListArtifactsTool,
  MessageWorkerTool,
  StopWorkerTool,
  IntegrateTool,
);
