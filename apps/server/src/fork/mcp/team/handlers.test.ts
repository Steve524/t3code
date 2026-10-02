// @effect-diagnostics nodeBuiltinImport:off - junction fixtures work on Windows without symlink privileges.
import * as NodeFSP from "node:fs/promises";

import {
  EnvironmentId,
  CheckpointRef,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  TeamRoleId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type TeamWorkflow,
} from "@t3tools/contracts";
import { BUILT_IN_RESEARCH_PLAN_WORKFLOW, BUILT_IN_TEAM_WORKFLOW } from "@t3tools/shared/team";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as TeamBranchIntegration from "../../git/TeamBranchIntegration.ts";
import * as ThreadBootstrap from "../../orchestration/Services/ThreadBootstrap.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderInstance } from "../../../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../../../provider/Services/ProviderInstanceRegistry.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as WorkspaceEntries from "../../../workspace/WorkspaceEntries.ts";
import { TeamToolkitHandlersLive } from "./handlers.ts";
import { TeamToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-team");
const ORCHESTRATOR_ID = ThreadId.make("thread-team-orchestrator");
const WORKER_ID = ThreadId.make("thread-team-worker");
const HOST_INSTANCE_ID = ProviderInstanceId.make("codex-host");
const ROLE_INSTANCE_ID = ProviderInstanceId.make("claude-work");

const workflow = (overrides: Partial<TeamWorkflow> = {}): TeamWorkflow => ({
  ...BUILT_IN_TEAM_WORKFLOW,
  roles: BUILT_IN_TEAM_WORKFLOW.roles.map((role) =>
    role.id === TeamRoleId.make("frontend")
      ? {
          ...role,
          modelSelection: {
            instanceId: ROLE_INSTANCE_ID,
            model: "claude-sonnet",
            options: [{ id: "effort", value: "high" }],
          },
          runtimeMode: "approval-required",
        }
      : role,
  ),
  ...overrides,
});

function shell(
  input: Partial<OrchestrationThreadShell> & Pick<OrchestrationThreadShell, "id" | "team">,
): OrchestrationThreadShell {
  return {
    projectId: PROJECT_ID,
    title: "Team thread",
    modelSelection: { instanceId: HOST_INSTANCE_ID, model: "gpt-host" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-09-15T10:00:00.000Z",
    updatedAt: "2026-09-15T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

const orchestrator = (teamWorkflow = workflow()) =>
  shell({
    id: ORCHESTRATOR_ID,
    title: "Ship the feature",
    team: { role: "orchestrator", workflow: teamWorkflow },
  });

const worker = (
  overrides: Partial<OrchestrationThreadShell> = {},
  orchestratorThreadId = ORCHESTRATOR_ID,
) =>
  shell({
    id: WORKER_ID,
    title: "Build UI",
    modelSelection: {
      instanceId: ROLE_INSTANCE_ID,
      model: "claude-sonnet",
      options: [{ id: "effort", value: "high" }],
    },
    runtimeMode: "approval-required",
    branch: "team/thread-t/frontend-build-ui",
    worktreePath: "/workspace/project-worker",
    team: {
      role: "worker",
      orchestratorThreadId,
      roleId: TeamRoleId.make("frontend"),
      roleLabel: "Frontend",
      taskTitle: "Build UI",
    },
    ...overrides,
  });

function detail(thread: OrchestrationThreadShell): OrchestrationThread {
  return {
    ...thread,
    messages: [
      {
        id: MessageId.make("assistant-worker"),
        role: "assistant",
        text: "Done.",
        turnId: TurnId.make("turn-worker"),
        streaming: false,
        createdAt: "2026-09-15T10:01:00.000Z",
        updatedAt: "2026-09-15T10:01:00.000Z",
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [
      {
        turnId: TurnId.make("turn-worker"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-team-worker/1"),
        status: "ready",
        files: [{ path: "src/ui.ts", kind: "modified", additions: 8, deletions: 3 }],
        assistantMessageId: MessageId.make("assistant-worker"),
        completedAt: "2026-09-15T10:01:00.000Z",
      },
    ],
    deletedAt: null,
  };
}

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["team"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-team"),
  threadId: ORCHESTRATOR_ID,
  providerSessionId: "provider-session-team",
  providerInstanceId: HOST_INSTANCE_ID,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

interface HarnessOptions {
  readonly workspaceRoot?: string;
  readonly invocationThreadId?: ThreadId;
  readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
  readonly providerAvailable?: boolean;
  readonly driverKind?: string;
  readonly integrateResult?: TeamBranchIntegration.GitIntegrateBranchesResult;
}

const makeHarness = Effect.fn("makeTeamToolkitHarness")(function* (options: HarnessOptions = {}) {
  const threads = options.threads ?? [orchestrator()];
  const bootstrapCommands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const engineCommands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const refreshedRoots = yield* Ref.make<ReadonlyArray<string>>([]);
  const integrationInputs = yield* Ref.make<
    ReadonlyArray<TeamBranchIntegration.GitIntegrateBranchesInput>
  >([]);
  const recordBootstrap: ThreadBootstrap.ThreadBootstrapShape["dispatch"] = (command) =>
    Ref.update(bootstrapCommands, (commands) => [...commands, command]).pipe(
      Effect.as({ sequence: 1 }),
    );
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Ref.update(engineCommands, (commands) => [...commands, command]).pipe(
      Effect.as({ sequence: 1 }),
    );
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    WorkspaceFileSystem.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({
          refresh: (cwd) => Ref.update(refreshedRoots, (roots) => [...roots, cwd]),
        }),
      ),
      Layer.provide(NodeServices.layer),
    ),
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Effect.succeed(Option.fromNullishOr(threads.find((thread) => thread.id === threadId))),
      getProjectShellById: (projectId) =>
        Effect.succeed(
          projectId === PROJECT_ID
            ? Option.some({
                id: PROJECT_ID,
                title: "Project",
                workspaceRoot: options.workspaceRoot ?? "/workspace/project",
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-09-15T10:00:00.000Z",
                updatedAt: "2026-09-15T10:00:00.000Z",
              })
            : Option.none(),
        ),
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          projects: [],
          threads,
          updatedAt: "2026-09-15T10:00:00.000Z",
        }),
      getThreadDetailById: (threadId) =>
        Effect.succeed(
          Option.fromNullishOr(threads.find((thread) => thread.id === threadId)).pipe(
            Option.map(detail),
          ),
        ),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.mock(ThreadBootstrap.ThreadBootstrap)({ dispatch: recordBootstrap }),
    Layer.mock(ProviderInstanceRegistry)({
      getInstance: () =>
        Effect.succeed(
          options.providerAvailable === false
            ? undefined
            : ({ enabled: true, driverKind: options.driverKind ?? "codex" } as ProviderInstance),
        ),
    }),
    Layer.mock(GitWorkflowService.GitWorkflowService)({
      listRefs: () =>
        Effect.succeed({
          refs: [
            {
              name: "main",
              current: true,
              isDefault: true,
              worktreePath: "/workspace/project",
            },
          ],
          isRepo: true,
          hasPrimaryRemote: true,
          nextCursor: null,
          totalCount: 1,
        }),
    }),
    Layer.mock(TeamBranchIntegration.TeamBranchIntegration)({
      integrateBranches: (input) =>
        Ref.update(integrationInputs, (inputs) => [...inputs, input]).pipe(
          Effect.as(
            options.integrateResult ?? {
              status: "merged",
              branch: "team/thread-t/integration",
              worktreePath: "/workspace/integration",
              headSha: "abc123",
            },
          ),
        ),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const toolkit = yield* TeamToolkit.pipe(
    Effect.provide(TeamToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof TeamToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["team"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => chunk.at(-1)!.result as Tool.Success<(typeof TeamToolkit.tools)[Name]>),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...invocation(capabilities),
        threadId: options.invocationThreadId ?? ORCHESTRATOR_ID,
      }),
      Effect.provide(dependencies),
    );
  return { bootstrapCommands, engineCommands, integrationInputs, refreshedRoots, call };
});

describe("team toolkit handlers", () => {
  it.effect("writes a plan artifact in approval-required mode through the workspace writer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "team-artifact-" });
        const harness = yield* makeHarness({
          workspaceRoot: cwd,
          threads: [
            { ...orchestrator(BUILT_IN_RESEARCH_PLAN_WORKFLOW), runtimeMode: "approval-required" },
          ],
        });
        expect(
          yield* harness.call("team_write_plan_artifact", {
            relativePath: "docs/plans/plan.md",
            contents: "# Plan\n",
          }),
        ).toEqual({ relativePath: "docs/plans/plan.md" });
        expect(yield* fs.readFileString(`${cwd}/docs/plans/plan.md`)).toBe("# Plan\n");
        expect(yield* Ref.get(harness.refreshedRoots)).toEqual([cwd]);
        expect(yield* Ref.get(harness.bootstrapCommands)).toEqual([]);
        expect(yield* Ref.get(harness.engineCommands)).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "rejects traversal, absolute paths, Windows aliases and paths outside the artifact allowlist",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "team-artifact-" });
          const harness = yield* makeHarness({
            workspaceRoot: cwd,
            threads: [orchestrator(BUILT_IN_RESEARCH_PLAN_WORKFLOW)],
          });
          for (const relativePath of [
            "../outside.md",
            "docs/plans/../../outside.md",
            "docs\\plans\\..\\..\\outside.md",
            "docs/plans/../plans/plan.md",
            "docs/plans/.. /plan.md",
            "docs/plans/.../plan.md",
            "docs/plans/nested./plan.md",
            "docs/plans/nested /plan.md",
            "/docs/plans/plan.md",
            "\\docs\\plans\\plan.md",
            "C:\\temp\\plan.md",
            "C:/temp/plan.md",
            "C:docs/plans/plan.md",
            "\\\\server\\share\\plan.md",
            "docs/plans/plan.md:stream.md",
            "docs/plans/plan\u0000.md",
            "docs/plans/plan\n.md",
            "docs/plans/plan\u007f.md",
            "src/plan.md",
            "docs/plans-other/plan.md",
            "docs/research-other/brief.md",
            "docs/adr-other/decision.md",
            "docs/plans/plan.txt",
            "docs/plans/plan.MD",
            "docs/adr/script.ts",
            "README.md",
            "CONTEXT.md.backup",
          ]) {
            expect(
              yield* harness
                .call("team_write_plan_artifact", { relativePath, contents: "rejected" })
                .pipe(Effect.flip),
              relativePath,
            ).toMatchObject({ _tag: "TeamPlanArtifactPathError" });
          }
          expect(yield* Ref.get(harness.refreshedRoots)).toEqual([]);
          expect(yield* fs.readDirectory(cwd)).toEqual([]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "normalizes artifact paths, uses the workflow snapshot and writes in the planner worktree",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const project = yield* fs.makeTempDirectoryScoped({ prefix: "team-project-" });
          const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "team-artifact-" });
          const harness = yield* makeHarness({
            workspaceRoot: project,
            threads: [
              {
                ...orchestrator({
                  ...BUILT_IN_RESEARCH_PLAN_WORKFLOW,
                  plansDir: "notes\\plans/",
                  researchDir: "notes/./research/",
                }),
                worktreePath: checkout,
              },
            ],
          });
          const paths = [
            ["notes\\plans\\nested\\plan.md", "notes/plans/nested/plan.md"],
            ["notes//plans/./review-log.md", "notes/plans/review-log.md"],
            ["./notes/research/brief.md", "notes/research/brief.md"],
            ["docs/adr/0001-decision.md", "docs/adr/0001-decision.md"],
            ["CONTEXT.md", "CONTEXT.md"],
            ["CONTEXT-MAP.md", "CONTEXT-MAP.md"],
            ["packages/domain/CONTEXT.md", "packages/domain/CONTEXT.md"],
            ["contexts/domain/CONTEXT-MAP.md", "contexts/domain/CONTEXT-MAP.md"],
          ];
          for (const [relativePath, normalized] of paths) {
            const contents = `# ${normalized}\n\nArtifact with Unicode: café.\n`;
            expect(
              yield* harness.call("team_write_plan_artifact", {
                relativePath: relativePath!,
                contents,
              }),
            ).toEqual({ relativePath: normalized });
            expect(yield* fs.readFileString(`${checkout}/${normalized}`)).toBe(contents);
          }
          yield* harness.call("team_write_plan_artifact", {
            relativePath: "notes/plans/review-log.md",
            contents: "# Log\n\n## Round 2\n",
          });
          expect(yield* fs.readFileString(`${checkout}/notes/plans/review-log.md`)).toBe(
            "# Log\n\n## Round 2\n",
          );
          for (const relativePath of ["docs/plans/plan.md", "docs/research/brief.md"]) {
            expect(
              yield* harness
                .call("team_write_plan_artifact", { relativePath, contents: "rejected" })
                .pipe(Effect.flip),
            ).toMatchObject({ _tag: "TeamPlanArtifactPathError", reason: "outside-allowlist" });
          }
          expect(yield* fs.readDirectory(project)).toEqual([]);
          expect(yield* Ref.get(harness.refreshedRoots)).toEqual(
            Array.from({ length: paths.length + 1 }, () => checkout),
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not grant broad writes from legacy root artifact folders", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cases = [
          ...[".", "./", ".\\", "././", ".//", ".\\./"].map((plansDir) => ({
            plansDir,
            researchDir: "notes/research",
            allowed: "notes/research/brief.md",
          })),
          { plansDir: "notes/plans", researchDir: ".", allowed: "notes/plans/plan.md" },
          { plansDir: ".//", researchDir: ".\\./", allowed: null },
        ];
        for (const { plansDir, researchDir, allowed } of cases) {
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "team-artifact-" });
          yield* fs.writeFileString(`${cwd}/README.md`, "unchanged");
          const harness = yield* makeHarness({
            workspaceRoot: cwd,
            threads: [orchestrator({ ...BUILT_IN_RESEARCH_PLAN_WORKFLOW, plansDir, researchDir })],
          });
          for (const relativePath of [
            "CLAUDE.md",
            "AGENTS.md",
            "README.md",
            "./2026-01-01-plan.md",
            "src/plan.md",
            ".claude/commands/probe.md",
            "docs/plans/plan.md",
          ]) {
            expect(
              yield* harness
                .call("team_write_plan_artifact", { relativePath, contents: "rejected" })
                .pipe(Effect.flip),
            ).toMatchObject({ _tag: "TeamPlanArtifactPathError", reason: "outside-allowlist" });
          }
          expect(yield* fs.readFileString(`${cwd}/README.md`)).toBe("unchanged");
          expect(yield* fs.readDirectory(cwd)).toEqual(["README.md"]);
          expect(yield* Ref.get(harness.refreshedRoots)).toEqual([]);
          for (const relativePath of [
            "docs/adr/0001-decision.md",
            "CONTEXT.md",
            "CONTEXT-MAP.md",
            ...(allowed ? [allowed] : []),
          ]) {
            yield* harness.call("team_write_plan_artifact", {
              relativePath,
              contents: "# Artifact",
            });
            expect(yield* fs.readFileString(`${cwd}/${relativePath}`)).toBe("# Artifact");
          }
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses default artifact folders for an older workflow snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "team-artifact-" });
        const {
          plansDir: _plansDir,
          researchDir: _researchDir,
          ...oldWorkflow
        } = BUILT_IN_RESEARCH_PLAN_WORKFLOW;
        const harness = yield* makeHarness({
          workspaceRoot: cwd,
          threads: [orchestrator(oldWorkflow)],
        });
        for (const relativePath of ["docs/plans/plan.md", "docs/research/brief.md"]) {
          yield* harness.call("team_write_plan_artifact", { relativePath, contents: "# Artifact" });
          expect(yield* fs.readFileString(`${cwd}/${relativePath}`)).toBe("# Artifact");
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("requires a team credential and a plan-type orchestrator before accessing files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "team-artifact-" });
        const cases = [
          {
            threads: [orchestrator(BUILT_IN_RESEARCH_PLAN_WORKFLOW)],
            capabilities: ["preview"] as const,
            tag: "McpCapabilityUnavailableError",
          },
          { threads: [orchestrator()], tag: "TeamPlanWorkflowRequiredError" },
          {
            threads: [worker()],
            invocationThreadId: WORKER_ID,
            tag: "TeamOrchestratorRequiredError",
          },
          {
            threads: [shell({ id: ORCHESTRATOR_ID, team: undefined })],
            tag: "TeamOrchestratorRequiredError",
          },
          { threads: [], tag: "TeamThreadNotFoundError" },
        ];
        for (const { tag, capabilities, ...options } of cases) {
          const harness = yield* makeHarness({ ...options, workspaceRoot: cwd });
          expect(
            yield* harness
              .call(
                "team_write_plan_artifact",
                {
                  relativePath: "docs/plans/plan.md",
                  contents: "rejected",
                },
                capabilities,
              )
              .pipe(Effect.flip),
          ).toMatchObject({ _tag: tag });
          expect(yield* Ref.get(harness.refreshedRoots)).toEqual([]);
        }
        expect(yield* fs.readDirectory(cwd)).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "rejects directory symlinks and Windows junctions before creating artifact parents",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "team-artifact-" });
          const outside = yield* fs.makeTempDirectoryScoped({ prefix: "team-outside-" });
          yield* fs.makeDirectory(`${cwd}/docs/research`, { recursive: true });
          yield* fs.makeDirectory(`${cwd}/src`);
          yield* fs.writeFileString(`${cwd}/src/source.md`, "original");
          yield* Effect.tryPromise(() => NodeFSP.symlink(outside, `${cwd}/docs/plans`, "junction"));
          yield* Effect.tryPromise(() =>
            NodeFSP.symlink(`${cwd}/src`, `${cwd}/docs/research/linked`, "junction"),
          );
          const harness = yield* makeHarness({
            workspaceRoot: cwd,
            threads: [orchestrator(BUILT_IN_RESEARCH_PLAN_WORKFLOW)],
          });
          for (const relativePath of ["docs/plans/new/plan.md", "docs/research/linked/source.md"]) {
            expect(
              yield* harness
                .call("team_write_plan_artifact", { relativePath, contents: "rejected" })
                .pipe(Effect.flip),
            ).toMatchObject({ _tag: "TeamPlanArtifactPathError", reason: "symlink" });
          }
          expect(yield* fs.readDirectory(outside)).toEqual([]);
          expect(yield* fs.readFileString(`${cwd}/src/source.md`)).toBe("original");
          expect(yield* Ref.get(harness.refreshedRoots)).toEqual([]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(!symlinksSupported)("rejects existing and dangling artifact file symlinks", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "team-artifact-" });
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "team-outside-" });
        yield* fs.makeDirectory(`${cwd}/docs/plans`, { recursive: true });
        yield* fs.writeFileString(`${outside}/original.md`, "original");
        yield* fs.symlink(`${outside}/original.md`, `${cwd}/docs/plans/linked.md`);
        yield* fs.symlink(`${outside}/missing.md`, `${cwd}/docs/plans/dangling.md`);
        const harness = yield* makeHarness({
          workspaceRoot: cwd,
          threads: [orchestrator(BUILT_IN_RESEARCH_PLAN_WORKFLOW)],
        });
        for (const relativePath of ["docs/plans/linked.md", "docs/plans/dangling.md"]) {
          expect(
            yield* harness
              .call("team_write_plan_artifact", { relativePath, contents: "rejected" })
              .pipe(Effect.flip),
          ).toMatchObject({ _tag: "TeamPlanArtifactPathError", reason: "symlink" });
        }
        expect(yield* fs.readFileString(`${outside}/original.md`)).toBe("original");
        expect(yield* fs.exists(`${outside}/missing.md`)).toBe(false);
        expect(yield* Ref.get(harness.refreshedRoots)).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("surfaces workspace write failures without refreshing the cache", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "team-artifact-" });
        yield* fs.makeDirectory(`${cwd}/docs/plans/directory.md`, { recursive: true });
        const harness = yield* makeHarness({
          workspaceRoot: cwd,
          threads: [orchestrator(BUILT_IN_RESEARCH_PLAN_WORKFLOW)],
        });
        expect(
          yield* harness
            .call("team_write_plan_artifact", {
              relativePath: "docs/plans/directory.md",
              contents: "rejected",
            })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "TeamOperationFailedError", operation: "write" });
        expect(yield* fs.readDirectory(`${cwd}/docs/plans/directory.md`)).toEqual([]);
        expect(yield* Ref.get(harness.refreshedRoots)).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("spawns a worker with the resolved role settings and worktree bootstrap", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("team_spawn_worker", {
        roleId: TeamRoleId.make("frontend"),
        title: "Build UI",
        task: "Implement the settings form.",
      });
      expect(result.branch).toBe("team/thread-t/frontend-07070707");
      const command = (yield* Ref.get(harness.bootstrapCommands))[0];
      expect(command).toMatchObject({
        type: "thread.turn.start",
        message: { text: "Implement the settings form." },
        modelSelection: {
          instanceId: ROLE_INSTANCE_ID,
          model: "claude-sonnet",
          options: [{ id: "effort", value: "high" }],
        },
        runtimeMode: "approval-required",
        bootstrap: {
          createThread: {
            projectId: PROJECT_ID,
            title: "Build UI",
            branch: "main",
            worktreePath: null,
            team: {
              role: "worker",
              orchestratorThreadId: ORCHESTRATOR_ID,
              roleId: "frontend",
              roleLabel: "Frontend",
              taskTitle: "Build UI",
            },
          },
          prepareWorktree: {
            projectCwd: "/workspace/project",
            baseBranch: "main",
            branch: "team/thread-t/frontend-07070707",
          },
          runSetupScript: true,
        },
      });

      yield* harness.call("team_spawn_worker", {
        roleId: TeamRoleId.make("backend"),
        title: "Build API",
        task: "Implement the endpoint.",
      });
      expect((yield* Ref.get(harness.bootstrapCommands))[1]).toMatchObject({
        modelSelection: { instanceId: HOST_INSTANCE_ID, model: "gpt-host" },
        runtimeMode: "full-access",
      });
    }),
  );

  it.effect("keeps worker branch names short for Windows worktree checkouts", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("team_spawn_worker", {
        roleId: TeamRoleId.make("frontend"),
        title: "Locate TeamPanel.tsx read-only",
        task: "Find the Team panel source file.",
      });
      expect(result.branch?.length).toBeLessThanOrEqual(40);
      expect(result.branch).toMatch(/^team\/thread-t\/frontend-[0-9a-f]{8}$/);
    }),
  );

  it.effect("lists resolved roles and owned workers", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ threads: [orchestrator(), worker()] });
      const result = yield* harness.call("team_roster", {});
      expect(result.limits).toEqual({ maxParallelWorkers: 4, maxReviewRounds: 2 });
      expect(result.roles.find((role) => role.id === TeamRoleId.make("frontend"))).toMatchObject({
        modelSelection: { instanceId: ROLE_INSTANCE_ID, model: "claude-sonnet" },
        runtimeMode: "approval-required",
      });
      expect(result.workers).toMatchObject([
        {
          workerThreadId: WORKER_ID,
          roleId: "frontend",
          branch: "team/thread-t/frontend-build-ui",
          state: "idle",
        },
      ]);
    }),
  );

  it.effect("fails instead of replacing an unavailable provider instance", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ providerAvailable: false });
      const error = yield* harness
        .call("team_spawn_worker", {
          roleId: TeamRoleId.make("frontend"),
          title: "Build UI",
          task: "Implement it.",
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "TeamProviderUnavailableError",
        instanceId: ROLE_INSTANCE_ID,
      });
      expect(yield* Ref.get(harness.bootstrapCommands)).toEqual([]);
    }),
  );

  it.effect("enforces parallel worker, disabled role, and review round limits", () =>
    Effect.gen(function* () {
      const runningWorker = worker({
        session: {
          threadId: WORKER_ID,
          status: "running",
          providerName: "Claude",
          providerInstanceId: ROLE_INSTANCE_ID,
          runtimeMode: "approval-required",
          activeTurnId: TurnId.make("turn-running"),
          lastError: null,
          updatedAt: "2026-09-15T10:00:00.000Z",
        },
      });
      const limited = yield* makeHarness({
        threads: [orchestrator(workflow({ maxParallelWorkers: 1 })), runningWorker],
      });
      expect(
        yield* limited
          .call("team_spawn_worker", {
            roleId: TeamRoleId.make("frontend"),
            title: "Second worker",
            task: "Implement it.",
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "TeamWorkerLimitError", limit: 1 });

      const disabled = workflow({
        roles: workflow().roles.map((role) =>
          role.id === TeamRoleId.make("frontend") ? { ...role, enabled: false } : role,
        ),
      });
      const disabledHarness = yield* makeHarness({ threads: [orchestrator(disabled)] });
      expect(
        yield* disabledHarness
          .call("team_spawn_worker", {
            roleId: TeamRoleId.make("frontend"),
            title: "Disabled",
            task: "Implement it.",
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "TeamRoleDisabledError" });

      const reviewHarness = yield* makeHarness({
        threads: [orchestrator(workflow({ maxReviewRounds: 1 }))],
      });
      expect(
        yield* reviewHarness
          .call("team_spawn_worker", {
            roleId: TeamRoleId.make("qa"),
            title: "Review",
            task: "Review it.",
            reviewRound: 2,
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "TeamReviewRoundLimitError", limit: 1, reviewRound: 2 });

      yield* reviewHarness.call("team_spawn_worker", {
        roleId: TeamRoleId.make("qa"),
        title: "Review integration",
        task: "Review the integrated changes.",
        baseBranch: "team/thread-t/integration",
        reviewRound: 1,
      });
      expect((yield* Ref.get(reviewHarness.bootstrapCommands))[0]).toMatchObject({
        bootstrap: {
          createThread: {
            branch: "team/thread-t/integration",
            team: { roleId: "qa", reviewRound: 1 },
          },
          prepareWorktree: { baseBranch: "team/thread-t/integration" },
        },
      });
    }),
  );

  it.effect(
    "runs Claude read-only workers in the planner's checkout in approval-required mode",
    () =>
      Effect.gen(function* () {
        const planner = shell({
          id: ORCHESTRATOR_ID,
          branch: "feature/plan",
          worktreePath: "/workspace/planner-worktree",
          interactionMode: "plan",
          team: {
            role: "orchestrator",
            workflow: {
              ...BUILT_IN_RESEARCH_PLAN_WORKFLOW,
              roles: BUILT_IN_RESEARCH_PLAN_WORKFLOW.roles.map((role) => ({
                ...role,
                runtimeMode: "full-access" as const,
              })),
            },
          },
        });
        const harness = yield* makeHarness({ threads: [planner], driverKind: "claudeAgent" });
        const roster = yield* harness.call("team_roster", {});
        expect(roster.roles.map(({ runtimeMode }) => runtimeMode)).toEqual([
          "approval-required",
          "approval-required",
        ]);
        for (const roleId of ["researcher", "plan-reviewer"]) {
          const result = yield* harness.call("team_spawn_worker", {
            roleId: TeamRoleId.make(roleId),
            title: "Read-only task",
            task: "Read the plan.",
            baseBranch: "ignored",
            planPath: "docs/plans/missing.md",
          });
          expect(result.branch).toBeNull();
        }
        const commands = yield* Ref.get(harness.bootstrapCommands);
        expect(commands).toHaveLength(2);
        for (const command of commands) {
          if (command.type !== "thread.turn.start") throw new Error("Expected a turn start");
          // The role's full-access and the planner's plan mode are both replaced.
          expect(command).toMatchObject({
            runtimeMode: "approval-required",
            interactionMode: "default",
            message: { text: "Read the plan." },
            bootstrap: {
              createThread: {
                branch: "feature/plan",
                worktreePath: "/workspace/planner-worktree",
                runtimeMode: "approval-required",
                interactionMode: "default",
              },
              runSetupScript: false,
            },
          });
          expect(command.bootstrap?.prepareWorktree).toBeUndefined();
        }
      }),
  );

  it.effect("isolates read-only workers on other providers and inlines the plan", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "team-planner-" });
        yield* fs.makeDirectory(`${checkout}/docs/plans`, { recursive: true });
        yield* fs.writeFileString(`${checkout}/docs/plans/p.md`, "# Plan\n\nUncommitted text.");
        const planner = shell({
          id: ORCHESTRATOR_ID,
          branch: "feature/plan",
          worktreePath: checkout,
          team: {
            role: "orchestrator",
            workflow: {
              ...BUILT_IN_RESEARCH_PLAN_WORKFLOW,
              roles: BUILT_IN_RESEARCH_PLAN_WORKFLOW.roles.map((role) => ({
                ...role,
                runtimeMode: "approval-required" as const,
              })),
            },
          },
        });
        const harness = yield* makeHarness({ threads: [planner], driverKind: "codex" });
        // An isolated worker follows the planner's modes, not a stored role mode.
        const roster = yield* harness.call("team_roster", {});
        expect(roster.roles.map(({ runtimeMode }) => runtimeMode)).toEqual([
          "full-access",
          "full-access",
        ]);
        const result = yield* harness.call("team_spawn_worker", {
          roleId: TeamRoleId.make("plan-reviewer"),
          title: "Review plan",
          task: "Review the plan.",
          planPath: "docs/plans/p.md",
        });
        expect(result.branch).toBe("team/thread-t/plan-rev-07070707");
        const [command] = yield* Ref.get(harness.bootstrapCommands);
        if (command?.type !== "thread.turn.start") throw new Error("Expected a turn start");
        expect(command).toMatchObject({
          runtimeMode: "full-access",
          bootstrap: {
            createThread: { branch: "feature/plan", worktreePath: null },
            prepareWorktree: {
              baseBranch: "feature/plan",
              branch: "team/thread-t/plan-rev-07070707",
            },
            runSetupScript: false,
          },
        });
        expect(command.message.text).toContain("isolated worktree of `feature/plan`");
        expect(command.message.text).toContain("# Plan\n\nUncommitted text.");

        expect(
          yield* harness
            .call("team_spawn_worker", {
              roleId: TeamRoleId.make("plan-reviewer"),
              title: "Review plan",
              task: "Review the plan.",
              planPath: "../outside.md",
            })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "TeamPlanFileError", reason: "outside-checkout" });
        expect(
          yield* harness
            .call("team_spawn_worker", {
              roleId: TeamRoleId.make("plan-reviewer"),
              title: "Review plan",
              task: "Review the plan.",
              planPath: "docs/plans/missing.md",
            })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "TeamPlanFileError", reason: "unreadable" });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("sends the revised plan to an isolated reviewer only", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "team-planner-" });
        yield* fs.writeFileString(`${checkout}/plan.md`, "Revised plan.");
        const planner = shell({
          id: ORCHESTRATOR_ID,
          worktreePath: checkout,
          team: { role: "orchestrator", workflow: BUILT_IN_RESEARCH_PLAN_WORKFLOW },
        });
        const reviewer = (id: string, worktreePath: string) =>
          worker({
            id: ThreadId.make(id),
            worktreePath,
            team: {
              role: "worker",
              orchestratorThreadId: ORCHESTRATOR_ID,
              roleId: TeamRoleId.make("plan-reviewer"),
              roleLabel: "Plan reviewer",
              taskTitle: "Review plan",
            },
          });
        const harness = yield* makeHarness({
          threads: [planner, reviewer("isolated", "/worktrees/r"), reviewer("shared", checkout)],
        });
        for (const id of ["isolated", "shared"]) {
          yield* harness.call("team_message_worker", {
            workerThreadId: ThreadId.make(id),
            message: "Round 2.",
            planPath: "plan.md",
          });
        }
        const [isolated, shared] = yield* Ref.get(harness.bootstrapCommands);
        if (isolated?.type !== "thread.turn.start" || shared?.type !== "thread.turn.start") {
          throw new Error("Expected turn starts");
        }
        expect(isolated.message.text).toContain("Round 2.");
        expect(isolated.message.text).toContain("Revised plan.");
        expect(shared.message.text).toBe("Round 2.");
        // Its checkpoint would show the planner's edits, so no diff totals are reported.
        const detail = yield* harness.call("team_get_worker", {
          workerThreadId: ThreadId.make("shared"),
        });
        expect(detail.diffStats).toBeNull();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("caps plan-reviewer rounds and refuses to integrate a plan workflow", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        threads: [
          orchestrator({ ...BUILT_IN_RESEARCH_PLAN_WORKFLOW, maxReviewRounds: 2 }),
          worker(),
        ],
      });
      expect(
        yield* harness
          .call("team_spawn_worker", {
            roleId: TeamRoleId.make("plan-reviewer"),
            title: "Review plan",
            task: "Review it.",
            reviewRound: 3,
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "TeamReviewRoundLimitError", limit: 2, reviewRound: 3 });
      expect(
        yield* harness
          .call("team_integrate", { branches: ["team/thread-t/frontend-build-ui"] })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "TeamIntegrationUnsupportedError" });
      expect(yield* Ref.get(harness.integrationInputs)).toEqual([]);
    }),
  );

  it.effect("rejects messaging a running worker", () =>
    Effect.gen(function* () {
      const running = worker({
        latestTurn: {
          turnId: TurnId.make("turn-running"),
          state: "running",
          requestedAt: "2026-09-15T10:00:00.000Z",
          startedAt: "2026-09-15T10:00:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      });
      const harness = yield* makeHarness({ threads: [orchestrator(), running] });
      const error = yield* harness
        .call("team_message_worker", {
          workerThreadId: WORKER_ID,
          message: "Please revise it.",
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "WorkerBusyError", workerThreadId: WORKER_ID });
      expect(yield* Ref.get(harness.bootstrapCommands)).toEqual([]);
    }),
  );

  it.effect("enforces ownership for every worker-specific tool", () =>
    Effect.gen(function* () {
      const foreign = worker({}, ThreadId.make("other-orchestrator"));
      const harness = yield* makeHarness({ threads: [orchestrator(), foreign] });
      const getError = yield* harness
        .call("team_get_worker", { workerThreadId: WORKER_ID })
        .pipe(Effect.flip);
      const messageError = yield* harness
        .call("team_message_worker", { workerThreadId: WORKER_ID, message: "Continue." })
        .pipe(Effect.flip);
      const stopError = yield* harness
        .call("team_stop_worker", { workerThreadId: WORKER_ID })
        .pipe(Effect.flip);
      expect([getError, messageError, stopError].map((error) => error._tag)).toEqual([
        "TeamWorkerOwnershipError",
        "TeamWorkerOwnershipError",
        "TeamWorkerOwnershipError",
      ]);
      expect(yield* Ref.get(harness.bootstrapCommands)).toEqual([]);
      expect(yield* Ref.get(harness.engineCommands)).toEqual([]);
    }),
  );

  it.effect("returns worker details and dispatches message and stop commands", () =>
    Effect.gen(function* () {
      const ownedWorker = worker();
      const harness = yield* makeHarness({ threads: [orchestrator(), ownedWorker] });
      const result = yield* harness.call("team_get_worker", { workerThreadId: WORKER_ID });
      expect(result).toMatchObject({
        workerThreadId: WORKER_ID,
        worktreePath: "/workspace/project-worker",
        lastAssistantMessage: "Done.",
        diffStats: { files: 1, additions: 8, deletions: 3 },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      });
      yield* harness.call("team_message_worker", {
        workerThreadId: WORKER_ID,
        message: "Please revise it.",
      });
      yield* harness.call("team_stop_worker", { workerThreadId: WORKER_ID });
      expect(yield* Ref.get(harness.bootstrapCommands)).toMatchObject([
        { type: "thread.turn.start", threadId: WORKER_ID, message: { text: "Please revise it." } },
      ]);
      expect(yield* Ref.get(harness.engineCommands)).toMatchObject([
        { type: "thread.session.stop", threadId: WORKER_ID },
      ]);
    }),
  );

  it.effect("integrates owned worker branches in order without targeting the base branch", () =>
    Effect.gen(function* () {
      const ownedWorker = worker();
      const harness = yield* makeHarness({ threads: [orchestrator(), ownedWorker] });
      const result = yield* harness.call("team_integrate", {
        branches: ["team/thread-t/frontend-build-ui"],
      });

      expect(result).toEqual({
        status: "merged",
        branch: "team/thread-t/integration",
        headSha: "abc123",
      });
      expect(yield* Ref.get(harness.integrationInputs)).toEqual([
        {
          cwd: "/workspace/project",
          baseBranch: "main",
          integrationBranch: "team/thread-t/integration",
          branches: ["team/thread-t/frontend-build-ui"],
        },
      ]);

      const foreign = yield* harness
        .call("team_integrate", { branches: ["feature/not-owned"] })
        .pipe(Effect.flip);
      expect(foreign).toMatchObject({
        _tag: "TeamIntegrationBranchOwnershipError",
        branch: "feature/not-owned",
      });

      const baseTarget = yield* harness
        .call("team_integrate", {
          branches: ["team/thread-t/frontend-build-ui"],
          targetBranch: "main",
        })
        .pipe(Effect.flip);
      expect(baseTarget).toMatchObject({ _tag: "TeamIntegrationTargetError", branch: "main" });
      expect(yield* Ref.get(harness.integrationInputs)).toHaveLength(1);
    }),
  );

  it.effect("returns the conflicting worker branch and files", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        threads: [orchestrator(), worker()],
        integrateResult: {
          status: "conflict",
          branch: "team/thread-t/integration",
          worktreePath: "/workspace/integration",
          conflictingBranch: "team/thread-t/frontend-build-ui",
          conflictingFiles: ["src/ui.ts"],
        },
      });
      expect(
        yield* harness.call("team_integrate", {
          branches: ["team/thread-t/frontend-build-ui"],
        }),
      ).toEqual({
        status: "conflict",
        branch: "team/thread-t/integration",
        conflictingBranch: "team/thread-t/frontend-build-ui",
        conflictingFiles: ["src/ui.ts"],
      });
    }),
  );

  it.effect("refuses a credential without the team capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness.call("team_roster", {}, ["pull-requests"]).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "team",
      });
    }),
  );
});
