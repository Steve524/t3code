import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "../../baseSchemas.ts";
import { ChatAttachment } from "../../chatAttachment.ts";
import { ModelSelection } from "../../modelSelection.ts";
import { RuntimeMode } from "../../providerPolicy.ts";
import { CrewDiagnostic } from "./crewFile.ts";
import { ToolboxMode } from "./crewToolbox.ts";

const Source = Schema.Literals(["role", "crew", "home", "repo"]);

/** What a role had when its run started. Later edits to the files change the next run only. */
export const CrewRunToolbox = Schema.Struct({
  // Skills are read when used, so the hash only detects a change since the run started.
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      path: Schema.String,
      source: Source,
      hash: Schema.String,
      description: Schema.String,
    }),
  ),
  mcp: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      source: Source,
      command: Schema.String,
      args: Schema.Array(Schema.String),
      // `${secret:NAME}` references stay unresolved here.
      env: Schema.Record(Schema.String, Schema.String),
    }),
  ),
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      source: Source,
      description: Schema.optionalKey(Schema.String),
      run: Schema.String,
      timeoutSeconds: Schema.optionalKey(Schema.Number),
    }),
  ),
});
export type CrewRunToolbox = typeof CrewRunToolbox.Type;

export const CrewRunStatus = Schema.Literals([
  "running",
  "paused",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);
export type CrewRunStatus = typeof CrewRunStatus.Type;

/** Whose turn a card is waiting on. Derived from the card's state when read, never stored. */
export const CrewRunLane = Schema.Literals([
  "queued",
  "working",
  "waiting_lead",
  "needs_you",
  "done",
  "failed",
  "skipped",
]);
export type CrewRunLane = typeof CrewRunLane.Type;

export const CrewRunCard = Schema.Struct({
  cardId: Schema.String,
  stepId: Schema.String,
  stepType: Schema.Literals(["task", "fanout", "script", "merge", "gate", "decision"]),
  visit: Schema.Number,
  itemIndex: Schema.NullOr(Schema.Number),
  roleId: Schema.NullOr(Schema.String),
  modelSelection: Schema.NullOr(ModelSelection),
  threadId: Schema.NullOr(ThreadId),
  state: Schema.String,
  lane: CrewRunLane,
  column: Schema.String,
  attempt: Schema.Number,
  outcome: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  // Gate and decision cards: what is asked, and of whom.
  gate: Schema.NullOr(
    Schema.Struct({
      prompt: Schema.String,
      outcomes: Schema.Array(Schema.String),
      by: Schema.Literals(["user", "lead"]),
    }),
  ),
  decidedBy: Schema.NullOr(Schema.Literals(["user", "lead"])),
  // A decision card names the card whose outcome it settles.
  sourceCardId: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type CrewRunCard = typeof CrewRunCard.Type;

const Usage = Schema.Struct({ used: Schema.Number, limit: Schema.Number });

/** The board: a run's header and its cards. Transcripts stay in the thread streams. */
export const CrewRunView = Schema.Struct({
  runId: Schema.String,
  projectId: ProjectId,
  crewId: Schema.String,
  crewName: Schema.String,
  status: CrewRunStatus,
  homeMode: Schema.Literals(["first-step", "lead"]),
  leadRoleId: Schema.NullOr(Schema.String),
  homeThreadId: Schema.NullOr(ThreadId),
  integrationBranch: Schema.NullOr(Schema.String),
  integrationWorktree: Schema.NullOr(Schema.String),
  toolboxMode: ToolboxMode,
  roles: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      modelSelection: ModelSelection,
      runtimeMode: RuntimeMode,
      // Only `runs.get` carries it; the streams leave it out to stay small.
      toolbox: Schema.optionalKey(CrewRunToolbox),
    }),
  ),
  routes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      used: Schema.Number,
      max: Schema.Number,
    }),
  ),
  budget: Schema.Struct({
    cards: Usage,
    hours: Usage,
    fanoutItems: Schema.Number,
    // Set while the run waits for the user to extend a budget or stop.
    gate: Schema.NullOr(
      Schema.Struct({
        kind: Schema.Literals(["maxCards", "maxHours", "maxFanoutItems"]),
        choices: Schema.Array(Schema.String),
        total: Schema.NullOr(Schema.Number),
      }),
    ),
  }),
  columns: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
  cards: Schema.Array(CrewRunCard),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type CrewRunView = typeof CrewRunView.Type;

export const CrewRunSummary = Schema.Struct({
  runId: Schema.String,
  projectId: ProjectId,
  crewId: Schema.String,
  crewName: Schema.String,
  status: CrewRunStatus,
  homeThreadId: Schema.NullOr(ThreadId),
  needsYou: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type CrewRunSummary = typeof CrewRunSummary.Type;

export const CrewRunStartInput = Schema.Struct({
  projectId: ProjectId,
  crewId: Schema.String,
  inputs: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Boolean])),
  attachments: Schema.Array(ChatAttachment),
  roleModelOverrides: Schema.optionalKey(Schema.Record(Schema.String, ModelSelection)),
  // The composer's selection: the model of a role nothing else gives one.
  modelSelection: Schema.optionalKey(ModelSelection),
  workspace: Schema.Union([
    Schema.Struct({ mode: Schema.Literal("new-worktree"), baseRef: Schema.String }),
    Schema.Struct({ mode: Schema.Literal("current-checkout") }),
  ]),
  runtimeMode: RuntimeMode,
  // The same id starts the same run, so a retried request never starts a second one.
  clientRequestId: Schema.String.check(Schema.isMinLength(1)),
});
export type CrewRunStartInput = typeof CrewRunStartInput.Type;

export const CrewRunStartResult = Schema.Struct({
  runId: Schema.String,
  homeThreadId: Schema.NullOr(ThreadId),
});
export type CrewRunStartResult = typeof CrewRunStartResult.Type;

export const CrewRunTarget = Schema.Struct({ runId: Schema.String });

/** A run by id, or the run a home or card thread works for. */
export const CrewRunSubscribeInput = Schema.Union([
  CrewRunTarget,
  Schema.Struct({ threadId: ThreadId }),
]);

/** One change the user makes to a run. A new control is a new action here, not a new RPC. */
export const CrewRunControlInput = Schema.Struct({
  runId: Schema.String,
  action: Schema.Union([
    Schema.Struct({ type: Schema.Literals(["pause", "resume", "cancel"]) }),
    Schema.Struct({
      type: Schema.Literal("resolveGate"),
      cardId: Schema.String,
      outcome: Schema.String,
      note: Schema.optionalKey(Schema.String),
    }),
  ]),
});
export type CrewRunControlInput = typeof CrewRunControlInput.Type;

export const CrewRunListInput = Schema.Struct({
  projectId: ProjectId,
  status: Schema.optionalKey(CrewRunStatus),
});
export type CrewRunListInput = typeof CrewRunListInput.Type;

/** How a `crew_*` tool refuses a call. The message says what would be accepted. */
export class CrewMcpFailure extends Schema.TaggedError<CrewMcpFailure>()("CrewMcpFailure", {
  code: Schema.Literals([
    "not_a_crew_card",
    "not_allowed",
    "invalid_report",
    "not_found",
    "unavailable",
  ]),
  message: Schema.String,
}) {}

export const CrewReportInput = Schema.Struct({
  outcome: Schema.String,
  summary: Schema.String,
  artifacts: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type CrewReportInput = typeof CrewReportInput.Type;

const Named = Schema.Struct({
  name: Schema.String,
  source: Source,
  description: Schema.optionalKey(Schema.String),
});

export const CrewCardContext = Schema.Struct({
  runId: Schema.String,
  crewId: Schema.String,
  cardId: Schema.String,
  role: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
  step: Schema.Struct({ id: Schema.String, type: Schema.String }),
  visit: Schema.Number,
  attempt: Schema.Number,
  inputs: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Boolean])),
  branch: Schema.NullOr(Schema.String),
  outcomes: Schema.Array(Schema.String),
  produces: Schema.Array(Schema.String),
  artifacts: Schema.Array(Schema.String),
  skills: Schema.Array(Named),
  tools: Schema.Array(Named),
  mcpServers: Schema.Array(Named),
  owns: Schema.Array(Schema.String),
  teammates: Schema.Array(
    Schema.Struct({
      cardId: Schema.String,
      stepId: Schema.String,
      roleId: Schema.NullOr(Schema.String),
      state: Schema.String,
    }),
  ),
});
export type CrewCardContext = typeof CrewCardContext.Type;

export const CrewSkillResult = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  content: Schema.String,
  // Set when the skill changed on disk after the run froze its toolbox.
  warning: Schema.optionalKey(Schema.String),
});
export type CrewSkillResult = typeof CrewSkillResult.Type;

export const CrewNoteInput = Schema.Struct({
  toRole: Schema.optionalKey(Schema.String),
  toCard: Schema.optionalKey(Schema.String),
  text: Schema.String.check(Schema.isMinLength(1)),
});
export type CrewNoteInput = typeof CrewNoteInput.Type;

export const CrewValidateResult = Schema.Struct({ diagnostics: Schema.Array(CrewDiagnostic) });
