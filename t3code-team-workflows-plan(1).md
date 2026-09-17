# Team workflows for T3 Code: implementation plan

This plan adds an orchestrator mode to a personal fork of `pingdotgg/t3code`. A thread's host model becomes an orchestrator. It plans the work and spawns worker threads, each in its own worktree with a provider, model, and effort chosen in Settings. The first workflow is a full-stack team.

Research for this plan used `pingdotgg/t3code` at commit `2c19283` (2026-09-14). File paths below are from that commit. If the fork is newer, re-check each path before editing.

## 0. Instructions for the coding agent

- Read `AGENTS.md` and `docs/internals/overview.md` before writing code. Read `.repos/effect-smol/LLMS.md` before writing Effect code on the server.
- This is a personal fork. Do not open a PR against upstream. Upstream does not accept large features.
- Keep changes additive where possible. t3code has over 2,000 commits and moves fast, so small, isolated edits to shared files make rebasing easier.
- Follow the "three ways to hurt yourself" rules in `AGENTS.md`. Never kill processes by pattern, never write to `~/.t3/userdata`, and never set `VITE_HTTP_URL` or `VITE_WS_URL`.
- Run only targeted tests (`vp test run <files>`) and targeted typecheck. Do not run repo-wide checks.
- Do phase 0 (the spike) first and report findings before building on its assumptions.

## 1. What the user sees

1. **Settings → Workflows** lists workflow presets. v1 ships one built-in preset, "Full-stack team". Each role row has an on/off toggle, a provider and model picker, an effort picker, a permission mode, and an optional instructions field. The page also sets max parallel workers and max review rounds.
2. Each project row in the sidebar gets an **orchestrator button** next to the existing new-thread icon. Clicking it opens a new draft thread with a workflow already selected.
3. The composer toolbar gets a **Workflow** chip next to the existing permission-mode chip ("Full access"). The chip does not replace it. Options are "None" (a normal thread) or any preset. The existing model chip picks the host, which becomes the orchestrator.
4. The user sends a message. The orchestrator reads the repo, writes a short plan, and spawns workers through tools. Independent workers run in parallel.
5. Worker threads appear in the sidebar with a role badge and a link back to their orchestrator. The orchestrator thread gets a **Team** tab in the right panel that shows each worker's role, model, state, branch, and diff size.
6. When workers finish, the server posts a batched update into the orchestrator thread. The orchestrator then integrates the branches, starts a QA worker, and routes failures back to implementers. When QA approves, it reports to the user. The user merges. The orchestrator never merges into the base branch.

### Not in v1

- User-defined workflows beyond editing the built-in preset. The data model supports several presets, but the UI only needs to handle one.
- Nested sidebar trees for workers. v1 uses a badge and a parent link.
- Starting or editing teams from mobile. Worker threads are ordinary threads, so mobile can already view them.
- Opening PRs automatically. Workers commit to local branches unless the user asks for a PR.

## 2. Naming

Two names are already taken in t3code:

- **"orchestration"** is the server's event-sourcing engine (`apps/server/src/orchestration/`, `OrchestrationEngine`, `OrchestrationCommand`). Do not name new code `orchestration*`.
- **"workflow"** is already a Claude harness concept. The Agents panel shows workflow runs, and `apps/server/src/orchestration/workflowScriptQuery.ts` reads workflow scripts.

Use **team** in code: `TeamWorkflow`, `TeamRole`, `ThreadTeamInfo`, MCP capability `"team"`, tools prefixed `team_`. The user-facing labels stay "Workflows" (settings page and composer chip) and "Orchestrator" (sidebar button and thread badge).

## 3. Existing t3code pieces this plan reuses

| Need | Existing piece | Location |
|---|---|---|
| Give the orchestrator tools across all providers | In-server MCP HTTP server with per-thread capabilities. Every adapter (Claude, Codex, Cursor, Grok, OpenCode, Antigravity) already wires it in. | `apps/server/src/mcp/McpHttpServer.ts`, `McpInvocationContext.ts`, `toolkits/` |
| Decide which tools a thread gets | `agentAccessCapabilities(threadId)` builds the capability set per session | `apps/server/src/provider/Layers/ProviderService.ts` (around line 906) |
| Toolkit template that reads projections and dispatches commands | Pull-requests toolkit | `apps/server/src/mcp/toolkits/pullRequests/` |
| Create a thread, prepare a worktree, run the setup script, and start a turn in one call | `thread.turn.start` with `bootstrap.createThread` and `bootstrap.prepareWorktree` | Contract in `packages/contracts/src/orchestration.ts`. Handler is `dispatchBootstrapTurnStart` in `apps/server/src/ws.ts` (around line 1047). |
| Per-role provider, model, and effort | `ModelSelection { instanceId, model, options }` | `packages/contracts/src/orchestration.ts` |
| Inject role instructions into every provider | `buildRuntimeInstructions()`, which all six adapters call | `apps/server/src/provider/RuntimeInstructions.ts` |
| Background worker that reacts to thread state | Drainable-worker reactors | `apps/server/src/orchestration/ThreadSettlementReactor.ts` |
| Know when a worker's turn ended | `thread.latestTurn.state` (`running`, `completed`, `interrupted`, `error`) | `OrchestrationLatestTurn` in contracts |
| Model and effort pickers outside the composer | `ProviderModelPicker`, and `TraitsPicker` with `onModelOptionsChange` | Already used in `apps/web/src/components/settings/ProjectDefaultsSettings.tsx` |
| Fleet-style list UI | Agents panel, including its layout rules (fixed row heights, static dots, no repainting timers) | `apps/web/src/components/AgentsPanel.tsx` |
| Environment-owned settings | `ServerSettings` schema and settings scope system | `packages/contracts/src/settings.ts`, `apps/web/src/routes/settings.*.tsx` |
| Settings nav entry | `SETTINGS_SECTION_LABELS` and `SETTINGS_SECTION_ICONS` | `apps/web/src/components/settings/SettingsSidebarNav.tsx` |

## 4. Data model (`packages/contracts`)

### 4.1 Workflow presets (server settings)

Presets live in `ServerSettings`, not in client preferences. They reference `ProviderInstanceId`, and provider instances belong to an environment. This follows the "Settings ownership" section of `docs/internals/overview.md`.

```ts
// packages/contracts/src/team.ts (new file, exported from index.ts)
export const TeamRoleId = TrimmedNonEmptyString.pipe(Schema.brand("TeamRoleId"));

export const TeamRoleKind = Schema.Literals(["implementer", "reviewer"]);

export const TeamRole = Schema.Struct({
  id: TeamRoleId,                          // "frontend", "backend", "database", "devops", "qa"
  label: TrimmedNonEmptyString,            // "Frontend"
  kind: TeamRoleKind,
  enabled: Schema.Boolean,
  summary: Schema.String,                  // "UI, components". Shown to the orchestrator.
  modelSelection: Schema.NullOr(ModelSelection), // null means "same as host"
  runtimeMode: Schema.NullOr(RuntimeMode),       // null means "same as orchestrator thread"
  instructions: Schema.String,             // role prompt; empty string uses the built-in text
});

export const TeamWorkflow = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,             // "Full-stack team"
  builtIn: Schema.Boolean,
  roles: Schema.Array(TeamRole),
  maxParallelWorkers: PositiveInt,         // default 4
  maxReviewRounds: PositiveInt,            // default 2
  maxAutoReports: PositiveInt,             // default 30, per user message
  orchestratorInstructions: Schema.String, // appended to the built-in orchestrator prompt
});
```

Add to `ServerSettings`:

```ts
teamWorkflows: Schema.Array(TeamWorkflow).pipe(
  Schema.withDecodingDefault(Effect.succeed([])),
),
```

Add the matching optional key to the settings patch schema. The same file already has patch schemas like the one around line 1351. When the list is empty, the server fills in the built-in preset. Store the built-in preset as a constant in `packages/shared` so web and server use the same one.

### 4.2 Team info on threads (persisted events)

```ts
export const ThreadTeamInfo = Schema.Union([
  Schema.Struct({
    role: Schema.Literal("orchestrator"),
    workflow: TeamWorkflow,               // snapshot taken at creation
  }),
  Schema.Struct({
    role: Schema.Literal("worker"),
    orchestratorThreadId: ThreadId,
    roleId: TeamRoleId,
    roleLabel: TrimmedNonEmptyString,
    taskTitle: TrimmedNonEmptyString,
    reviewRound: Schema.optional(NonNegativeInt),
  }),
]);
```

- Add `team: Schema.optional(ThreadTeamInfo)` to `ThreadCreateCommand`, `ThreadTurnStartBootstrapCreateThread`, `ThreadCreatedPayload`, and the thread shell and detail read models.
- The field must stay optional. Old `thread.created` events have to decode on replay (see "Durable intent and side effects" in the overview doc).
- Add a projection column (JSON) in the SQLite projection layer, following how `pullRequests` was added. Update `ProjectionPipeline.ts` and `ProjectionSnapshotQuery.ts`.
- **Why snapshot the workflow:** if the user edits a role's model while a team is running, the running team keeps the configuration it started with. New teams use the new settings.

### 4.3 Environment capability flag

Add `teamWorkflows: true` to the environment descriptor. Clients hide the orchestrator button and Workflow chip when the connected environment does not advertise it. This follows the existing `threadPullRequests` pattern described in the overview doc.

## 5. Server work (`apps/server`)

### 5.1 Extract the bootstrap dispatcher

`dispatchBootstrapTurnStart` is a closure inside `ws.ts`. The MCP toolkit needs the same behavior, so move it into a service:

- New `apps/server/src/orchestration/Services/ThreadBootstrap.ts` and `Layers/ThreadBootstrap.ts` with `dispatch(command: ThreadTurnStartCommand) => Effect<{ sequence }, OrchestrationDispatchCommandError>`.
- `ws.ts` calls the service. Behavior must not change, and the existing tests covering bootstrap (`serverRuntimeStartup.worktreeSetup.test.ts` and the ws tests) must still pass.
- Do this as its own commit before any team code, so a regression is easy to find.

### 5.2 Grant the `team` capability

- `McpInvocationContext.ts`: extend `McpCapability` with `"team"`.
- `ProviderService.agentAccessCapabilities`: read the thread shell. If `team?.role === "orchestrator"`, add `"team"`. Workers do not get it, so they cannot spawn more workers.
- `McpHttpServer.ts`: register a `TeamToolkitRegistrationLive` next to the pull-requests registration.

### 5.3 Team toolkit (`apps/server/src/mcp/toolkits/team/`)

Copy the structure of `toolkits/pullRequests/` (`tools.ts`, `handlers.ts`, `handlers.test.ts`). Every handler starts with `requireMcpCapability("team")` and reads the orchestrator thread from the invocation scope.

| Tool | Input | Behavior |
|---|---|---|
| `team_roster` | none | Returns the snapshot's enabled roles (id, label, kind, summary, resolved model and effort), limits, and every worker of this orchestrator with its state, branch, and last update time. |
| `team_spawn_worker` | `roleId`, `title` (40 chars max), `task`, optional `baseBranch`, optional `reviewRound` | Validates that the role is enabled and that fewer than `maxParallelWorkers` workers are running. Resolves the model: the role's `modelSelection`, or the orchestrator thread's if null. Resolves the permission mode the same way. Dispatches `thread.turn.start` through `ThreadBootstrap` with `createThread` (including `team`), `prepareWorktree` (`baseBranch` defaults to the orchestrator thread's branch or the project default; the branch name is `team/<orchestrator short id>/<roleId>-<slug>`), and `runSetupScript: true`. Returns `workerThreadId` and `branch` right away without waiting for the turn. |
| `team_get_worker` | `workerThreadId` | Returns state, branch, worktree path, the last assistant message (truncated to about 4,000 chars), turn diff stats, pending approvals or questions, and linked PRs. |
| `team_message_worker` | `workerThreadId`, `message` | Starts a new turn on the worker. If the worker's turn is running, returns a `WorkerBusyError` telling the orchestrator to wait for the next update. Do not steer running turns in v1. |
| `team_stop_worker` | `workerThreadId` | Dispatches `thread.session.stop` for that worker. |
| `team_integrate` | `branches` (ordered), optional `targetBranch` | See 5.6. |

Rules for all tools:

- A worker must belong to the calling orchestrator. Otherwise return a "not your worker" error.
- Errors are tagged schema errors with plain-language `message` getters, like `PullRequestTargetIncompleteError`. The model reads them.
- Parallel spawning needs no special code. The orchestrator calls `team_spawn_worker` several times in one turn, and each call returns once its intent is committed.
- Never swap in a different model silently. If the role's provider instance is missing or unavailable, fail with an error that names the instance. This rule comes from claudex-loop and AO.

### 5.4 Role instructions

Extend `buildRuntimeInstructions` to accept an optional `team` block and append:

- For an orchestrator: the built-in orchestrator prompt (section 7.2), the roster summary, and `orchestratorInstructions`.
- For a worker: the built-in worker prompt (section 7.3), the role prompt (`instructions`, or the built-in role text when empty), and the orchestrator's thread title.

Each adapter already calls `buildRuntimeInstructions`, but they do not all have the thread's team info at that call site. Pass it through the same path that carries `McpProviderSessionConfig`. Record which adapters needed changes. Per `AGENTS.md`, each provider needs an explicit decision.

The task text itself goes in the worker's first user message, not in the system prompt. It then shows up in the worker thread like any other message.

### 5.5 Report reactor (`apps/server/src/orchestration/TeamReportReactor.ts`)

This reactor tells the orchestrator when workers finish, so the orchestrator never has to poll or hold a tool call open. It plays the same role as AO's lifecycle manager.

- Subscribe to domain events. When a worker thread's `latestTurn` moves to `completed`, `error`, or `interrupted`, or the worker gets a pending approval or user-input request, add an entry to that orchestrator's pending report list.
- Flush when the orchestrator thread has no running turn: dispatch one `thread.turn.start` on the orchestrator with all pending entries. Reports that arrive while the orchestrator is busy wait for its current turn to end, which batches parallel completions without timers.
- Message format: a short fixed header (`Team update`) followed by one block per worker with role, title, state, branch, diff stats, and the last assistant message truncated to about 1,500 chars. Mark the message with a `context` record so the UI can render it as a system update instead of a user bubble. Check `composerContext.ts` for a suitable record kind, or add a `team-report` kind.
- **Pending approvals:** report them once, then do nothing else. Never start turns on a worker that is waiting for approval (AO follows the same rule). The user answers the approval in the worker thread.
- **Runaway guard:** count automatic report turns since the last real user message. At `maxAutoReports`, stop flushing and append an activity to the orchestrator thread: "Paused automatic team updates. Send a message to continue."
- **Stop:** if the user interrupts or stops the orchestrator session, clear its pending reports and do not flush again until the next user message.
- Keep the pending list in memory and rebuild it on startup from projections: workers whose last turn ended after the orchestrator's last turn started. Use `makeDrainableWorker` so tests can wait on drains without sleeps.
- Register the reactor where `ThreadSettlementReactor` is registered.

### 5.6 Integration and the QA loop

The diagram's "QA and review agent" and "failed checks loop back" parts work like this:

1. When implementers report done, the orchestrator calls `team_integrate` with their branches in dependency order (for example database, backend, frontend, devops).
2. `team_integrate` runs on the server with no agent. It creates or reuses the worktree for `team/<id>/integration`, based on the project base branch, and merges each branch with `git merge --no-ff`. Use the existing git services in `apps/server/src/git/`. Do not shell out ad hoc.
   - If a merge conflicts, it runs `git merge --abort` and returns the conflicting branch and file list. The orchestrator then spawns or messages a worker to rebase that branch and fix the conflict.
   - If everything merges, it returns the integration branch name and head SHA.
   - It never touches the base branch.
3. The orchestrator spawns the `qa` role (kind `reviewer`) with `baseBranch` set to the integration branch and `reviewRound: 1`. The QA prompt requires a final line with exactly one verdict: `VERDICT: APPROVED`, `VERDICT: REVISE`, or `VERDICT: BLOCKED`, followed by findings that each name the role that owns the fix. This verdict format comes from claudex-loop.
4. On `REVISE`, the orchestrator messages the owning workers with the findings, integrates again, and spawns QA with `reviewRound + 1`. `team_spawn_worker` rejects reviewer spawns beyond `maxReviewRounds`. At that point the orchestrator reports the remaining findings to the user.
5. On `APPROVED`, the orchestrator tells the user the integration branch is ready. The user merges with t3code's existing git actions.

**Different provider for review.** Following claudex-loop, the built-in preset recommends that QA use a different provider than the implementers. The settings page shows a hint when QA resolves to the same provider instance as most implementers. It does not enforce this.

### 5.7 Limits and safety

- Only orchestrator threads get the `team` capability. Workers cannot spawn workers.
- The orchestrator prompt forbids editing files. v1 does not enforce this with permissions, because the orchestrator needs shell access to read the repo. Record this in the spike (section 10) and revisit it if orchestrators edit code in practice.
- Archiving or deleting an orchestrator asks whether to do the same to its workers. The default is yes. Every way in needs a way out: the Team panel has "Stop all workers", and a stopped worker can be resumed by messaging it.
- Worktree cleanup uses the existing flow (`apps/web/src/worktreeCleanup.ts`). Never force-delete a worktree with uncommitted changes.
- MCP tools run on the environment, so remote and relay connections work without extra code. Check this in phase 7.

## 6. Client work (`apps/web`, `packages/client-runtime`)

### 6.1 Settings → Workflows

- New route `apps/web/src/routes/settings.workflows.tsx`. Register it in `SETTINGS_SECTION_LABELS` and `SETTINGS_SECTION_ICONS` (use `WorkflowIcon` or `UsersIcon` from lucide).
- The page has a preset list (one entry in v1) and a preset editor. Build the role rows from `ProjectDefaultsSettings.tsx`, which already combines `ProviderModelPicker` with `TraitsPicker` in `onModelOptionsChange` mode.
- Each role row has an enabled switch, label, summary, model picker (with a "Same as host" option that stores `null`), effort picker (hidden for "Same as host"), permission mode select ("Same as orchestrator" plus the four modes), and a collapsible instructions textarea with a "Reset to default" action.
- Preset-level fields are max parallel workers, max review rounds, max automatic updates, and extra orchestrator instructions.
- Provide "Restore built-in preset".
- Writes go through the normal server settings update RPC, so the settings scope selector (environment and project) applies unchanged. Project overrides are out of scope for v1. Show the environment scope only.
- Add the page to settings search (`components/settings/settingsSearch.ts`).

### 6.2 Composer Workflow chip

- New `apps/web/src/components/chat/WorkflowPicker.tsx`. Style it like the permission-mode chip (`runtimeModeConfig.ts`, `ComposerControl.tsx`) and place it right after that chip.
- Draft state: add `teamWorkflowId: string | null` to the composer draft store (`composerDraftStore.ts`). The default is `null`.
- On first send, `composerSubmission.ts` includes `team: { role: "orchestrator", workflow: <resolved preset snapshot> }` in `bootstrap.createThread`.
- After the thread exists, the chip becomes read-only and shows the preset name. Clicking it opens the Team panel.
- Hide the chip for existing non-team threads and for worker threads.
- Handle the compact layout in `CompactComposerControlsMenu.tsx` and `composerFooterLayout.ts`.
- The placeholder text for orchestrator drafts is "Describe the feature for your team…" (`composerPlaceholder.ts`).

### 6.3 Orchestrator entry points

Per the "hit every surface" rule in `AGENTS.md`:

- **Sidebar.** Add an icon button to the project row in `Sidebar.tsx`, next to the new-thread button (the `SquarePenIcon` usage). Its tooltip is "New orchestrator thread". It calls the existing `handleNewThread` path with `teamWorkflowId` preset to the first enabled workflow.
- **Command palette.** Add "New orchestrator thread" (`CommandPalette.logic.ts`).
- **Keybinding.** Add a new command, `chat.newOrchestrator`, with no default binding (`keybindings.ts`, contracts `keybindings.ts`).
- Hide all three when the environment lacks the `teamWorkflows` capability.

### 6.4 Team panel and worker badges

- Add a **Team** tab to the right panel (`RightPanelTabs.tsx`, `rightPanelStore.ts`) for orchestrator threads. Each row shows role, task title, model and effort, state dot, branch, diff stats, and actions (open, stop, message). Follow the Agents panel rules: fixed row height, stable order, static dots, and no repainting timers.
- Worker threads get a role badge in `Sidebar.tsx` rows and `ChatHeader.tsx`, plus a "Back to orchestrator" link in the header.
- Render report messages (section 5.5) as a compact collapsible card in `MessagesTimeline.tsx`, not as a user bubble.
- Put shared selectors (workers of an orchestrator, and derived team status) in `packages/client-runtime` so mobile can reuse them later.

### 6.5 Mobile

v1 changes nothing on mobile. Worker and orchestrator threads already appear there as normal threads. Report cards fall back to plain text, which is acceptable. Record this decision in the PR description or commit message.

## 7. Built-in "Full-stack team" preset

### 7.1 Roles

| id | label | kind | summary | default model | default permission mode |
|---|---|---|---|---|---|
| `frontend` | Frontend | implementer | UI, components | Same as host | Same as orchestrator |
| `backend` | Backend | implementer | APIs, logic | Same as host | Same as orchestrator |
| `database` | Database | implementer | Schema, migrations | Same as host | Same as orchestrator |
| `devops` | DevOps | implementer | CI/CD, infra | Same as host | Same as orchestrator |
| `qa` | QA and review | reviewer | Tests, code review | Same as host (settings suggest another provider) | Same as orchestrator |

Limits are max parallel 4, max review rounds 2, and max automatic updates 30.

The default role prompts below are short originals. They draw on the role files in VoltAgent/awesome-claude-code-subagents (MIT): `frontend-developer.md`, `backend-developer.md`, `database-administrator.md`, `devops-engineer.md`, `qa-expert.md`, and `code-reviewer.md`. Do not paste those files in. They reference a "context manager" agent that does not exist here and use a lot of tokens.

- **Frontend.** Build UI in the project's existing component library and styling system. Match existing patterns before adding new ones. Handle loading, empty, and error states. Run the project's frontend tests and type checks for the files you touched.
- **Backend.** Implement APIs and business logic in the project's existing framework. Validate input at the boundary. Return typed errors. Add focused tests for new behavior.
- **Database.** Write schema changes as migrations the project's tooling can run forward. State whether each migration is reversible. Do not modify existing migrations. Report the new schema to the orchestrator in your final message so other roles can build on it.
- **DevOps.** Change CI, build, and deployment configuration only as the task requires. Never add or print secrets. Explain any new environment variable in your final message.
- **QA and review.** You are reviewing the integration branch. Do not add features. Run the test suite and the checks the project defines. Read the diff against the base branch. Report findings with file and line, severity, and the owning role. End with exactly one line: `VERDICT: APPROVED`, `VERDICT: REVISE`, or `VERDICT: BLOCKED`.

### 7.2 Orchestrator prompt (draft)

These rules draw on AO's orchestrator prompt (`backend/internal/session_manager/prompt.go`, Apache-2.0). The text is original.

```
<team_orchestrator>
You coordinate a team of worker agents in T3 Code for this project. You plan and delegate. You do not implement.

Rules
- Never edit files, commit, or push in this thread. Workers do all implementation, tests, and fixes.
- Read the repository and ask the user about decisions that change the outcome before you spawn anyone.
- Before spawning, write a short plan: tasks, owning role, dependencies, and the order you will integrate.
- Use team_roster to see available roles and running workers. Do not start a second worker for a task that already has one.
- Spawn independent tasks in the same turn so they run in parallel. Give a dependent task the prerequisite worker's branch as baseBranch, after that worker reports done.
- Each task message states the goal, the files or areas involved, the acceptance checks, and what to report back.
- Do not use your own built-in subagent or task tools. Use team_* tools only.
- You will receive "Team update" messages when workers finish or need attention. Do not poll.
- If a worker is waiting for approval, tell the user which thread needs them.
- When implementers are done, call team_integrate, then spawn the qa role on the integration branch. Route REVISE findings to the owning workers. Stop after the review-round limit and report what remains.
- Never merge into the base branch. When QA approves, tell the user the integration branch is ready to merge.
- If a role's model is unavailable, report the error. Do not pick a different model.
</team_orchestrator>
```

### 7.3 Worker prompt (draft)

```
<team_worker>
You are the {roleLabel} worker on a T3 Code team led by the orchestrator thread "{orchestratorTitle}".
Work only on the task in the first message. You are in your own worktree on branch {branch}.
Inspect the relevant code before editing. Keep changes inside your task. Commit your work to this branch with conventional commit messages. Do not push or open a PR unless the task says to.
Do not use built-in subagent or task-delegation tools.
If you need a decision, ask it and stop.
Finish with a short report: what changed, files touched, checks you ran and their results, and anything another role needs to know.
</team_worker>
```

## 8. End-to-end walkthrough

1. The user clicks the orchestrator button on a project. A draft opens with Workflow set to "Full-stack team" and the host set to whichever provider and model the user picks in the model chip.
2. The user sends "Add saved searches with a new table, API, and UI."
3. The client sends `thread.turn.start` with `bootstrap.createThread.team = { role: "orchestrator", workflow: snapshot }`.
4. The provider session starts. `agentAccessCapabilities` adds `"team"`. `buildRuntimeInstructions` appends the orchestrator prompt.
5. The orchestrator reads the repo, posts a plan, and calls `team_spawn_worker(database, ...)`. The backend and frontend tasks depend on the schema, so it waits.
6. The database worker finishes. `TeamReportReactor` posts a Team update to the orchestrator.
7. The orchestrator spawns backend and frontend in one turn, both with `baseBranch` set to the database branch. They run in parallel.
8. Both finish, and the reactor batches both reports into one update.
9. The orchestrator calls `team_integrate([database, backend, frontend])`, then spawns `qa` on `team/<id>/integration`.
10. QA returns `VERDICT: REVISE` with one backend finding. The orchestrator messages the backend worker, integrates again, and spawns QA round 2.
11. QA returns `VERDICT: APPROVED`. The orchestrator tells the user the integration branch is ready. The user merges it with the git actions.

## 9. Phases and acceptance checks

Each phase ends in a working state and gets its own commit.

**Phase 0: spike (no product code).** Answer the questions in section 10 and write the answers up before continuing.

**Phase 1: contracts and settings.**
- Add `team.ts`, `ServerSettings.teamWorkflows`, the patch key, the built-in preset in `packages/shared`, `ThreadTeamInfo` on the commands, events, and read models, and the capability flag.
- Check: contract tests decode an old `thread.created` payload with no `team` field, and a new one with each role variant. Settings tests show that an empty `teamWorkflows` resolves to the built-in preset.

**Phase 2: extract `ThreadBootstrap`.**
- Check: the existing bootstrap and worktree tests pass unchanged. `ws.ts` no longer defines `dispatchBootstrapTurnStart`.

**Phase 3: projections.**
- Add the `team` column, and make the projector and snapshot queries return it.
- Check: projector tests show the team info on the shell and detail after `thread.created`, and after replay.

**Phase 4: capability and toolkit.**
- Check (handler tests with mocked engine and projections):
  - `team_spawn_worker` dispatches a bootstrap command with the resolved model, the resolved permission mode, a worktree on the expected branch, and worker team info.
  - Spawning past `maxParallelWorkers` fails.
  - Spawning a disabled role fails.
  - A reviewer spawn past `maxReviewRounds` fails.
  - `team_message_worker` on a running worker returns `WorkerBusyError`.
  - A worker thread's session does not get the `team` capability.

**Phase 5: instructions.**
- Check: unit tests on `buildRuntimeInstructions` for the orchestrator, worker, and plain-thread cases. The list of adapters touched is recorded.

**Phase 6: report reactor.**
- Check (using drains, not sleeps):
  - Two workers completing while the orchestrator is busy produce exactly one turn start after the orchestrator goes idle.
  - A pending approval produces one report and no turn start on the worker.
  - The runaway guard stops at the limit and resets on a real user message.
  - A stopped orchestrator receives no further updates.
  - Startup rebuilds unreported completions.

**Phase 7: first manual run.**
- Use a seeded worktree database, following the "Test data" section of `AGENTS.md`. Create an orchestrator thread by calling the RPC directly and let it spawn two workers on a toy repo.
- Check: both workers run at once in separate worktrees, the updates arrive, and remote access via `vp run dev --share` still works. Ask the user before doing any browser or computer-use verification.

**Phase 8: `team_integrate` and the QA loop.**
- Check with git fixture tests: a clean merge returns the SHA. A conflict aborts and returns the files, and leaves the integration worktree clean. The base branch is never modified.

**Phase 9: Settings → Workflows page.**
- Check: editing a role's model and effort persists to server settings and survives a reload. "Same as host" stores `null`. "Restore built-in preset" works. The page shows up in settings search.

**Phase 10: composer chip, sidebar button, palette, keybinding.**
- Check: every entry point creates an orchestrator thread with the snapshot. The chip is read-only after the first send. The controls are hidden when the environment lacks the capability. The compact composer layout works.

**Phase 11: Team panel, badges, report cards.**
- Check: rows keep a fixed height while state changes, and stop and message work from the panel. With five workers and streaming output, the panel adds no continuous GPU repaint (check in devtools performance).

**Phase 12: user docs.** Add a short "Team workflows" section to `docs/user/` covering how to start, where settings live, and that the user merges. Add a short internal note only for the report-reactor design, since it spans components.

## 10. Spike questions (phase 0)

1. **Tool visibility per provider.** Do the `t3-code` MCP tools appear and work in each provider you plan to use as host? Test Claude and Codex at minimum. Record any provider that cannot act as orchestrator and hide it in the host picker when a workflow is selected.
2. **Turn start on a busy thread.** What happens today when `thread.turn.start` targets a thread with a running turn? Read `ProviderCommandReactor.ts` (the `turnsAfterCompaction` queue) and each adapter's steer handling. The reactor design assumes it can wait for idle, so confirm that "idle" can be read reliably from projections.
3. **Bootstrap without a client.** Does anything in `dispatchBootstrapTurnStart` depend on the WebSocket client, such as the setup-script terminal attaching to a client or `worktreeSetupTracker` expecting a subscriber? A server-initiated bootstrap must work with no client connected.
4. **Instructions plumbing.** Which adapters can see thread team info at their `buildRuntimeInstructions` call site?
5. **Orchestrator editing files.** In a trial run with "Full access", does the host follow the no-edit rule? If not, consider running orchestrator threads with `auto-accept-edits` off, or with a provider-level read-only setting where one exists.
6. **Concurrency cost.** Check CPU and memory with four workers plus the orchestrator using `apps/server/src/resourceTelemetry`. Adjust the default `maxParallelWorkers` if needed.

## 11. Decisions already made (change them here before coding)

- Workers commit to local branches. They do not push or open PRs unless the task says to.
- The server posts updates to the orchestrator. There is no blocking "wait for workers" tool.
- Integration uses a server-side git merge into a dedicated integration branch. The user merges into the base branch.
- Workers cannot spawn workers.
- Presets are environment settings. Running teams use the snapshot taken at creation.
- The default for every role's model is "Same as host". QA carries a suggestion to use another provider.
- Mobile gets no new controls in v1.

## 12. Sources

- T3 Code: `pingdotgg/t3code` (MIT), commit `2c19283`.
- Agent Orchestrator: `Untrivial-ai/agent-orchestrator` https://github.com/Untrivial-ai/agent-orchestrator (Apache-2.0). The ideas taken are the orchestrator/worker split, feedback routed to the owning worker, never nudging blocked workers, and required short worker labels.
- claudex-loop: `chaseai-yt/claudex-loop` https://github.com/chaseai-yt/claudex-loop (MIT). The ideas taken are cross-provider review, the APPROVED/REVISE/BLOCKED verdict, bounded review rounds, and no silent model fallback.
- awesome-claude-code-subagents: `VoltAgent/awesome-claude-code-subagents` https://github.com/VoltAgent/awesome-claude-code-subagents (MIT). The role prompts in section 7.1 are original text informed by its role files.
