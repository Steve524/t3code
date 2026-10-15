/**
 * CrewRunService - runs a crew. Every change to a run goes one way: an input
 * event is stepped through the pure engine, and the event, the rows it changed
 * and the effects it asked for commit together. Effects run after that commit
 * and report back as new input events.
 *
 * Roles are ordinary threads. A thread's finished turn is what moves its card.
 *
 * @module CrewRunService
 */
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Hex from "effect/encoding/Hex";
import * as SqlClient from "effect/sql/SqlClient";

import { makeDrainableWorker, type DrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveProjectSettings, resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";

import type {
  CrewDiagnostic,
  CrewFile,
} from "../../../../../packages/contracts/src/fork/crews/crewFile.ts";
import { ForkCrewsError } from "../../../../../packages/contracts/src/fork/crews/crewRpc.ts";
import {
  CrewMcpFailure,
  type CrewCardContext,
  type CrewDecideInput,
  type CrewMcpCallInput,
  type CrewMcpCallResult,
  type CrewMcpToolList,
  type CrewNoteInput,
  type CrewReportInput,
  type CrewRunListInput,
  type CrewRunStartInput,
  type CrewRunStartResult,
  type CrewRunSummary,
  type CrewRunToolbox,
  type CrewRunView,
  type CrewSkillResult,
  type CrewToolRunInput,
  type CrewToolRunResult,
} from "../../../../../packages/contracts/src/fork/crews/crewRun.ts";
import { compileCrewFlow } from "../../../../../packages/shared/src/fork/crews/compileCrewFlow.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "../../workspace/workspaceLease.ts";
import * as CrewCatalog from "./CrewCatalog.ts";
import {
  crewCardBranch,
  crewCardOwns,
  crewCommitMessage,
  crewOwnershipViolations,
  crewWorktreeForBranch,
  isPlainToolArgument,
} from "./crewGit.ts";
import {
  composeCrewCardPrompt,
  composeCrewConflictPrompt,
  composeCrewLeadKickoff,
  crewDecisionPrompt,
  crewLeadUpdatePrompt,
  crewPromptFiles,
  crewReminderPrompt,
} from "./CrewPromptComposer.ts";
import {
  crewArtifactErrors,
  crewReportErrors,
  crewStepOutcomes,
  crewStepProduces,
  parseCrewDecisionBlock,
  parseCrewReportBlock,
} from "./crewReport.ts";
import {
  crewCardModel,
  makeCrewRunStore,
  type CrewCardWorkspace,
  type CrewRunRecord,
  type CrewRunRole,
} from "./CrewRunStore.ts";
import { buildCrewRunView } from "./crewRunView.ts";
import { createCrewSnapshot, crewCardLine, crewDecisionOutcomes, decide } from "./engine/decide.ts";
import type { BudgetKind, CrewCard, CrewEffect, CrewEvent } from "./engine/types.ts";
import * as CrewMcpGateway from "./mcp/CrewMcpGateway.ts";
import { crewMcpDelivery } from "./mcp/crewMcpDelivery.ts";

export class CrewRunService extends Context.Service<
  CrewRunService,
  {
    /** Starts a run and its home thread. The same `clientRequestId` returns the same run. */
    readonly start: (input: CrewRunStartInput) => Effect.Effect<CrewRunStartResult, ForkCrewsError>;
    /** The board, with each role's frozen toolbox. */
    readonly get: (runId: string) => Effect.Effect<CrewRunView, ForkCrewsError>;
    readonly list: (
      input: CrewRunListInput,
    ) => Effect.Effect<ReadonlyArray<CrewRunSummary>, ForkCrewsError>;
    /** The board now, then again after every change to the run. */
    readonly subscribe: (runId: string) => Stream.Stream<CrewRunView, ForkCrewsError>;
    /** `subscribe` for the run a thread works for; one null for any other thread. */
    readonly subscribeByThread: (
      threadId: ThreadId,
    ) => Stream.Stream<CrewRunView | null, ForkCrewsError>;
    /** Stops dispatching; cards already running finish. */
    readonly pause: (runId: string) => Effect.Effect<void, ForkCrewsError>;
    readonly resume: (runId: string) => Effect.Effect<void, ForkCrewsError>;
    /** Stops every running card's thread and ends the run. */
    readonly cancel: (runId: string) => Effect.Effect<void, ForkCrewsError>;
    /** The user's answer to an open gate or decision card. */
    readonly resolveGate: (input: {
      readonly runId: string;
      readonly cardId: string;
      readonly outcome: string;
      readonly note?: string | undefined;
    }) => Effect.Effect<void, ForkCrewsError>;
    /** A new attempt of a card that is waiting, in its own thread when it has one. */
    readonly retryCard: (input: CardTarget) => Effect.Effect<void, ForkCrewsError>;
    readonly stopCard: (input: CardTarget) => Effect.Effect<void, ForkCrewsError>;
    /** The card's step carries on as if it had reported `skipped`. */
    readonly skipCard: (input: CardTarget) => Effect.Effect<void, ForkCrewsError>;
    /** Treats a waiting card as having reported `outcome`. */
    readonly forceOutcome: (
      input: CardTarget & { readonly outcome: string },
    ) => Effect.Effect<void, ForkCrewsError>;
    /** The model for the role's cards dispatched from now on. Running cards keep theirs. */
    readonly setRoleModel: (input: {
      readonly runId: string;
      readonly roleId: string;
      readonly selection: ModelSelection;
    }) => Effect.Effect<void, ForkCrewsError>;
    /** Gives a limited route its send-backs back. */
    readonly resetRoute: (input: {
      readonly runId: string;
      readonly routeId: string;
    }) => Effect.Effect<void, ForkCrewsError>;
    /** Raises a budget for this run only. Dispatch resumes if that budget's gate was open. */
    readonly extendBudget: (input: {
      readonly runId: string;
      readonly kind: BudgetKind;
      readonly by: number;
    }) => Effect.Effect<void, ForkCrewsError>;
    /** Answers the gate of a fan-out larger than the run allows: every item, the first few, or stop. */
    readonly selectFanout: (input: {
      readonly runId: string;
      readonly choice: "all" | "first" | "stop";
      readonly count?: number | undefined;
    }) => Effect.Effect<void, ForkCrewsError>;

    // What a role's thread may do, keyed by the calling thread. A thread that is not working
    // for a run is refused with `not_a_crew_card`.
    readonly context: (threadId: ThreadId) => Effect.Effect<CrewCardContext, CrewMcpFailure>;
    /** Records the card's result. The last report of a turn wins; it takes effect at turn end. */
    readonly report: (
      threadId: ThreadId,
      input: CrewReportInput,
    ) => Effect.Effect<{ readonly recorded: true; readonly outcome: string }, CrewMcpFailure>;
    /** The lead's answer to a decision it was asked for. Only the home thread of a lead run may. */
    readonly decide: (
      threadId: ThreadId,
      input: CrewDecideInput,
    ) => Effect.Effect<{ readonly decided: true; readonly outcome: string }, CrewMcpFailure>;
    readonly readArtifact: (
      threadId: ThreadId,
      name: string,
    ) => Effect.Effect<{ readonly name: string; readonly value: unknown }, CrewMcpFailure>;
    /** Hands over an artifact the step produces, ahead of the report. */
    readonly writeArtifact: (
      threadId: ThreadId,
      input: { readonly name: string; readonly value: unknown },
    ) => Effect.Effect<{ readonly written: true }, CrewMcpFailure>;
    /** A skill in the role's frozen toolbox, or a file inside its folder. */
    readonly getSkill: (
      threadId: ThreadId,
      input: { readonly name: string; readonly file?: string | undefined },
    ) => Effect.Effect<CrewSkillResult, CrewMcpFailure>;
    /** Leaves a note that the addressed role or card reads in its next prompt. */
    readonly note: (
      threadId: ThreadId,
      input: CrewNoteInput,
    ) => Effect.Effect<{ readonly noteId: string }, CrewMcpFailure>;
    readonly validate: (
      threadId: ThreadId,
      input: { readonly text: string; readonly kind?: "crew" | "toolbox" | undefined },
    ) => Effect.Effect<{ readonly diagnostics: ReadonlyArray<CrewDiagnostic> }, CrewMcpFailure>;
    /** The tools in the role's frozen toolbox. */
    readonly listTools: (
      threadId: ThreadId,
    ) => Effect.Effect<{ readonly tools: CrewRunToolbox["tools"] }, CrewMcpFailure>;
    /** Runs one of those tools in the card's checkout, up to the tool's timeout. */
    readonly runTool: (
      threadId: ThreadId,
      input: CrewToolRunInput,
    ) => Effect.Effect<CrewToolRunResult, CrewMcpFailure>;
    /** The tools of an MCP server in the role's frozen toolbox, through the crew's gateway. */
    readonly mcpListTools: (
      threadId: ThreadId,
      server: string,
    ) => Effect.Effect<CrewMcpToolList, CrewMcpFailure>;
    /** Calls one tool of such a server through the gateway. */
    readonly mcpCall: (
      threadId: ThreadId,
      input: CrewMcpCallInput,
    ) => Effect.Effect<CrewMcpCallResult, CrewMcpFailure>;

    /** Resolves once every queued effect and finished turn has been handled. For tests. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/fork/crews/CrewRunService") {}

/**
 * How long one minute of a crew's `home.decisionTimeoutMinutes` lasts. Tests shorten it, so
 * they wait on the escalation and not on the clock.
 */
export const CrewDecisionMinute = Context.Reference<Duration.Duration>(
  "t3/fork/crews/CrewDecisionMinute",
  { defaultValue: () => Duration.minutes(1) },
);

/** A card as the board names it, or by the engine's run-local id. */
interface CardTarget {
  readonly runId: string;
  readonly cardId: string;
}

/** An engine input as callers give it; the service numbers and times it. */
type CrewInput = CrewEvent extends infer Event
  ? Event extends unknown
    ? Omit<Event, "seq" | "at">
    : never
  : never;

type Work =
  | { readonly effectId: string }
  | {
      readonly threadId: ThreadId;
      readonly orchestrationRunId: RunId;
      readonly status: ThreadManagementService.ThreadManagementTerminalRunStatus;
    };

/** A card whose turn can still report. */
const LIVE_STATES: ReadonlySet<CrewCard["state"]> = new Set(["dispatching", "working", "reported"]);
/** A card the user may retry, skip or force: not running, and not yet routed on. */
const WAITING_STATES: ReadonlySet<CrewCard["state"]> = new Set(["queued", "blocked", "needs_you"]);
/**
 * What the home thread is indexed under while the lead is on a turn that is no card's. A step
 * id starts with a letter, so no card is named this.
 */
const LEAD_TURN = "@lead";
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/u;
/** A script or tool with no timeout of its own is stopped after this long. */
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 600;
/** How much of a command's output a card keeps. */
const COMMAND_OUTPUT_TAIL = 8192;

const isForkCrewsError = Schema.is(ForkCrewsError);
/** What a run's crew hash covers: the crew and every file its prompts read. */
const crewHashInput = (crew: CrewFile, files: Readonly<Record<string, string>>) =>
  JSON.stringify({ crew, files });
const unavailable = (cause: unknown) => new ForkCrewsError({ reason: "unavailable", cause });
const refused = (code: CrewMcpFailure["code"], message: string) =>
  new CrewMcpFailure({ code, message });
const toolUnavailable = () => refused("unavailable", "The crew run could not be read.");
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
/** Git or a command failed; the detail says how, since the card shows it. */
const failed = (runId: string, cause: unknown) =>
  new ForkCrewsError({ reason: "unavailable", runId, detail: message(cause), cause });
const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
const localCardId = (runId: string, cardId: string) =>
  cardId.startsWith(`${runId}:`) ? cardId.slice(runId.length + 1) : cardId;

/** The conflicted paths a resolver card was created for. */
function conflictPaths(card: CrewCard | undefined): ReadonlyArray<string> {
  const item: unknown = card?.item;
  return typeof item === "object" && item !== null && "paths" in item && Array.isArray(item.paths)
    ? item.paths.filter((entry): entry is string => typeof entry === "string")
    : [];
}

// shortcut: reads a one-line `description:` only; parse the frontmatter as YAML if skills start folding it.
const skillDescription = (text: string) =>
  /^description:[ \t]*(.+)$/mu
    .exec(FRONTMATTER.exec(text)?.[1] ?? "")?.[1]
    ?.trim()
    .replace(/^["']|["']$/gu, "") ?? "";

/** The run's inputs with the crew's defaults, or why they cannot be used. */
function resolveInputs(crew: CrewFile, given: CrewRunStartInput["inputs"]) {
  const inputs: Record<string, string | boolean> = {};
  for (const [name, spec] of Object.entries(crew.inputs ?? {})) {
    const value = Object.hasOwn(given, name) ? given[name] : spec.default;
    if (value === undefined) {
      if (spec.required === true) return `Input "${name}" is required.`;
      continue;
    }
    if (typeof value !== (spec.type === "boolean" ? "boolean" : "string")) {
      return `Input "${name}" must be a ${spec.type === "boolean" ? "boolean" : "string"}.`;
    }
    if (spec.type === "enum" && !spec.values.includes(String(value))) {
      return `Input "${name}" must be one of: ${spec.values.join(", ")}.`;
    }
    inputs[name] = value;
  }
  return inputs;
}

function interactionMode(crew: CrewFile, card: CrewCard): ProviderInteractionMode {
  const step = crew.flow.steps[card.stepId];
  const role = card.roleId === null ? undefined : crew.roles[card.roleId];
  const mode =
    step?.interactionMode ?? role?.interactionMode ?? crew.defaults?.interactionMode ?? "inherit";
  return mode === "plan" ? "plan" : "default";
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const catalog = yield* CrewCatalog.CrewCatalog;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const vcs = yield* GitVcsDriver.GitVcsDriver;
  const processes = yield* ProcessRunner.ProcessRunner;
  const projects = yield* ProjectService.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const platform = yield* HostProcess.Platform;
  const gateway = yield* CrewMcpGateway.CrewMcpGateway;
  const decisionMinute = yield* CrewDecisionMinute;
  const scope = yield* Effect.scope;
  const store = makeCrewRunStore(sql);
  // shortcut: one lock for every run; give each run its own when concurrent runs wait on each other.
  const lock = yield* Semaphore.make(1);
  // shortcut: subscribers get the whole board per change; send card deltas if boards grow large.
  const changes = yield* PubSub.unbounded<string>();

  const sha256 = (text: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(text))
      .pipe(Effect.map(Hex.encode), Effect.orDie);

  const timestamp = Effect.map(DateTime.now, (now) => ({
    millis: DateTime.toEpochMillis(now),
    iso: DateTime.formatIso(now),
  }));

  const loadRun = (runId: string) =>
    store.getRun(runId).pipe(
      Effect.mapError(unavailable),
      Effect.flatMap((run) =>
        run === null
          ? Effect.fail(new ForkCrewsError({ reason: "run_not_found", runId }))
          : Effect.succeed(run),
      ),
    );

  /** Steps the engine with one input and records the result. Run it inside `transact`. */
  const decideAndCommit = Effect.fn("CrewRunService.decideAndCommit")(function* (
    runId: string,
    input: CrewInput,
  ) {
    const run = yield* loadRun(runId);
    const now = yield* timestamp;
    const event: CrewEvent = {
      ...input,
      seq: run.snapshot.lastEventSeq + 1,
      at: Math.max(now.millis, run.snapshot.lastEventAt ?? 0),
    };
    const decided = yield* Effect.try({
      try: () => decide(run.snapshot, event),
      catch: (cause) =>
        new ForkCrewsError({ reason: "invalid_request", runId, detail: message(cause) }),
    });
    // A finished run takes no more input, so there is nothing to record.
    if (decided.snapshot === run.snapshot) return [];
    return yield* store.commit({ run, event, ...decided, at: now.iso });
  });

  /** One run change at a time, with everything it writes in one transaction. */
  const transact = <A, E>(effect: Effect.Effect<A, E>) =>
    lock.withPermits(1)(
      sql
        .withTransaction(effect)
        .pipe(Effect.mapError((error) => (isForkCrewsError(error) ? error : unavailable(error)))),
    );

  const committed = (runId: string, effectIds: ReadonlyArray<string>) =>
    PubSub.publish(changes, runId).pipe(
      Effect.andThen(
        Effect.forEach(effectIds, (effectId) => worker.enqueue({ effectId }), { discard: true }),
      ),
    );

  const apply = (runId: string, input: CrewInput) =>
    transact(decideAndCommit(runId, input)).pipe(
      Effect.tap((effectIds) => committed(runId, effectIds)),
      Effect.asVoid,
    );

  /** The card an effect was issued for, while it still waits on that effect. */
  const dispatchingCard = (
    run: CrewRunRecord,
    effect: { readonly cardId: string; readonly attempt: number },
  ) =>
    run.snapshot.cards.find(
      (card) =>
        card.id === effect.cardId &&
        card.attempt === effect.attempt &&
        card.state === "dispatching",
    );

  const git = (runId: string, cwd: string, args: ReadonlyArray<string>, allowNonZeroExit = false) =>
    vcs
      .execute({ operation: "CrewRunService.git", cwd, args, allowNonZeroExit })
      .pipe(Effect.mapError((cause) => failed(runId, cause)));

  const projectRoot = (run: CrewRunRecord) =>
    projects.getById(run.projectId).pipe(
      Effect.mapError(unavailable),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new ForkCrewsError({ reason: "project_not_found", projectId: run.projectId }),
            ),
          onSome: (project) => Effect.succeed(project.workspaceRoot),
        }),
      ),
    );

  /** The checkout every shared card works in: the home thread's worktree, else the project's own. */
  const integrationCwd = Effect.fn("CrewRunService.integrationCwd")(function* (run: CrewRunRecord) {
    if (run.integrationWorktree !== null) return run.integrationWorktree;
    // A home worktree is made after its launch returns, so the thread knows it before the run does.
    const home =
      run.homeThreadId === null
        ? null
        : yield* threads.getThreadShell(run.homeThreadId).pipe(Effect.mapError(unavailable));
    return home?.worktreePath ?? (yield* projectRoot(run));
  });

  /** Where a card works: its own worktree when it has one. */
  const cardCwd = (run: CrewRunRecord, cardId: string) =>
    store.listCardWorkspaces(run.runId).pipe(
      Effect.mapError(unavailable),
      Effect.flatMap((workspaces) => {
        const own = workspaces.find((workspace) => workspace.cardId === cardId);
        return own === undefined ? integrationCwd(run) : Effect.succeed(own.worktreePath);
      }),
    );

  /** Commits whatever the checkout holds under the card's name. A clean checkout is left alone. */
  const commitWorkspace = Effect.fn("CrewRunService.commitWorkspace")(function* (
    run: CrewRunRecord,
    card: CrewCard,
    cwd: string,
    summary: string | null,
  ) {
    const step = run.crew.flow.steps[card.stepId];
    if ((step?.autoCommit ?? run.crew.defaults?.autoCommit) === false) return;
    // A project that is not a repository still runs crews whose cards share its folder.
    const status = yield* git(run.runId, cwd, ["status", "--porcelain"], true);
    if (status.exitCode !== 0 || status.stdout.trim().length === 0) return;
    yield* git(run.runId, cwd, ["add", "-A"]);
    const [subject, trailers] = crewCommitMessage({
      runId: run.runId,
      card,
      model: crewCardModel(run, card),
      summary,
    });
    // Hooks are skipped: a failing lint hook must not strand a card's work outside its branch.
    yield* git(run.runId, cwd, ["commit", "--no-verify", "-m", subject, "-m", trailers]);
  });

  /** Card branches holding finished work the integration branch lacks, in the order they finished. */
  const pendingBranches = Effect.fn("CrewRunService.pendingBranches")(function* (
    run: CrewRunRecord,
    cwd: string,
  ) {
    const workspaces = yield* store
      .listCardWorkspaces(run.runId)
      .pipe(Effect.mapError(unavailable));
    const done = new Set(
      run.snapshot.cards.filter((card) => card.state === "done").map((card) => card.id),
    );
    const pending: Array<CrewCardWorkspace & { readonly baseSha: string }> = [];
    for (const workspace of workspaces) {
      // The card that created a worktree stands for every card that later worked in it.
      const { baseSha, branch } = workspace;
      if (
        baseSha === null ||
        !workspaces.some((other) => other.branch === branch && done.has(other.cardId))
      ) {
        continue;
      }
      const merged = yield* git(
        run.runId,
        cwd,
        ["merge-base", "--is-ancestor", branch, "HEAD"],
        true,
      );
      if (merged.exitCode !== 0) pending.push({ ...workspace, baseSha });
    }
    return pending;
  });

  /** Runs a shell command line in a checkout and keeps the end of what it printed. */
  // shortcut: on Windows the line reaches cmd.exe through Node's argument quoting, so a command with double quotes in it may not parse; spawn with `shell: true` when a tool needs them.
  const shell = (cwd: string, command: string, timeoutSeconds: number) =>
    processes
      .run({
        command: platform === "win32" ? "cmd.exe" : "sh",
        args: platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command],
        cwd,
        timeout: Duration.seconds(timeoutSeconds),
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.map((result) => ({
          exitCode: result.timedOut || result.code === null ? null : Number(result.code),
          timedOut: result.timedOut,
          output: `${result.stdout}${result.stderr}`.slice(-COMMAND_OUTPUT_TAIL),
        })),
      );

  const promptFor = Effect.fn("CrewRunService.promptFor")(function* (
    run: CrewRunRecord,
    card: CrewCard,
    branch: string | null,
  ) {
    const now = yield* timestamp;
    const notes = yield* store
      .takeNotes(run.runId, card.roleId, card.id, now.iso)
      .pipe(Effect.mapError(unavailable));
    const { snapshot } = run;
    // Later cards overwrite earlier ones, which leaves each step's latest result.
    const steps = Object.fromEntries(
      snapshot.cards
        .filter((other) => other.type !== "decision" && other.outcome !== null)
        .map((other) => [
          other.stepId,
          { summary: other.report?.summary ?? other.note ?? "", outcome: other.outcome },
        ]),
    );
    return composeCrewCardPrompt({
      crew: run.crew,
      files: run.files,
      stepId: card.stepId,
      inputs: run.inputs,
      artifacts: snapshot.artifacts,
      steps,
      previousSteps: [
        ...new Set(
          snapshot.flow.edges
            .filter((edge) => edge.to === card.stepId && edge.kind !== "branch")
            .map((edge) => edge.from),
        ),
      ],
      item: card.item,
      branch,
      driver: card.roleId === null ? null : (run.roles[card.roleId]?.driver ?? null),
      toolbox: (card.roleId === null ? undefined : run.toolboxes[card.roleId]) ?? {
        skills: [],
        mcp: [],
        tools: [],
      },
      notes,
    });
  });

  /** What an agent ended a turn with. */
  const finalText = (threadId: ThreadId, orchestrationRunId: RunId) =>
    threads
      .getThreadRecords(threadId, ["messages", "turnItems"], {
        messageRoles: ["assistant"],
        messageRunIds: [orchestrationRunId],
        turnItemRunIds: [orchestrationRunId],
        turnItemTypes: ["assistant_message"],
      })
      .pipe(
        Effect.mapError(unavailable),
        // Not every provider records its answer as a message; all record it as a turn item.
        Effect.map(({ messages, turnItems }) => {
          const item = turnItems.at(-1);
          return messages.at(-1)?.text ?? (item?.type === "assistant_message" ? item.text : "");
        }),
      );

  /** One of the crew's own turns in the home thread ended. A decision may be in its last message. */
  const leadTurnFinished = Effect.fn("CrewRunService.leadTurnFinished")(function* (
    runId: string,
    turnId: number,
    work: Extract<Work, { readonly threadId: ThreadId }>,
  ) {
    const run = yield* loadRun(runId);
    const turn = run.snapshot.lead?.turn;
    if (turn?.id !== turnId) return;
    if (
      turn.cardId !== null &&
      run.snapshot.cards.find((card) => card.id === turn.cardId)?.state === "waiting_lead"
    ) {
      const block = parseCrewDecisionBlock(
        yield* finalText(work.threadId, work.orchestrationRunId),
      );
      // A block that is refused is no answer; the reminder says what is allowed.
      if (block !== null && localCardId(runId, block.decisionId) === turn.cardId) {
        yield* Effect.ignore(answerDecision(work.threadId, block));
      }
    }
    yield* apply(runId, { type: "lead.turn_finished", turnId });
  });

  /** A role's turn ended. Its report, or the block it ended with, decides the card. */
  const turnFinished = Effect.fn("CrewRunService.turnFinished")(function* (
    work: Extract<Work, { readonly threadId: ThreadId }>,
  ) {
    const entry = yield* store.findThread(work.threadId).pipe(Effect.mapError(unavailable));
    // Any other thread's turn, or an earlier turn of this one.
    if (entry === null || entry.orchestrationRunId !== work.orchestrationRunId) return;
    if (entry.cardId === LEAD_TURN)
      return yield* leadTurnFinished(entry.runId, entry.attempt, work);
    const run = yield* loadRun(entry.runId);
    const card = run.snapshot.cards.find((candidate) => candidate.id === entry.cardId);
    // A turn whose end was already handled; it is reported twice when it ends during dispatch.
    if (
      card === undefined ||
      card.attempt !== entry.attempt ||
      !(LIVE_STATES.has(card.state) || card.state === "stopping")
    ) {
      return;
    }
    let summary = card.report?.summary ?? null;
    if (card.report === null && card.state !== "stopping") {
      const block = parseCrewReportBlock(yield* finalText(work.threadId, work.orchestrationRunId));
      if (block !== null) {
        const written = yield* store
          .artifactsWrittenBy(run.runId, card.id)
          .pipe(Effect.mapError(unavailable));
        const report = { ...block, artifacts: { ...written, ...block.artifacts } };
        // A block that does not validate is no report; the reminder says what is allowed.
        if (crewReportErrors(run.crew, card.stepId, report).length === 0) {
          summary = report.summary;
          yield* apply(run.runId, {
            type: "card.reported",
            cardId: card.id,
            attempt: card.attempt,
            ...report,
          });
        }
      }
    }
    // The turn's work is committed before the card moves, so what follows starts from it. A
    // conflict resolver's work is the merge's to check and commit.
    if (
      card.state !== "stopping" &&
      card.roleId !== null &&
      card.isolation !== "read-only" &&
      card.sourceCardId === null
    ) {
      const kept = yield* Effect.exit(
        Effect.flatMap(cardCwd(run, card.id), (cwd) => commitWorkspace(run, card, cwd, summary)),
      );
      if (Exit.isFailure(kept)) {
        yield* apply(run.runId, {
          type: "card.failed",
          cardId: card.id,
          attempt: card.attempt,
          reason: `The card's work could not be committed. ${message(Cause.squash(kept.cause))}`,
        });
        return;
      }
    }
    yield* apply(run.runId, {
      type: "card.turn_finished",
      cardId: card.id,
      attempt: card.attempt,
      status: work.status === "rolled_back" ? "cancelled" : work.status,
    });
  });

  /** Records the turn a thread's index entry waits on, then catches a turn that already ended. */
  const watchTurn = Effect.fn("CrewRunService.watchTurn")(function* (
    threadId: ThreadId,
    orchestrationRunId: RunId,
  ) {
    yield* store.setThreadTurn(threadId, orchestrationRunId).pipe(Effect.mapError(unavailable));
    yield* catchEndedTurn(threadId, orchestrationRunId);
  });

  /** Handles a turn that ended before its index entry named it. */
  const catchEndedTurn = Effect.fn("CrewRunService.catchEndedTurn")(function* (
    threadId: ThreadId,
    orchestrationRunId: RunId,
  ) {
    // Until the turn was recorded, its end matched nothing and was dropped.
    const { runs } = yield* threads
      .getThreadRecords(threadId, ["runs"], { runIds: [orchestrationRunId] })
      .pipe(Effect.mapError(unavailable));
    const status = runs[0]?.status;
    if (status !== undefined && ThreadManagementService.isTerminalRunStatus(status)) {
      yield* turnFinished({ threadId, orchestrationRunId, status });
    }
  });

  /** Records the turn a card now waits on. */
  const dispatched = Effect.fn("CrewRunService.dispatched")(function* (
    run: CrewRunRecord,
    card: CrewCard,
    threadId: ThreadId,
    orchestrationRunId: RunId,
  ) {
    // Recorded together: a restart that finds the card dispatched also finds the turn it waits on.
    const effectIds = yield* transact(
      decideAndCommit(run.runId, {
        type: "card.dispatched",
        cardId: card.id,
        attempt: card.attempt,
        threadId,
        orchestrationRunId,
      }).pipe(Effect.tap(() => store.setThreadTurn(threadId, orchestrationRunId))),
    );
    yield* committed(run.runId, effectIds);
    yield* catchEndedTurn(threadId, orchestrationRunId);
  });

  /** Launches a thread on its first message and returns the turn that answers it. */
  const launchTurn = Effect.fn("CrewRunService.launchTurn")(function* (
    runId: string,
    input: ThreadLaunchService.ThreadLaunchInput,
  ) {
    const launched = yield* launches
      .launch(input)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ForkCrewsError({ reason: "launch_failed", runId, detail: cause.message, cause }),
        ),
      );
    const turn = launched.projection.runs.find(
      (candidate) => candidate.userMessageId === input.initialMessage?.messageId,
    );
    if (turn === undefined) {
      return yield* new ForkCrewsError({
        reason: "launch_failed",
        runId,
        detail: "The thread was created without a turn for its first message.",
      });
    }
    return { thread: launched.projection.thread, turnId: turn.id };
  });

  /** Queues one of the crew's messages in a thread and returns the turn that will answer it. */
  const sendTurn = (run: CrewRunRecord, threadId: ThreadId, key: string, text: string) =>
    threads
      .sendToThread({
        projectId: run.projectId,
        // Derived from what the message is for, so a retried effect sends it once.
        commandId: CommandId.make(`crew:${run.runId}:${key}:send`),
        threadId,
        messageId: MessageId.make(`message:${run.runId}:${key}`),
        text,
        attachments: [],
        mode: "queue",
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(
        Effect.map((sent) => sent.run.id),
        Effect.mapError(
          (cause) =>
            new ForkCrewsError({
              reason: "launch_failed",
              runId: run.runId,
              detail: cause.message,
              cause,
            }),
        ),
      );

  const launchCard = Effect.fn("CrewRunService.launchCard")(function* (
    runId: string,
    effect: Extract<CrewEffect, { readonly type: "launch_card" }>,
  ) {
    const run = yield* loadRun(runId);
    const card = dispatchingCard(run, effect);
    const role = card === undefined || card.roleId === null ? undefined : run.roles[card.roleId];
    const modelSelection = card === undefined ? null : crewCardModel(run, card);
    if (card === undefined || role === undefined || modelSelection === null) return;
    const { homeThreadId } = run;
    // The lead's own steps are follow-ups in the home thread, which holds its context.
    if (run.snapshot.lead?.roleId === card.roleId && homeThreadId !== null) {
      return yield* followUp(runId, {
        ...effect,
        type: "send_follow_up",
        threadId: homeThreadId,
        reason: "continue",
      });
    }
    const threadId = ThreadId.make(`thread:${runId}:${card.id}:${card.attempt}`);
    // The first thread a first-step run launches is the one the user sent from.
    const isHome = homeThreadId === null;
    const home =
      homeThreadId === null
        ? null
        : yield* threads.getThreadShell(homeThreadId).pipe(Effect.mapError(unavailable));
    if (!isHome && home === null) {
      return yield* new ForkCrewsError({
        reason: "launch_failed",
        runId,
        detail: "The run's home thread no longer exists.",
      });
    }
    const brief = Object.values(run.inputs).find((value) => typeof value === "string");
    const workspace = run.start.workspace;
    let branch = home === null ? run.integrationBranch : home.branch;
    let workspaceStrategy: ThreadLaunchService.ThreadLaunchWorkspaceStrategy =
      home === null
        ? workspace.mode === "new-worktree" && branch !== null
          ? { type: "worktree", baseRef: workspace.baseRef, branch, startFromOrigin: false }
          : { type: "root" }
        : home.worktreePath === null
          ? { type: "root", branch: home.branch ?? undefined }
          : {
              type: "existing_worktree",
              worktreePath: home.worktreePath,
              branch: home.branch ?? undefined,
            };
    if (card.isolation === "worktree" && !isHome) {
      const cwd = yield* integrationCwd(run);
      // The card branches from committed state, so it starts with all the earlier steps left.
      yield* commitWorkspace(run, card, cwd, null);
      const baseSha = (yield* git(runId, cwd, ["rev-parse", "HEAD"])).stdout.trim();
      branch = crewCardBranch(runId, card);
      const made = (yield* store.listCardWorkspaces(runId).pipe(Effect.mapError(unavailable))).find(
        (workspace) => workspace.cardId === card.id && workspace.branch === branch,
      );
      // Made here, not by the launch: a launch returns before its worktree exists, and the card's
      // tools and commit need the path. A launch cut off before it recorded the worktree finds it.
      // shortcut: a retried card's earlier worktree is not tracked, so it is never removed; list them per attempt when retries of worktree cards are common.
      const root = yield* projectRoot(run);
      const worktreePath =
        made?.worktreePath ??
        crewWorktreeForBranch(
          (yield* git(runId, root, ["worktree", "list", "--porcelain"])).stdout,
          branch,
        ) ??
        (yield* vcs
          .createWorktree({
            cwd: root,
            refName: baseSha,
            newRefName: branch,
            baseRefName: baseSha,
            path: null,
          })
          .pipe(Effect.mapError((cause) => failed(runId, cause)))).worktree.path;
      yield* store
        .setCardWorkspace(runId, {
          cardId: card.id,
          worktreePath,
          branch,
          baseSha,
          owns: crewCardOwns(run.crew, card),
        })
        .pipe(Effect.mapError(unavailable));
      workspaceStrategy = { type: "existing_worktree", worktreePath, branch };
    }
    // A read-only card reads the shared checkout. Providers differ in how far plan mode holds.
    const readOnly = card.isolation === "read-only";
    const text =
      card.sourceCardId === null
        ? yield* promptFor(run, card, branch)
        : composeCrewConflictPrompt({
            crew: run.crew,
            files: run.files,
            roleId: card.roleId ?? "",
            driver: role.driver,
            branch,
            paths: conflictPaths(card),
          });
    const item = card.itemIndex === null ? "" : ` #${card.itemIndex + 1}`;
    // The thread's turn can call a crew tool before `launch` returns, so it is known first.
    yield* store.indexThread(threadId, { runId, cardId: card.id, attempt: card.attempt }).pipe(
      Effect.andThen(
        store.setHome(runId, {
          threadId: homeThreadId ?? threadId,
          worktree: home?.worktreePath ?? null,
          // The home thread's branch, not the one a worktree card was just given.
          branch: home === null ? branch : home.branch,
        }),
      ),
      Effect.mapError(unavailable),
    );
    const messageId = MessageId.make(`message:${runId}:${card.id}:${card.attempt}`);
    const { thread, turnId } = yield* launchTurn(runId, {
      // Derived from the card and attempt, so a retried effect resumes this launch.
      commandId: CommandId.make(`crew:${runId}:${card.id}:${card.attempt}:launch`),
      threadId,
      projectId: run.projectId,
      title: `${run.crew.name}: ${isHome && brief !== undefined ? brief : `${role.name}${item}`}`
        .replaceAll(/\s+/gu, " ")
        .slice(0, 80),
      modelSelection,
      runtimeMode: readOnly ? "approval-required" : role.runtimeMode,
      interactionMode: readOnly ? "plan" : interactionMode(run.crew, card),
      workspaceStrategy,
      initialMessage: { messageId, text, attachments: isHome ? run.start.attachments : [] },
      createdBy: isHome ? "user" : "system",
      creationSource: isHome ? "web" : "server",
    });
    if (isHome) {
      yield* store
        .setHome(runId, { threadId, worktree: thread.worktreePath, branch: thread.branch })
        .pipe(Effect.mapError(unavailable));
    }
    yield* dispatched(run, card, threadId, turnId);
  });

  /** Starts the home thread on the lead's kickoff. The flow's first step waits for that turn's end. */
  const launchLead = Effect.fn("CrewRunService.launchLead")(function* (
    runId: string,
    turnId: number,
  ) {
    const run = yield* loadRun(runId);
    const lead = run.snapshot.lead;
    const role = lead ? run.roles[lead.roleId] : undefined;
    if (!lead || lead.turn?.id !== turnId || role === undefined) return;
    const threadId = ThreadId.make(`thread:${runId}:lead`);
    const brief = Object.values(run.inputs).find((value) => typeof value === "string");
    const workspace = run.start.workspace;
    const branch = run.integrationBranch;
    const definition = run.crew.roles[lead.roleId];
    const plans =
      (definition?.interactionMode ?? run.crew.defaults?.interactionMode ?? "inherit") === "plan";
    // The kickoff turn can call a crew tool before `launch` returns, so the thread is known first.
    yield* store
      .indexThread(threadId, { runId, cardId: LEAD_TURN, attempt: turnId })
      .pipe(
        Effect.andThen(store.setHome(runId, { threadId, worktree: null, branch })),
        Effect.mapError(unavailable),
      );
    const { thread, turnId: orchestrationRunId } = yield* launchTurn(runId, {
      commandId: CommandId.make(`crew:${runId}:${LEAD_TURN}:launch`),
      threadId,
      projectId: run.projectId,
      title: `${run.crew.name}: ${brief ?? role.name}`.replaceAll(/\s+/gu, " ").slice(0, 80),
      modelSelection: role.modelSelection,
      // Unless it may edit, the lead reads the checkout and changes go through the roles.
      runtimeMode: lead.canEdit ? role.runtimeMode : "approval-required",
      interactionMode: lead.canEdit && !plans ? "default" : "plan",
      workspaceStrategy:
        workspace.mode === "new-worktree" && branch !== null
          ? { type: "worktree", baseRef: workspace.baseRef, branch, startFromOrigin: false }
          : { type: "root" },
      initialMessage: {
        messageId: MessageId.make(`message:${runId}:${LEAD_TURN}:${turnId}`),
        text: composeCrewLeadKickoff({
          crew: run.crew,
          files: run.files,
          driver: role.driver,
          inputs: run.inputs,
          roleId: lead.roleId,
          models: Object.fromEntries(
            Object.entries(run.roles).map(([id, other]) => [
              id,
              `${other.modelSelection.instanceId}/${other.modelSelection.model}`,
            ]),
          ),
          canEdit: lead.canEdit,
          updates: lead.updates,
        }),
        attachments: run.start.attachments,
      },
      createdBy: "user",
      creationSource: "web",
    });
    // The launch returns before the home worktree exists, so its path is read from the thread
    // when a card first needs it.
    yield* store
      .setHome(runId, { threadId, worktree: null, branch: thread.branch })
      .pipe(Effect.mapError(unavailable));
    yield* watchTurn(threadId, orchestrationRunId);
  });

  /** Sends the lead one of the crew's own turns, which the engine then waits on. */
  const sendToLead = Effect.fn("CrewRunService.sendToLead")(function* (
    runId: string,
    turnId: number,
    text: (run: CrewRunRecord) => string,
  ) {
    const run = yield* loadRun(runId);
    const { homeThreadId } = run;
    if (homeThreadId === null || run.snapshot.lead?.turn?.id !== turnId) return;
    yield* store
      .indexThread(homeThreadId, { runId, cardId: LEAD_TURN, attempt: turnId })
      .pipe(Effect.mapError(unavailable));
    yield* watchTurn(
      homeThreadId,
      yield* sendTurn(run, homeThreadId, `${LEAD_TURN}:${turnId}`, text(run)),
    );
  });

  const waitingOnLead = (run: CrewRunRecord, cardId: string) =>
    run.snapshot.cards.find((card) => card.id === cardId && card.state === "waiting_lead");

  /**
   * Hands an open lead decision to the user once the crew's time for it has passed, counted from
   * when it was asked. A restart arms it again from the same time.
   */
  const armDecisionTimeout = Effect.fn("CrewRunService.armDecisionTimeout")(function* (
    runId: string,
    cardId: string,
    askedAt: string,
  ) {
    const run = yield* loadRun(runId);
    const minutes =
      run.crew.home?.mode === "lead" ? run.crew.home.decisionTimeoutMinutes : undefined;
    if (minutes === undefined || waitingOnLead(run, cardId) === undefined) return;
    const deadline =
      DateTime.toEpochMillis(DateTime.makeUnsafe(askedAt)) +
      Duration.toMillis(Duration.times(decisionMinute, minutes));
    yield* Effect.sleep(Duration.millis(Math.max(0, deadline - (yield* timestamp).millis))).pipe(
      Effect.andThen(loadRun(runId)),
      Effect.flatMap((later) =>
        waitingOnLead(later, cardId) === undefined
          ? Effect.void
          : apply(runId, {
              type: "gate.escalated",
              cardId,
              reason: `The lead did not decide within ${minutes} minute${minutes === 1 ? "" : "s"}.`,
            }),
      ),
      Effect.ignore,
      Effect.forkIn(scope),
    );
  });

  /** Asks the lead to decide, and hands the decision to the user if it takes too long. */
  const requestDecision = Effect.fn("CrewRunService.requestDecision")(function* (
    runId: string,
    effect: Extract<CrewEffect, { readonly type: "send_decision_request" }>,
    askedAt: string,
  ) {
    const { cardId } = effect;
    yield* sendToLead(runId, effect.turnId, (run) => {
      const { crew, snapshot } = run;
      const card = snapshot.cards.find((candidate) => candidate.id === cardId);
      const step = card === undefined ? undefined : crew.flow.steps[card.stepId];
      const source = snapshot.cards.find((candidate) => candidate.id === card?.sourceCardId);
      // A gate is about the steps that route into it; a decision, about the card it settles.
      const about =
        source === undefined
          ? [
              ...new Set(
                snapshot.flow.edges
                  .filter((edge) => edge.to === card?.stepId && edge.kind !== "branch")
                  .map((edge) => edge.from),
              ),
            ].flatMap((stepId) => {
              const latest = snapshot.cards.findLast(
                (other) =>
                  other.stepId === stepId && other.type !== "decision" && other.outcome !== null,
              );
              return latest === undefined ? [] : [latest];
            })
          : [source];
      return crewDecisionPrompt({
        decisionId: `${runId}:${cardId}`,
        prompt:
          step?.type === "gate"
            ? step.prompt
            : `Step \`${card?.stepId}\` ended with \`${source?.outcome}\`, which the flow has no route for. Choose how it continues.`,
        outcomes: effect.outcomes,
        context: about.map((other) => crewCardLine(crew, other)),
        reminder: effect.reminder,
      });
    });
    // A reminder runs on the first request's clock.
    if (!effect.reminder) yield* armDecisionTimeout(runId, cardId, askedAt);
  });

  /** Sends the card's prompt, or a reminder, to a thread that already holds the role's context. */
  const followUp = Effect.fn("CrewRunService.followUp")(function* (
    runId: string,
    effect: Extract<CrewEffect, { readonly type: "send_follow_up" }>,
  ) {
    const run = yield* loadRun(runId);
    const card = dispatchingCard(run, effect);
    if (card === undefined) return;
    const threadId = ThreadId.make(effect.threadId);
    const thread = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
    const text =
      effect.reason === "reminder"
        ? crewReminderPrompt(run.crew, card.stepId)
        : yield* promptFor(run, card, thread?.branch ?? run.integrationBranch);
    yield* store
      .indexThread(threadId, { runId, cardId: card.id, attempt: card.attempt })
      .pipe(Effect.mapError(unavailable));
    // A follow-up in a card's own worktree commits there, and the next merge takes its commits.
    if (card.isolation === "worktree" && thread?.worktreePath != null && thread.branch !== null) {
      yield* store
        .setCardWorkspace(runId, {
          cardId: card.id,
          worktreePath: thread.worktreePath,
          branch: thread.branch,
          baseSha: null,
          owns: crewCardOwns(run.crew, card),
        })
        .pipe(Effect.mapError(unavailable));
    }
    yield* dispatched(
      run,
      card,
      threadId,
      yield* sendTurn(run, threadId, `${card.id}:${card.attempt}`, text),
    );
  });

  /** Records what each waiting branch changed outside its card's paths, then starts the merge. */
  const checkOwnership = Effect.fn("CrewRunService.checkOwnership")(function* (
    runId: string,
    cardId: string,
  ) {
    const run = yield* loadRun(runId);
    const merge = run.snapshot.cards.find((card) => card.id === cardId);
    if (merge === undefined) return;
    const cwd = yield* integrationCwd(run);
    yield* commitWorkspace(run, merge, cwd, null);
    for (const pending of yield* pendingBranches(run, cwd)) {
      const diff = yield* git(runId, cwd, [
        "-c",
        "core.quotePath=false",
        "diff",
        "--name-only",
        `${pending.baseSha}...${pending.branch}`,
      ]);
      const changed = lines(diff.stdout);
      yield* store
        .setCardOwnership(
          runId,
          pending.cardId,
          changed,
          crewOwnershipViolations(changed, pending.owns),
        )
        .pipe(Effect.mapError(unavailable));
    }
    yield* apply(runId, { type: "merge.started", cardId });
  });

  /**
   * Merges every waiting card branch into the shared checkout. A conflict goes to the step's
   * resolver role with the merge left in place, and this runs again when that role's turn ends.
   */
  const mergeInto = Effect.fn("CrewRunService.mergeInto")(function* (
    run: CrewRunRecord,
    cardId: string,
    cwd: string,
  ) {
    const { runId } = run;
    const merge = run.snapshot.cards.find(
      (card) => card.id === cardId && card.type === "merge" && card.state === "working",
    );
    const step = merge === undefined ? undefined : run.crew.flow.steps[merge.stepId];
    if (merge === undefined || step?.type !== "merge") return;
    const unmerged = () =>
      Effect.map(
        git(runId, cwd, ["-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=U"]),
        (result) => lines(result.stdout),
      );
    const merging = yield* git(runId, cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], true);
    if (merging.exitCode === 0) {
      const resolver = run.snapshot.cards.findLast(
        (card) => card.sourceCardId === cardId && card.type === "task",
      );
      const paths = conflictPaths(resolver);
      // A file the resolver left a marker in is not resolved, whatever it staged.
      const unresolved =
        paths.length === 0
          ? yield* unmerged()
          : lines(
              (yield* git(
                runId,
                cwd,
                ["grep", "-l", "-E", "^(<<<<<<<|>>>>>>>) ", "--", ...paths],
                true,
              )).stdout,
            );
      if (unresolved.length > 0) {
        yield* git(runId, cwd, ["merge", "--abort"], true);
        yield* apply(runId, {
          type: "merge.blocked",
          cardId,
          reason: `The conflict in ${unresolved.join(", ")} was not resolved, so that merge was undone.`,
        });
        return;
      }
      yield* git(runId, cwd, ["add", "-A"]);
      const [subject, trailers] = crewCommitMessage({
        runId,
        card: { ...merge, roleId: resolver?.roleId ?? null },
        model: resolver === undefined ? null : crewCardModel(run, resolver),
        summary: resolver?.report?.summary ?? "resolve merge conflicts",
      });
      yield* git(runId, cwd, ["commit", "--no-verify", "-m", subject, "-m", trailers]);
    }
    const notMerged: Array<string> = [];
    for (const pending of yield* pendingBranches(run, cwd)) {
      if (step.checkOwnership === "block" && pending.ownershipViolations.length > 0) {
        notMerged.push(
          `${pending.branch} changed paths it does not own (${pending.ownershipViolations.join(", ")})`,
        );
        continue;
      }
      const merged = yield* git(
        runId,
        cwd,
        ["merge", "--no-ff", "--no-edit", "--no-verify", pending.branch],
        true,
      );
      if (merged.exitCode === 0) continue;
      const paths = yield* unmerged();
      if (paths.length > 0 && typeof step.onConflict === "object") {
        yield* apply(runId, { type: "merge.conflict", cardId, paths });
        return;
      }
      yield* git(runId, cwd, ["merge", "--abort"], true);
      notMerged.push(
        paths.length > 0
          ? `${pending.branch} conflicts in ${paths.join(", ")}`
          : `${pending.branch} could not be merged (${merged.stderr.trim()})`,
      );
    }
    yield* apply(
      runId,
      notMerged.length === 0
        ? { type: "merge.resolved", cardId }
        : { type: "merge.blocked", cardId, reason: `Not merged: ${notMerged.join("; ")}.` },
    );
  });

  const mergeBranches = Effect.fn("CrewRunService.mergeBranches")(function* (
    runId: string,
    cardId: string,
  ) {
    const run = yield* loadRun(runId);
    const cwd = yield* integrationCwd(run);
    yield* withWorkspaceLease(cwd, mergeInto(run, cardId, cwd));
  });

  // shortcut: the script runs on the one effect worker, so other cards wait for it; fork it and report back when a slow script holds a run up.
  const runScript = Effect.fn("CrewRunService.runScript")(function* (
    runId: string,
    effect: Extract<CrewEffect, { readonly type: "run_script" }>,
  ) {
    const run = yield* loadRun(runId);
    const card = dispatchingCard(run, effect);
    const step = card === undefined ? undefined : run.crew.flow.steps[card.stepId];
    if (card === undefined || step?.type !== "script") return;
    const tool = "tool" in step ? run.scriptTools[step.tool] : { run: step.run };
    if (tool === undefined) {
      return yield* new ForkCrewsError({
        reason: "unsupported",
        runId,
        detail: `Step "${card.stepId}" runs a tool the project did not define when the run started.`,
      });
    }
    const timeoutSeconds =
      step.timeoutMinutes === undefined
        ? "timeoutSeconds" in tool
          ? tool.timeoutSeconds
          : undefined
        : step.timeoutMinutes * 60;
    const result = yield* shell(
      yield* integrationCwd(run),
      tool.run,
      timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS,
    ).pipe(Effect.mapError((cause) => failed(runId, cause)));
    yield* apply(runId, {
      type: "script.finished",
      cardId: card.id,
      attempt: card.attempt,
      // 124 is what `timeout` exits with.
      exitCode: result.exitCode ?? 124,
      outputTail: result.timedOut ? `${result.output}\nStopped at its timeout.` : result.output,
    });
  });

  /** Removes a finished run's card worktree, as far as the user's worktree rules allow. */
  const removeCardWorktree = Effect.fn("CrewRunService.removeCardWorktree")(function* (
    runId: string,
    cardId: string,
  ) {
    const run = yield* loadRun(runId);
    const workspace = (yield* store
      .listCardWorkspaces(runId)
      .pipe(Effect.mapError(unavailable))).find((candidate) => candidate.cardId === cardId);
    if (
      workspace === undefined ||
      !(yield* fileSystem.exists(workspace.worktreePath).pipe(Effect.orElseSucceed(() => false)))
    ) {
      return;
    }
    const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
    if (resolveProjectSettings(current, run.projectId).settings.worktreeCleanup?.mode === "off") {
      return;
    }
    if (resolveWorktreeCleanup(current, run.projectId).worktreeKeepWhen === "any-local-files") {
      const ignored = yield* git(runId, workspace.worktreePath, [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
      ]);
      if (ignored.stdout.trim().length > 0) return;
    }
    // Not forced, so git keeps a worktree with uncommitted work. The branch stays either way,
    // and a thread resumed later gets its checkout back from it.
    yield* vcs
      .removeWorktree({ cwd: yield* projectRoot(run), path: workspace.worktreePath })
      .pipe(Effect.mapError((cause) => failed(runId, cause)));
  });

  /** `createdAt` is when the event that asked for the effect was committed. */
  const runEffect = (
    runId: string,
    effect: CrewEffect,
    createdAt: string,
  ): Effect.Effect<void, ForkCrewsError> => {
    switch (effect.type) {
      case "launch_card":
        return launchCard(runId, effect);
      case "send_follow_up":
        return followUp(runId, effect);
      case "stop_thread":
        // A card stopped before its thread existed is stopped again once it does.
        return effect.threadId === null
          ? Effect.void
          : threads
              .dispatch({
                type: "thread.stop",
                commandId: CommandId.make(`crew:${runId}:${effect.cardId}:${effect.attempt}:stop`),
                threadId: ThreadId.make(effect.threadId),
                reason: "The crew run stopped this card.",
              })
              .pipe(Effect.mapError(unavailable), Effect.asVoid);
      case "check_ownership":
        return checkOwnership(runId, effect.cardId);
      case "merge_branch":
        return mergeBranches(runId, effect.cardId);
      case "run_script":
        return runScript(runId, effect);
      case "remove_worktree":
        return removeCardWorktree(runId, effect.cardId);
      // The board shows what waits on the user; nothing is pushed to them yet. The service commits
      // at turn end and before a branch or merge, so the engine asks for no commit of its own.
      // Notes reach a role in its next prompt, so nothing delivers them on their own.
      case "notify":
      case "commit_workspace":
      case "deliver_notes":
        return Effect.void;
      case "launch_lead":
        return launchLead(runId, effect.turnId);
      case "deliver_lead_update":
        return sendToLead(runId, effect.turnId, () => crewLeadUpdatePrompt(effect.milestones));
      case "send_decision_request":
        return requestDecision(runId, effect, createdAt);
    }
  };

  /** Runs one committed effect once. Returns why it failed, after failing the card it was for. */
  const execute = Effect.fn("CrewRunService.execute")(function* (effectId: string) {
    const claimed = yield* store
      .claimEffect(effectId, (yield* timestamp).iso)
      .pipe(Effect.mapError(unavailable));
    if (claimed === null) return null;
    const { runId, effect } = claimed;
    const exit = yield* Effect.exit(runEffect(runId, effect, claimed.createdAt));
    // A shutdown mid-effect leaves the row claimed; it is not the card's failure.
    if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return null;
    const error = Exit.isSuccess(exit) ? null : message(Cause.squash(exit.cause));
    yield* store
      .finishEffect(effectId, error, (yield* timestamp).iso)
      .pipe(Effect.mapError(unavailable));
    // A turn the lead could not be sent has ended: an update is dropped, and a decision goes on
    // to its reminder and then to the user. A failed kickoff fails the start instead.
    if (error !== null && "turnId" in effect) {
      if (effect.type !== "launch_lead") {
        yield* apply(runId, { type: "lead.turn_finished", turnId: effect.turnId });
      }
    } else if (error !== null && "cardId" in effect && effect.cardId !== undefined) {
      const { cardId } = effect;
      const run = yield* loadRun(runId);
      const attempt =
        "attempt" in effect
          ? effect.attempt
          : run.snapshot.cards.find((card) => card.id === cardId)?.attempt;
      if (attempt !== undefined) {
        yield* apply(runId, { type: "card.failed", cardId, attempt, reason: error });
      }
    }
    return error;
  });

  // Annotated because the effects it runs enqueue more work on it.
  const worker: DrainableWorker<Work> = yield* makeDrainableWorker((work: Work) =>
    "effectId" in work ? Effect.asVoid(execute(work.effectId)) : turnFinished(work),
  );

  // Every terminal turn in the environment passes here; `turnFinished` keeps the crews' own.
  yield* threads.streamDomainEvents.pipe(
    Stream.runForEach((event) =>
      event.type === "run.updated" &&
      ThreadManagementService.isTerminalRunStatus(event.payload.status)
        ? worker.enqueue({
            threadId: event.payload.threadId,
            orchestrationRunId: event.payload.id,
            status: event.payload.status,
          })
        : Effect.void,
    ),
    Effect.catchCause((cause) => Effect.logWarning("crew turn completion stream failed", cause)),
    Effect.forkScoped,
  );

  // Startup recovery: what a shutdown cut off is picked up from what was committed. Effects run
  // again (their command ids are derived, so a launch resumes rather than repeats), a turn that
  // ended while the server was down is handled now, and open lead decisions get their timeouts
  // back. `turnFinished` ignores a turn already handled, so one the stream also reports counts once.
  // shortcut: a turn that ends between the status read below and the stream's first read is missed until the next restart; have the stream signal when it is live if that window shows up.
  yield* Effect.gen(function* () {
    const now = yield* timestamp;
    for (const effectId of yield* store.reclaimEffects(now.iso)) {
      yield* worker.enqueue({ effectId });
    }
    for (const turn of yield* store.listWatchedTurns()) {
      const { orchestrationRunId } = turn;
      const { runs } = yield* threads.getThreadRecords(turn.threadId, ["runs"], {
        runIds: [orchestrationRunId],
      });
      const status = runs[0]?.status;
      if (status !== undefined && ThreadManagementService.isTerminalRunStatus(status)) {
        yield* worker.enqueue({ threadId: turn.threadId, orchestrationRunId, status });
      }
    }
    for (const request of yield* store.listDecisionRequests()) {
      yield* armDecisionTimeout(request.runId, request.cardId, request.askedAt);
    }
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("crew run recovery failed", cause)));

  const freezeToolbox = Effect.fn("CrewRunService.freezeToolbox")(function* (
    resolution: CrewCatalog.CrewRunResolution,
    items: CrewCatalog.CrewRunResolution["detail"]["roles"][number]["toolbox"]["items"],
  ) {
    const skills = yield* Effect.forEach(
      items.filter((item) => item.kind === "skill"),
      (item) =>
        fileSystem.readFileString(item.path).pipe(
          Effect.orElseSucceed(() => ""),
          Effect.flatMap((text) =>
            Effect.map(sha256(text), (hash) => ({
              name: item.name,
              path: item.path,
              source: item.source,
              hash,
              description: skillDescription(text),
            })),
          ),
        ),
    );
    const toolbox: CrewRunToolbox = {
      skills,
      mcp: items.flatMap((item) => {
        const server =
          item.kind === "mcp"
            ? resolution.mcp[item.source === "repo" ? "repo" : "home"].servers[item.name]
            : undefined;
        return server === undefined
          ? []
          : [
              {
                name: item.name,
                source: item.source,
                command: server.command,
                args: server.args ?? [],
                env: server.env ?? {},
              },
            ];
      }),
      tools: items.flatMap((item) => {
        const tool = item.kind === "tool" ? resolution.tools.tools[item.name] : undefined;
        return tool === undefined ? [] : [{ name: item.name, source: item.source, ...tool }];
      }),
    };
    return toolbox;
  });

  const start: CrewRunService["Service"]["start"] = Effect.fn("CrewRunService.start")(
    function* (input) {
      const requestHash = yield* sha256(`${input.projectId}\n${input.clientRequestId}`);
      const runId = `crew-run:${requestHash.slice(0, 32)}`;
      const existing = yield* store.getRun(runId).pipe(Effect.mapError(unavailable));
      if (existing !== null) return { runId, homeThreadId: existing.homeThreadId };

      const resolution = yield* catalog.resolveRun({
        projectId: input.projectId,
        crewId: input.crewId,
        roleModelOverrides: input.roleModelOverrides,
        composerSelection: input.modelSelection,
        startingRuntimeMode: input.runtimeMode,
      });
      const { detail } = resolution;
      const crew = detail.definition;
      if (crew === null || detail.summary.status === "invalid") {
        return yield* new ForkCrewsError({
          reason: "crew_invalid",
          crewId: input.crewId,
          projectId: input.projectId,
        });
      }
      const refuse = (reason: "invalid_request", why: string) =>
        new ForkCrewsError({ reason, crewId: input.crewId, detail: why });
      const inputs = resolveInputs(crew, input.inputs);
      if (typeof inputs === "string") return yield* refuse("invalid_request", inputs);

      const roles: Record<string, CrewRunRole> = {};
      const toolboxes: Record<string, CrewRunToolbox> = {};
      for (const role of detail.roles) {
        const selection = role.model.selection;
        const { runtimeMode } = role.runtimeMode;
        if (selection === null || runtimeMode === "inherit") {
          return yield* refuse(
            "invalid_request",
            `Role "${role.id}" has no model to run on. Pick one in the crew's settings.`,
          );
        }
        roles[role.id] = {
          name: crew.roles[role.id]?.name ?? role.id,
          modelSelection: selection,
          driver: resolution.drivers[selection.instanceId] ?? null,
          runtimeMode,
        };
        toolboxes[role.id] = yield* freezeToolbox(resolution, role.toolbox.items);
      }

      const files = crewPromptFiles(crew, resolution.files);
      const crewHash = yield* sha256(crewHashInput(crew, files));
      const now = yield* timestamp;
      const scriptTools: Record<string, CrewRunToolbox["tools"][number]> = {};
      for (const step of Object.values(crew.flow.steps)) {
        if (step.type !== "script" || !("tool" in step)) continue;
        const tool = resolution.tools.tools[step.tool];
        if (tool !== undefined)
          scriptTools[step.tool] = { name: step.tool, source: "repo", ...tool };
      }
      const snapshot = createCrewSnapshot(crew, compileCrewFlow(crew), {
        roleInstances: Object.fromEntries(
          Object.entries(roles).map(([id, role]) => [id, role.modelSelection.instanceId]),
        ),
        // A pool spreads fan-out cards over the listed accounts of the role's own provider.
        rolePools: Object.fromEntries(
          Object.entries(roles).flatMap(([id, role]) => {
            const pool = (crew.roles[id]?.pool ?? []).filter(
              (instanceId) =>
                role.driver !== null && resolution.drivers[instanceId] === role.driver,
            );
            return pool.length > 1 ? [[id, pool] as const] : [];
          }),
        ),
      });
      const effectIds = yield* transact(
        Effect.gen(function* () {
          // A second request with the same id can reach here while the first is resolving.
          if ((yield* store.getRun(runId)) !== null) return null;
          yield* store.insertRun({
            runId,
            projectId: input.projectId,
            crewId: input.crewId,
            crew,
            files,
            scriptTools,
            crewHash,
            start: input,
            inputs,
            roles,
            toolboxes,
            toolboxMode: resolution.toolboxMode,
            integrationBranch:
              input.workspace.mode === "new-worktree"
                ? `crew/${input.crewId}/${runId.slice(-8)}`
                : null,
            snapshot,
            createdAt: now.iso,
            updatedAt: now.iso,
          });
          return yield* decideAndCommit(runId, { type: "run.created" });
        }),
      );
      if (effectIds !== null) {
        yield* PubSub.publish(changes, runId);
        // The home thread is launched before this returns, so the client can open it.
        for (const effectId of effectIds) {
          const error = yield* execute(effectId);
          if (error === null) continue;
          yield* apply(runId, { type: "run.failed", reason: error });
          return yield* new ForkCrewsError({ reason: "launch_failed", runId, detail: error });
        }
      }
      return { runId, homeThreadId: (yield* loadRun(runId)).homeThreadId };
    },
  );

  const view = (runId: string, toolbox: boolean) =>
    Effect.gen(function* () {
      const run = yield* loadRun(runId);
      const cards = yield* store.listCards(runId).pipe(Effect.mapError(unavailable));
      return buildCrewRunView(run, cards, { toolbox });
    });

  const subscribe: CrewRunService["Service"]["subscribe"] = (runId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribed before the snapshot, so a change landing in between is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(view(runId, false)),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((changed) => changed === runId),
            Stream.mapEffect(() => view(runId, false)),
          ),
        );
      }),
    );

  /** Who a tool call comes from: a card's thread, or the lead's home thread between its cards. */
  const member = Effect.fn("CrewRunService.member")(function* (threadId: ThreadId) {
    const entry = yield* store.findThread(threadId).pipe(Effect.mapError(toolUnavailable));
    const run =
      entry === null
        ? null
        : yield* store.getRun(entry.runId).pipe(Effect.mapError(toolUnavailable));
    const card = run?.snapshot.cards.find((candidate) => candidate.id === entry?.cardId);
    const lead = run?.homeThreadId === threadId ? (run.snapshot.lead ?? null) : null;
    if (run === null || (card === undefined && lead === null)) {
      return yield* refused("not_a_crew_card", "This thread is not working for a crew run.");
    }
    const roleId = card?.roleId ?? lead?.roleId ?? null;
    return {
      run,
      card,
      isLead: lead !== null,
      roleId,
      toolbox: (roleId === null ? undefined : run.toolboxes[roleId]) ?? {
        skills: [],
        mcp: [],
        tools: [],
      },
    };
  });

  /** The card a tool call comes from, with its run and role. */
  const caller = (threadId: ThreadId) =>
    Effect.flatMap(member(threadId), ({ card, ...rest }) =>
      card === undefined
        ? Effect.fail(
            refused("not_allowed", "The lead has no step of its own running, so this has no card."),
          )
        : Effect.succeed({ ...rest, card }),
    );

  const answerDecision: CrewRunService["Service"]["decide"] = Effect.fn("CrewRunService.decide")(
    function* (threadId, input) {
      const { run, isLead } = yield* member(threadId);
      if (!isLead) return yield* refused("not_allowed", "Only the crew's lead answers decisions.");
      const cardId = localCardId(run.runId, input.decisionId);
      const card = run.snapshot.cards.find((candidate) => candidate.id === cardId);
      if (card?.state !== "waiting_lead") {
        return yield* refused(
          "not_allowed",
          card?.state === "needs_you" || card?.decidedBy === "user"
            ? "The user has taken this decision over, so nothing was recorded."
            : "That decision is not open. `crew_context` lists the open ones.",
        );
      }
      const outcomes = crewDecisionOutcomes(run.snapshot.flow, card.stepId);
      if (input.outcome !== "escalate" && !outcomes.includes(input.outcome)) {
        return yield* refused(
          "invalid_report",
          `Nothing was recorded. Outcome "${input.outcome}" is not allowed. Use one of: ${[...outcomes, "escalate"].join(", ")}.`,
        );
      }
      yield* apply(
        run.runId,
        input.outcome === "escalate"
          ? {
              type: "gate.escalated",
              cardId,
              reason: input.note ?? "The lead handed this decision to you.",
            }
          : {
              type: "gate.resolved",
              cardId,
              outcome: input.outcome,
              note: input.note ?? "",
              by: "lead",
            },
      ).pipe(Effect.mapError(toolUnavailable));
      return { decided: true as const, outcome: input.outcome };
    },
  );

  const cardAction = (action: "stop" | "retry" | "skip" | "force_outcome") =>
    Effect.fn(`CrewRunService.${action}`)(function* (
      input: CardTarget & { readonly outcome?: string },
    ) {
      const run = yield* loadRun(input.runId);
      const cardId = localCardId(input.runId, input.cardId);
      const card = run.snapshot.cards.find((candidate) => candidate.id === cardId);
      // The engine ignores an action a card cannot take; the user is told instead.
      if (
        card === undefined ||
        card.type === "gate" ||
        card.type === "decision" ||
        card.sourceCardId !== null ||
        (action === "stop"
          ? !["working", "reported"].includes(card.state) || card.threadId === null
          : !WAITING_STATES.has(card.state))
      ) {
        return yield* new ForkCrewsError({
          reason: "invalid_request",
          runId: input.runId,
          detail:
            action === "stop"
              ? "Only a running card with a thread can be stopped."
              : "Only a card that is queued or waiting on a decision can be retried, skipped or forced.",
        });
      }
      yield* apply(input.runId, {
        type: "user.card_action",
        cardId,
        action,
        ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
      });
    });

  const requireLive = (card: CrewCard) =>
    LIVE_STATES.has(card.state)
      ? Effect.void
      : Effect.fail(refused("not_allowed", "This card is not running, so nothing was recorded."));

  const report: CrewRunService["Service"]["report"] = Effect.fn("CrewRunService.report")(
    function* (threadId, input) {
      const { run, card } = yield* caller(threadId);
      yield* requireLive(card);
      const written = yield* store
        .artifactsWrittenBy(run.runId, card.id)
        .pipe(Effect.mapError(toolUnavailable));
      const result = {
        outcome: input.outcome,
        summary: input.summary,
        artifacts: { ...written, ...input.artifacts },
      };
      const errors = crewReportErrors(run.crew, card.stepId, result);
      if (errors.length > 0) {
        return yield* refused("invalid_report", `Nothing was recorded. ${errors.join(" ")}`);
      }
      yield* apply(run.runId, {
        type: "card.reported",
        cardId: card.id,
        attempt: card.attempt,
        ...result,
      }).pipe(Effect.mapError(toolUnavailable));
      return { recorded: true as const, outcome: input.outcome };
    },
  );

  const context: CrewRunService["Service"]["context"] = Effect.fn("CrewRunService.context")(
    function* (threadId) {
      const { run, card, isLead, roleId, toolbox } = yield* member(threadId);
      const step = card === undefined ? undefined : run.crew.flow.steps[card.stepId];
      const role = roleId === null ? undefined : run.roles[roleId];
      return {
        runId: run.runId,
        crewId: run.crewId,
        // Between its own steps the lead has no card: it is the run's lead and nothing more.
        cardId: `${run.runId}:${card?.id ?? LEAD_TURN}`,
        role: roleId === null || role === undefined ? null : { id: roleId, name: role.name },
        step: { id: card?.stepId ?? "", type: card?.type ?? "lead" },
        visit: card?.visit ?? 0,
        attempt: card?.attempt ?? 0,
        inputs: run.inputs,
        branch: run.integrationBranch,
        outcomes: card === undefined ? [] : crewStepOutcomes(run.crew, card.stepId),
        produces: card === undefined ? [] : crewStepProduces(run.crew, card.stepId),
        artifacts: yield* store.listArtifacts(run.runId).pipe(Effect.mapError(toolUnavailable)),
        skills: toolbox.skills.map(({ name, source, description }) => ({
          name,
          source,
          description,
        })),
        tools: toolbox.tools.map(({ name, source, description }) => ({
          name,
          source,
          ...(description === undefined ? {} : { description }),
        })),
        mcpServers: toolbox.mcp.map((server) => ({
          name: server.name,
          source: server.source,
          description:
            crewMcpDelivery(role?.driver ?? null, server) === "native"
              ? "Its tools are among yours."
              : "Reach it with crew_mcp_list_tools and crew_mcp_call.",
        })),
        owns: step !== undefined && "owns" in step ? [step.owns ?? []].flat() : [],
        teammates: run.snapshot.cards
          .filter((other) => other.id !== card?.id && other.type !== "decision")
          .map((other) => ({
            cardId: `${run.runId}:${other.id}`,
            stepId: other.stepId,
            roleId: other.roleId,
            state: other.state,
          })),
        ...(isLead
          ? { board: yield* view(run.runId, false).pipe(Effect.mapError(toolUnavailable)) }
          : {}),
      };
    },
  );

  /** An MCP server in the caller's toolbox, run in the run's shared checkout. */
  const mcpTarget = Effect.fn("CrewRunService.mcpTarget")(function* (
    threadId: ThreadId,
    name: string,
  ) {
    const { run, toolbox } = yield* member(threadId);
    const server = toolbox.mcp.find((candidate) => candidate.name === name);
    if (server === undefined) {
      return yield* refused(
        "not_allowed",
        `MCP server "${name}" is not in this role's toolbox. It has: ${toolbox.mcp.map((candidate) => candidate.name).join(", ") || "none"}.`,
      );
    }
    const cwd = yield* integrationCwd(run).pipe(Effect.mapError(toolUnavailable));
    return { runId: run.runId, cwd, server };
  });

  const getSkill: CrewRunService["Service"]["getSkill"] = Effect.fn("CrewRunService.getSkill")(
    function* (threadId, input) {
      const { toolbox } = yield* member(threadId);
      const skill = toolbox.skills.find((candidate) => candidate.name === input.name);
      if (skill === undefined) {
        return yield* refused(
          "not_allowed",
          `Skill "${input.name}" is not in this role's toolbox. It has: ${toolbox.skills.map((candidate) => candidate.name).join(", ") || "none"}.`,
        );
      }
      const directory = path.dirname(skill.path);
      const target = input.file === undefined ? skill.path : path.resolve(directory, input.file);
      const relative = path.relative(directory, target);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return yield* refused("not_allowed", "The file is outside the skill's folder.");
      }
      const read = (file: string) =>
        fileSystem
          .readFileString(file)
          .pipe(
            Effect.mapError(() =>
              refused("not_found", `Skill "${input.name}" has no readable ${path.basename(file)}.`),
            ),
          );
      const content = yield* read(target);
      const changed =
        (yield* sha256(target === skill.path ? content : yield* read(skill.path))) !== skill.hash;
      return {
        name: skill.name,
        path: target,
        content,
        ...(changed ? { warning: "This skill changed on disk after the run started." } : {}),
      };
    },
  );

  return CrewRunService.of({
    start,
    get: (runId) => view(runId, true),
    list: (input) =>
      store.listRuns(input.projectId, input.status).pipe(Effect.mapError(unavailable)),
    subscribe,
    subscribeByThread: (threadId) =>
      Stream.unwrap(
        store.findThread(threadId).pipe(
          Effect.mapError(unavailable),
          Effect.map((entry): Stream.Stream<CrewRunView | null, ForkCrewsError> =>
            entry === null ? Stream.succeed(null) : subscribe(entry.runId),
          ),
        ),
      ),
    pause: (runId) => apply(runId, { type: "run.paused" }),
    resume: (runId) => apply(runId, { type: "run.resumed" }),
    cancel: (runId) => apply(runId, { type: "run.cancel_requested" }),
    resolveGate: Effect.fn("CrewRunService.resolveGate")(function* (input) {
      const run = yield* loadRun(input.runId);
      const cardId = localCardId(input.runId, input.cardId);
      const card = run.snapshot.cards.find((candidate) => candidate.id === cardId);
      if (card === undefined || (card.state !== "needs_you" && card.state !== "waiting_lead")) {
        return yield* new ForkCrewsError({
          reason: "invalid_request",
          runId: input.runId,
          detail: "That card is not waiting on a decision.",
        });
      }
      yield* apply(input.runId, {
        type: "gate.resolved",
        cardId,
        outcome: input.outcome,
        note: input.note ?? "",
        by: "user",
      });
    }),
    retryCard: cardAction("retry"),
    stopCard: cardAction("stop"),
    skipCard: cardAction("skip"),
    forceOutcome: cardAction("force_outcome"),
    setRoleModel: (input) =>
      apply(input.runId, {
        type: "user.role_model_changed",
        roleId: input.roleId,
        selection: input.selection,
      }),
    resetRoute: Effect.fn("CrewRunService.resetRoute")(function* (input) {
      const { flow } = (yield* loadRun(input.runId)).snapshot;
      const region = flow.loopRegions.find((candidate) =>
        candidate.routeIds.includes(input.routeId),
      );
      yield* apply(input.runId, {
        type: "route.counters_reset",
        regionId: region?.id ?? input.routeId,
        routeIds: [input.routeId],
        cause: "user",
      });
    }),
    extendBudget: (input) =>
      apply(input.runId, { type: "budget.extended", kind: input.kind, by: input.by }),
    selectFanout: Effect.fn("CrewRunService.selectFanout")(function* (input) {
      const groupId = (yield* loadRun(input.runId)).snapshot.budgetGate?.groupId;
      if (groupId === null || groupId === undefined) {
        return yield* new ForkCrewsError({
          reason: "invalid_request",
          runId: input.runId,
          detail: "The run is not waiting on a fan-out choice.",
        });
      }
      yield* apply(input.runId, {
        type: "budget.fanout_selected",
        groupId,
        choice: input.choice,
        ...(input.count === undefined ? {} : { count: input.count }),
      });
    }),

    context,
    report,
    decide: answerDecision,
    getSkill,
    readArtifact: Effect.fn("CrewRunService.readArtifact")(function* (threadId, name) {
      const { run } = yield* member(threadId);
      const artifact = yield* store
        .readArtifact(run.runId, name)
        .pipe(Effect.mapError(toolUnavailable));
      return artifact === null
        ? yield* refused("not_found", `The run has no artifact "${name}" yet.`)
        : { name, value: artifact.value };
    }),
    writeArtifact: Effect.fn("CrewRunService.writeArtifact")(function* (threadId, input) {
      const { run, card } = yield* caller(threadId);
      yield* requireLive(card);
      const produces = crewStepProduces(run.crew, card.stepId);
      const artifact = run.crew.artifacts?.[input.name];
      if (!produces.includes(input.name) || artifact === undefined) {
        return yield* refused(
          "not_allowed",
          `This step does not produce "${input.name}". It produces: ${produces.join(", ") || "nothing"}.`,
        );
      }
      const errors = crewArtifactErrors(artifact, input.value, input.name);
      if (errors.length > 0) {
        return yield* refused("invalid_report", `Nothing was written. ${errors.join(" ")}`);
      }
      yield* store
        .writeArtifact(run.runId, card.id, input.name, input.value, (yield* timestamp).iso)
        .pipe(Effect.mapError(toolUnavailable));
      return { written: true as const };
    }),
    note: Effect.fn("CrewRunService.note")(function* (threadId, input) {
      const { run, card } = yield* member(threadId);
      const toCardId = input.toCard === undefined ? null : localCardId(run.runId, input.toCard);
      if (
        (input.toRole === undefined && toCardId === null) ||
        (input.toRole !== undefined && !Object.hasOwn(run.crew.roles, input.toRole)) ||
        (toCardId !== null && !run.snapshot.cards.some((other) => other.id === toCardId))
      ) {
        return yield* refused(
          "not_allowed",
          `Address the note to a role (${Object.keys(run.crew.roles).join(", ")}) or to a card from crew_context.`,
        );
      }
      const noteId = `${run.runId}:note:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`;
      yield* store
        .insertNote({
          noteId,
          runId: run.runId,
          fromCardId: card?.id ?? LEAD_TURN,
          toRoleId: input.toRole ?? null,
          toCardId,
          text: input.text,
          at: (yield* timestamp).iso,
        })
        .pipe(Effect.mapError(toolUnavailable));
      return { noteId };
    }),
    validate: Effect.fn("CrewRunService.validate")(function* (threadId, input) {
      const { run } = yield* member(threadId);
      const diagnostics = yield* catalog
        .validateText({ projectId: run.projectId, text: input.text, kind: input.kind ?? "crew" })
        .pipe(Effect.mapError(toolUnavailable));
      return { diagnostics };
    }),
    listTools: (threadId) =>
      Effect.map(member(threadId), ({ toolbox }) => ({ tools: toolbox.tools })),
    runTool: Effect.fn("CrewRunService.runTool")(function* (threadId, input) {
      const { run, card, toolbox } = yield* caller(threadId);
      yield* requireLive(card);
      const tool = toolbox.tools.find((candidate) => candidate.name === input.name);
      if (tool === undefined) {
        return yield* refused(
          "not_allowed",
          `Tool "${input.name}" is not in this role's toolbox. It has: ${toolbox.tools.map((candidate) => candidate.name).join(", ") || "none"}.`,
        );
      }
      const args = input.args ?? [];
      // The arguments join a shell command line, so nothing a shell would read is let through.
      if (!args.every(isPlainToolArgument)) {
        return yield* refused(
          "not_allowed",
          "A tool argument may hold only letters, digits and . / \\ : = @ , + - _ with no spaces or quotes.",
        );
      }
      const cwd = yield* cardCwd(run, card.id).pipe(Effect.mapError(toolUnavailable));
      return yield* shell(
        cwd,
        [tool.run, ...args].join(" "),
        tool.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS,
      ).pipe(
        Effect.mapError((cause) =>
          refused("unavailable", `The tool could not be run. ${message(cause)}`),
        ),
      );
    }),

    mcpListTools: (threadId, server) =>
      Effect.flatMap(mcpTarget(threadId, server), gateway.listTools),
    mcpCall: (threadId, input) =>
      Effect.flatMap(mcpTarget(threadId, input.server), (target) =>
        gateway.callTool(target, input.tool, input.arguments ?? {}),
      ),

    drain: worker.drain,
  });
});

export const layer = Layer.effect(CrewRunService, make);
