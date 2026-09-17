# Team workflows implementation progress

This checklist tracks the implementation of the team workflows feature described in `t3code-team-workflows-plan(1).md`.

## Status

- Current phase: Phase 11 complete; Phase 7's remote-environment check remains outstanding
- Completed phases: 10 of 13
- Blocked checks: Browser verification awaits user approval. Remote sharing cannot be confirmed because Tailscale is not installed or running on this host.
- Rule: Finish each phase's acceptance checks before starting the next phase. Commit product-code phases separately; do not commit spike notes or plans under the repository's work-artifact rule.

## Phase 0: Spike

- [x] Confirm that the `t3-code` MCP tools work for each intended host provider, including Claude and Codex.
- [x] Record providers that cannot act as orchestrators and how the host picker will exclude them.
- [x] Confirm how `thread.turn.start` behaves when the target thread already has a running turn.
- [x] Confirm that projections reliably expose whether a thread is idle.
- [x] Confirm that server-initiated bootstrap works without a connected WebSocket client.
- [x] Record which adapters can access thread team info when they call `buildRuntimeInstructions`.
- [x] Trial the orchestrator prompt under Full Access and record whether the host edits files.
- [x] Measure CPU and memory with four workers plus the orchestrator.
- [x] Decide whether the default worker limit should remain four.
- [x] Write up the findings before adding product code.
- [x] Leave the spike record uncommitted as required by `AGENTS.md`.

### Findings recorded 2026-09-15

#### Provider MCP support

- Claude Code 2.1.271 and Codex MCP client 0.154.0 each discovered and called a Streamable HTTP MCP tool under the `t3-code` server name. Both returned `TEAM_SPIKE_OK` in read-only sessions.
- The existing `McpHttpServer` test for T3's pull-request toolkit passed, including tool registration and capability rejection. The live probes and this handler test cover the provider transport and T3 handler separately.
- All six adapters inject the same session-scoped T3 MCP endpoint and bearer credential. Claude and Codex were live-tested. Cursor, Grok, OpenCode, and Antigravity are not installed on this machine, so their support is code-audited but not live-tested. The user approved code-audit-only coverage for these four providers.
- No provider-specific incompatibility was found. The existing provider registry already excludes unavailable or unconfigured instances from model selection, so v1 needs no separate orchestrator deny list unless a later live test finds a provider-specific failure.
- A Codex session with approval policy `never` can list the tool but rejects its call. The normal T3 runtime mode must continue to supply the session's approval behavior. Automatic approval review completed the read-only probe.

#### Starting a turn while another turn runs

- `thread.turn.start` is accepted and persisted while a provider turn is running. The decider does not reject it as busy.
- Claude, Cursor, and OpenCode steer the active turn. Grok and Antigravity cancel or replace the active prompt and reuse the active turn. Codex queues a follow-up provider turn and keeps the current active turn ID until it settles.
- The `turnsAfterCompaction` queue is only for compaction. It is not a general busy-thread queue.
- The team report reactor must not dispatch while the orchestrator is `starting` or `running`, because that would steer, replace, or queue work depending on the provider.

#### Reliable idle state

- Thread shell and detail projections expose `session.status` and `latestTurn.state`. The targeted projection test confirmed that a running session appears as a running latest turn in command, shell, and full snapshots.
- `session.status` is the authoritative turn boundary. `latestTurn` can remain completed after the session becomes idle and is therefore not enough by itself.
- A `thread.turn-start-requested` event creates a pending turn row before the provider projects `session.status = starting`. That pending row is not exposed on the thread shell. The report reactor must also track pending turn-start events or query `ProjectionTurns`; checking the shell session alone has a race.

#### Bootstrap without a client

- Bootstrap work runs in a detached fiber registered with `WorktreeSetupTracker`. The code explicitly outlives the requesting WebSocket connection.
- Setup-script terminals belong to the server terminal manager. Tracker subscriptions only observe progress and are not required for execution.
- The existing parameterized server test passed both async and sync setup cases. The sync case interrupts the requesting RPC before the setup script exits and confirms that the server still starts the turn and finishes the setup.
- Extraction into `ThreadBootstrap` must replace `dispatchFromClient` with engine dispatch plus optional origin metadata. Team-initiated bootstraps have no client origin. Analytics stay at the WebSocket boundary.

#### Runtime instruction plumbing

- No adapter can read future thread team info at its current `buildRuntimeInstructions` call site.
- Claude reads `McpProviderSession` beside its instruction builder. Codex passes MCP capabilities into `CodexSessionRuntime`. Cursor, Grok, OpenCode, and Antigravity read the MCP session while creating their provider session, then build instructions from adapter context during turns.
- The smallest shared path is to add the resolved team instruction block to `McpProviderSessionConfig` and retain it in each adapter's session context. This avoids six projection dependencies and keeps provider-specific changes at the adapter boundary.

#### Full Access prompt trial

- Claude Code and Codex each ran the draft orchestrator no-edit rule with unrestricted permissions in a disposable repository. Both read the fixture and left its only file unchanged at SHA-256 `E9A34F9FDBF90AAA6BA5EDA08A6385F2EE464295FF225BAE8EB0B8E964E88F83`; no files were added or removed.
- Claude followed the requested read-only flow directly. Codex did not edit, but it attempted its built-in delegation tool despite the draft rule forbidding built-in subagents. The attempt failed in ephemeral execution, after which Codex completed the read-only task itself.
- Keep the no-edit prompt for v1. Do not treat prompt text as a security boundary. The later team capability still needs to expose only the intended `team_*` tools and the prompt must continue to forbid built-in delegation.

#### Five-session resource measurement

- One Codex orchestrator and four Claude Haiku workers ran concurrently in the disposable fixture. All five completed successfully.
- T3's native resource monitor protocol v3 captured 42 snapshots, including 12 with all five provider roots alive. The concurrent peak was 188.83% CPU, where 100% is one logical CPU, and 2,619,338,752 resident bytes across 69 provider processes.
- The host had 8 logical CPUs and 34,197,966,848 total memory bytes. The measured peak was about 24% of logical CPU capacity and 7.7% of physical memory. Keep `maxParallelWorkers = 4` as the built-in default; users can lower it on smaller machines.
- The source checkout had no compiled resource-monitor binary and Rust was not installed. The measurement used the protocol-compatible Windows x64 monitor from the official same-day T3 Code nightly archive.

#### Checks run

- `McpHttpServer.test.ts`: pull-request toolkit registration and capability error passed.
- `ClaudeAdapter.test.ts`: running-turn steer passed.
- `CursorAdapter.test.ts`: running-turn steer passed.
- `GrokAdapter.test.ts`: mid-turn cancellation and steer passed.
- `OpenCodeAdapter.test.ts`: running-turn steer passed.
- `AntigravityAdapter.test.ts`: cancellation before steer passed.
- `CodexSessionRuntime.test.ts`: inline MCP configuration and app-server arguments passed.
- `ProjectionSnapshotQuery.test.ts`: persisted latest-turn state in command, shell, and full snapshots passed.
- `server.test.ts`: both setup-script bootstrap cases passed, including client disconnection during the sync case.

## Phase 1: Contracts and settings

- [x] Add `packages/contracts/src/team.ts` and export it.
- [x] Add `ServerSettings.teamWorkflows` and its settings patch key.
- [x] Add the built-in Full-stack team preset to `packages/shared`.
- [x] Add optional `ThreadTeamInfo` to thread creation commands, events, shell, and detail read models.
- [x] Add the `teamWorkflows` environment capability flag.
- [x] Test that old `thread.created` payloads without `team` still decode.
- [x] Test both orchestrator and worker variants of new `thread.created` payloads.
- [x] Test that an empty workflow setting resolves to the built-in preset.
- [x] Run targeted contract and settings checks.
- [x] Commit phase 1 (`0e3f59cea`).

## Phase 2: Extract ThreadBootstrap

- [x] Move `dispatchBootstrapTurnStart` from `ws.ts` into a `ThreadBootstrap` service and layer.
- [x] Update `ws.ts` to call the service without changing behavior.
- [x] Confirm that `ws.ts` no longer defines `dispatchBootstrapTurnStart`.
- [x] Run the existing targeted bootstrap, worktree setup, and WebSocket tests unchanged.
- [x] Commit phase 2 separately from team behavior (`0d11a2eec`).

### Phase 2 checks

- `server.test.ts`: 10 focused bootstrap and worktree cases passed unchanged.
- `serverRuntimeStartup.worktreeSetup.test.ts`: 2 cases passed unchanged.
- Server typecheck, targeted lint, formatting, and staged diff checks passed.

## Phase 3: Projections

- [x] Add the optional team JSON column to the SQLite projection layer.
- [x] Update `ProjectionPipeline.ts` to persist team info.
- [x] Update `ProjectionSnapshotQuery.ts` to return team info.
- [x] Test team info on the thread shell after `thread.created`.
- [x] Test team info on thread detail after `thread.created`.
- [x] Test that replay restores team info.
- [x] Run targeted projection checks.
- [x] Commit phase 3 (`cf28168df`).

### Phase 3 checks

- Migration 053 preserves existing thread rows and decodes their missing team as `null`.
- `ProjectionPipeline.test.ts`: 33 cases passed, including shell/detail persistence and replay restoration.
- `ProjectionSnapshotQuery.test.ts`: 32 existing compatibility cases passed.
- Server typecheck, targeted lint, formatting, and staged diff checks passed.
- Rollback remains compatible: the migration only adds a nullable column, which older binaries ignore.

## Phase 4: Team capability and MCP toolkit

- [x] Add the `team` MCP capability.
- [x] Grant it only to orchestrator threads.
- [x] Register the team toolkit.
- [x] Implement `team_roster`.
- [x] Implement `team_spawn_worker`.
- [x] Implement `team_get_worker`.
- [x] Implement `team_message_worker`.
- [x] Implement `team_stop_worker`.
- [x] Add tagged, plain-language toolkit errors.
- [x] Enforce worker ownership for every worker-specific tool.
- [x] Fail when a configured provider instance is missing instead of silently substituting a model.
- [x] Test resolved model, permission mode, branch, worktree, and worker team info in spawn commands.
- [x] Test the maximum parallel worker limit.
- [x] Test rejection of disabled roles.
- [x] Test the maximum review round limit.
- [x] Test `WorkerBusyError` for messaging a running worker.
- [x] Test that workers do not receive the `team` capability.
- [x] Run targeted toolkit and provider capability checks.
- [x] Commit phase 4 (`427fd52fa`).

### Phase 4 checks

- Team toolkit and provider capability tests: 96 passed.
- MCP team toolkit registration check: 1 passed.
- Targeted lint, formatting, TypeScript checks, and staged diff checks passed.
- The full `McpHttpServer.test.ts` file still has its existing Windows JSON-path assertion failure; the phase 4 registration case passes in isolation.

## Phase 5: Runtime instructions

- [x] Extend `buildRuntimeInstructions` with orchestrator and worker team blocks.
- [x] Add the built-in orchestrator prompt, roster summary, and custom orchestrator instructions.
- [x] Add the built-in worker prompt, resolved role prompt, and orchestrator title.
- [x] Pass team info through each provider adapter that needs it.
- [x] Record the decision for Claude, Codex, Cursor, Grok, OpenCode, and Antigravity.
- [x] Test orchestrator runtime instructions.
- [x] Test worker runtime instructions.
- [x] Test that plain-thread instructions are unchanged.
- [x] Run targeted instruction and adapter checks.
- [x] Commit phase 5 (`8ba50661f`).

### Phase 5 provider decisions

- Claude appends the resolved team block to its session-level system prompt.
- Codex retains the team block in `CodexSessionRuntimeOptions` and includes it in each turn's developer instructions.
- Cursor, Grok, OpenCode, and Antigravity retain the resolved team block in their adapter session context and include it in each turn's runtime instructions.
- Team metadata is resolved once through `McpProviderSessionConfig`; plain sessions omit it and keep their previous prompt unchanged.

### Phase 5 checks

- Runtime instruction tests: 9 passed.
- Claude, Codex, Cursor, Grok, OpenCode, and Antigravity adapter/runtime tests: 375 passed, 4 skipped.
- Targeted lint, formatting, TypeScript error filtering, and diff checks passed. The server-wide compiler still reports its existing Effect suggestion diagnostics.

## Phase 6: Team report reactor

- [x] Add `TeamReportReactor` with drainable-worker behavior.
- [x] Queue terminal worker states, approvals, and user-input requests for the owning orchestrator.
- [x] Flush one batched team update when the orchestrator becomes idle.
- [x] Mark reports with context that the client can render as a system update.
- [x] Report approvals once without starting another worker turn.
- [x] Add and reset the automatic-report limit.
- [x] Clear pending reports when the orchestrator stops or is interrupted.
- [x] Rebuild unreported completions from projections at startup.
- [x] Register the reactor with the server runtime.
- [x] Test that two completions while the orchestrator is busy produce one update after it becomes idle.
- [x] Test one-time approval reporting without a worker turn start.
- [x] Test the runaway guard and reset after a real user message.
- [x] Test that stopped orchestrators receive no updates.
- [x] Test startup recovery of unreported completions.
- [x] Run targeted reactor checks without sleeps or polling.
- [x] Commit phase 6 (`17ba96020`).

### Phase 6 checks

- `TeamReportReactor.test.ts`: 5 event-driven cases passed with sequence drains and no sleeps.
- `OrchestrationReactor.test.ts`: reactor registration passed.
- Targeted lint, formatting, TypeScript error filtering, and diff checks passed. The server-wide compiler still reports its existing Effect suggestion diagnostics.

## Phase 7: First manual run

- [x] Seed an isolated worktree database without writing to live T3 data.
- [x] Create an orchestrator thread through the RPC.
- [x] Spawn two workers against a toy repository.
- [x] Confirm that both workers run concurrently in separate worktrees.
- [x] Confirm that completion updates reach the orchestrator.
- [ ] Get user approval before browser or computer-use verification.
- [ ] Confirm remote access with `vp run dev --share`.
- [x] Record the manual-run results and any changes to earlier assumptions.
- [x] Commit phase 7 fix (`dfe7e97e1`).

### Phase 7 manual-run results

- No live T3 database existed on this host, so the run used a fresh isolated home at `.t3/team-phase7/home-user`; all data was created through the real RPC and no live user data was written.
- RPC created the `phase7c-orchestrator` thread using Codex `gpt-6-astra`. It spawned frontend and backend workers in the same turn.
- Both workers were observed running concurrently in distinct worktrees. They committed their requested single-file changes as `03c9b26` and `c4ead6c`; both worktrees were clean afterward.
- The orchestrator became idle immediately after spawning. Each worker completion produced a contextual `team-report` update and resumed the orchestrator, which reported both results without polling.
- The first run exposed a prompt deadlock: an orchestrator could wait inside its active turn for reports that are intentionally delivered only when it is idle. Runtime instructions now require ending the turn after spawning workers, and the clean rerun confirmed the fix.
- `vp run dev --share` started the isolated local server, but tailnet sharing failed because the host could not talk to Tailscale. Local RPC and web endpoints remained available.
- Focused verification passed: `RuntimeInstructions.test.ts` (9 tests), targeted lint, formatting, and the manual RPC workflow.

## Phase 8: Integration and QA loop

- [x] Implement `team_integrate` with the existing git services.
- [x] Create or reuse a dedicated integration worktree and branch.
- [x] Merge worker branches in the requested order without touching the base branch.
- [x] Abort conflicts and return the conflicting branch and files.
- [x] Leave the integration worktree clean after a failed merge.
- [x] Support QA workers based on the integration branch.
- [x] Enforce the exact APPROVED, REVISE, or BLOCKED verdict contract in the QA prompt.
- [x] Route revision findings back to the owning workers.
- [x] Stop after the configured review-round limit.
- [x] Keep the QA-provider hint scoped to the Phase 9 settings page, as specified by the plan.
- [x] Test that a clean merge returns the integration head SHA.
- [x] Test conflict handling and cleanup.
- [x] Test that the base branch is never modified.
- [x] Run targeted git fixture and QA-loop checks.
- [x] Commit phase 8 (`f51f55375`).

### Phase 8 checks

- `team_integrate` accepts ordered owned-worker branches, creates or reuses `team/<orchestrator>/integration`, and returns either its head SHA or the first conflicting branch and files.
- Real Git fixture tests cover ordered merges, worktree reuse after a worker revision, conflict abort cleanup, and an unchanged base branch.
- Toolkit tests cover branch ownership, base-branch target rejection, conflict results, QA branching from integration, and the review-round limit.
- Runtime instruction tests cover revision routing and the exact QA verdict line.
- Targeted tests: 29 passed. Team MCP registration: 1 passed. Targeted lint, formatting, diff checks, and changed-file TypeScript filtering passed.
- The QA-provider hint is implemented on the Workflows settings page.

## Phase 9: Workflows settings page

- [x] Add the Workflows settings route, navigation entry, icon, and search entry.
- [x] Build the built-in preset editor and role rows from existing picker patterns.
- [x] Support role enablement, label, summary, provider, model, effort, permission mode, and instructions.
- [x] Store Same as host and Same as orchestrator as `null`.
- [x] Support preset limits and extra orchestrator instructions.
- [x] Show a non-blocking hint when QA resolves to the same provider as most implementers.
- [x] Add Restore built-in preset.
- [x] Limit v1 editing to environment scope.
- [x] Test that model and effort changes persist and survive reload.
- [x] Test that Same as host stores `null`.
- [x] Test preset restoration.
- [x] Test settings search discovery.
- [x] Run targeted web settings checks.
- [x] Commit phase 9 (`20bc6789e`).

Notes:

- The page reuses the existing provider/model and traits pickers and writes the full preset through the scoped server settings update path.
- Focused tests: 56 passed across the workflow editor and settings search. Targeted formatting, lint, diff checks, and web typecheck completed; typecheck reports only existing Effect suggestions.

## Phase 10: Workflow entry points

- [x] Add `teamWorkflowId` to composer draft state.
- [x] Add the Workflow chip beside the permission-mode chip.
- [x] Include an orchestrator workflow snapshot on first send.
- [x] Make the chip read-only after thread creation and open the Team panel from it.
- [x] Hide the chip for existing normal threads and worker threads.
- [x] Support compact composer controls and layout.
- [x] Add the orchestrator draft placeholder.
- [x] Add the sidebar New orchestrator thread button.
- [x] Add New orchestrator thread to the command palette.
- [x] Add the unbound `chat.newOrchestrator` keybinding command.
- [x] Hide all entry points when the environment lacks the capability.
- [x] Test that every entry point creates an orchestrator thread with a workflow snapshot.
- [x] Test the read-only chip after first send.
- [x] Test capability-based visibility.
- [x] Test compact layout behavior.
- [x] Run targeted composer, sidebar, palette, and keybinding checks.
- [x] Commit phase 10 (`c4137450b`).

Notes:

- The persisted orchestrator chip is read-only and opens the dedicated Team tab added in Phase 11.
- All three entry points share one contextual draft-creation helper, so capability gating and workflow seeding cannot drift.
- Focused tests: 216 passed across draft persistence, new-thread routing, entry-point seeding, workflow visibility, compact layout, and keybinding decoding. Targeted formatting, lint, and web/contracts typechecks completed; typechecks report only existing Effect suggestions and lint reports only existing warnings.

## Phase 11: Team panel, badges, and report cards

- [x] Add a Team tab for orchestrator threads.
- [x] Show each worker's role, task, model, effort, state, branch, and diff stats.
- [x] Add open, stop, and message actions.
- [x] Add worker role badges in the sidebar and chat header.
- [x] Add a Back to orchestrator link for workers.
- [x] Render team reports as compact collapsible cards.
- [x] Add shared team selectors to `packages/client-runtime`.
- [x] Keep mobile behavior unchanged and verify its plain-text fallback.
- [x] Test fixed row height and stable ordering during state changes.
- [x] Test stop and message actions.
- [x] Get user approval before browser or devtools verification.
- [x] Verify that five workers with streaming output cause no continuous GPU repaint.
- [x] Run targeted panel, badge, report-card, and selector checks.
- [x] Commit phase 11.

Notes:

- The Team tab is available only on orchestrator threads. It reads worker shells through shared client-runtime selectors and fetches checkpoint diff details only after a worker is no longer streaming.
- Worker rows have a fixed height, stable creation order, static state dots, and no timers or animated status indicators.
- Web renders contextual `team-report` messages as native collapsible cards. Mobile code is unchanged and continues to display the message's plain text.
- Focused tests: 146 passed across the panel, right-panel store, report cards, and shared selectors. Targeted formatting, lint, diff checks, and web/client-runtime typechecks completed; typechecks report only existing Effect suggestions and lint reports only existing warnings.
- Browser verification used isolated projection fixtures with five working workers and streaming assistant messages. All five rows rendered at `h-[6.5rem]` in stable creation order; their DOM and screenshot bytes were unchanged across a three-second observation, confirming no continuous visual repaint.

## Phase 12: User and internal documentation

- [ ] Add a concise Team workflows section to the user documentation.
- [ ] Explain how to start a workflow, where its settings live, and that the user merges the integration branch.
- [ ] Add only the cross-component report-reactor design note to internal documentation.
- [ ] Check existing guidance for conflicts with the new behavior.
- [ ] Review the documentation for shipped-product voice and remove implementation detail from user docs.
- [ ] Commit phase 12.

## Final acceptance

- [ ] All 13 phases are complete and committed separately.
- [ ] Targeted tests, lint, and type checks pass for every changed area.
- [ ] Web and desktop support the full v1 workflow.
- [ ] Mobile can view team threads and plain-text updates without new controls.
- [ ] Claude, Codex, Cursor, Grok, OpenCode, and Antigravity each have a recorded support decision.
- [ ] Local, remote or relay, and tunnel behavior have been checked where applicable.
- [ ] The orchestrator never merges into the base branch.
- [ ] Workers cannot spawn workers.
- [ ] Existing threads and event replay remain compatible.
- [ ] No pull request has been opened unless the user requested one.
