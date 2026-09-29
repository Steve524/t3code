# Research & plan team: live test record

Live runs of the "Research & plan team" Team Workflow preset. Each entry records the provider and model per role, what happened, and anything that failed. Unit and integration coverage lives in the fork tests; this file is only for runs against real providers.

## 2026-09-29: Phase 1 thin slice (Claude planner, research `none`, one reviewer)

**Setup.** Dev server from the fork checkout with an isolated home (a `VACUUM INTO` copy of real data). Scratch brownfield repo: a 30-line Node todo CLI with `node:test` tests, committed on `main`, outside any directory with a `CLAUDE.md`. Workflow roles set in Settings JSON.

| Role                   | Provider / model requested   | Runtime mode      | Observed model                    |
| ---------------------- | ---------------------------- | ----------------- | --------------------------------- |
| Planner (orchestrator) | Claude / `claude-sonnet-5-5` | full-access       | Not reported in thread activities |
| Plan reviewer          | Claude / `claude-sonnet-5-5` | approval-required | Not reported in thread activities |

The Claude adapter doesn't write the model it actually ran into thread activities, so only the requested model is known. Phase 7 task 7.6 covers this.

**Task:** "Plan adding due dates to this todo CLI: `todo add <text> --due YYYY-MM-DD`, and a `todo overdue` command… Keep the plan small."

**What happened**

1. The Workflow picker listed "Research & plan team" and "Full-stack team". Settings held only the Research & plan preset, and Full-stack was added back by `resolveTeamWorkflows`.
2. Recon read every source file, then presented one Assumptions Ledger (8 sourced entries, including a skill-scan entry) and a Decision Map in the template format. It correctly found no load-bearing questions, and offered the cosmetic batch with "accept all".
3. After "accept all", the planner wrote `docs/plans/2026-09-29-todo-due-dates.md` and `…-review-log.md`. Both use the template headings (Goal, Acceptance criteria, Approach, Key decisions & tradeoffs, Toolchain, Assumptions, Verification, Risks / open questions, Out of scope; the log has the Roles line, `## Round <n>` and `### Planner's response`).
4. Round 1: `team_spawn_worker` started one plan-reviewer thread with branch `main` (the planner's) and no worktree. `git worktree list` and `git branch -a` showed no new worktree or branch.
5. The reviewer asked to run a read-only `node -e` probe in `/tmp`, and `approval-required` stopped it for approval as intended. The planner reported which thread needed the user, and did not spawn a second reviewer.
6. Round 1 verdict: REVISE with 7 findings, which were real defects (for example, the planned `isValidDate` threw on one of the plan's own examples). The Team update carried the whole 8,646-character reply with the JSON verdict; the old 1,500-character cap would have cut the verdict off.
7. The planner accepted 6 findings and partly accepted 1, logged its dispositions, revised the plan, and sent round 2 with `team_message_worker` to the **same** reviewer thread.
8. Round 2: APPROVED with 4 low findings. The planner asked for sign-off with the round count and three improvements. It kept the low findings out of the plan text because "an approval only covers the text the reviewer saw", offered a round 3 if the user wanted them in, and stopped without building.
9. Final `git status`: only the two untracked plan files. No source file changed.

**Problems found**

- **Diff stats attribute the planner's edits to the reviewer.** The Team panel and Team update show "2 files +63 −33" for the plan reviewer, which changed nothing. The reviewer shares the planner's checkout, so its turn checkpoint captures the planner's plan revisions made between rounds. Fix alongside Phase 2 (hide or skip diff stats for read-only workers).
- **The Team update title stays "(round 1)"** in round 2, because it uses the spawn-time task title. Cosmetic; Phase 8's round display replaces it.
- **Server restart during a run.** Running `node apps/server/src/bin.ts pair` from the same checkout made the dev server's `node --watch` restart twice, which killed the reviewer's provider session mid-turn. Recovery worked through the product: the planner re-sent round 1 to the same thread when asked. Two existing behaviours surfaced, and neither is Phase 1 code:
  - After each restart, the reactor re-sent the same "approval requested" Team update (three copies in total), because its dedupe state is in memory.
  - The reviewer thread kept showing the dead session's approval request. Approving it fails with "Stale pending approval request", and the live request has to be approved separately.
  - For future runs: mint pairing tokens before starting a turn, or from outside the watched checkout.

**Prompt size.** The Phase 1 planner prompt is 7,050 bytes, the plan-reviewer prompt 1,662 bytes, and the Full-stack orchestrator prompt 1,605 bytes.

## 2026-09-29: Phase 2 read-only matrix (task 2.1)

**Setup.** Dev server from the fork checkout (`e78287fc6e` plus Phase 1) with an isolated home, seeded from the Phase 1 copy. The Browser panel was unavailable in this session, so the runs were driven over the server's own WebSocket API with a bearer token from a pairing token. That is the same `thread.turn.start` path the web client uses. Each cell is a plain thread (no team) in its own detached worktree of the scratch todo repo, so the cells ran in parallel without mixing results. A script declined every approval request and logged what it asked for.

**Probe.** One message per cell: (1) read `src/store.js`, (2) web search, (3) a native sub-agent counts lines in `src/cli.js`, (4) create a file with the edit/write tool, (5) create a file with `node -e` in the shell, (6) a sub-agent creates a file. Where a model skipped steps 4–6 on its own, a follow-up asked it to make the calls anyway, and then to call `ExitPlanMode` and try one more write. Results come from the tool calls and `git status`, not from the model's own report.

| Cell     | Provider / model (observed)                                       | Runtime / interaction       | Read     | Web      | Sub-agent read   | Edit tool   | Shell write            | Sub-agent write | `git status`      |
| -------- | ----------------------------------------------------------------- | --------------------------- | -------- | -------- | ---------------- | ----------- | ---------------------- | --------------- | ----------------- |
| claude-A | Claude / `claude-sonnet-5-5` (transcript)                         | approval-required / default | ok       | **asks** | ok               | asks        | asks                   | asks            | clean             |
| claude-B | Claude / `claude-sonnet-5-5`                                      | full-access / plan          | ok       | ok       | ok               | **written** | **written**            | **written**     | 4 new files       |
| claude-C | Claude / `claude-sonnet-5-5`                                      | approval-required / plan    | ok       | ok       | ok               | asks        | **written, no prompt** | asks            | `probe-shell.txt` |
| codex-A  | Codex / `gpt-6-luna`, tier `default` (thread/start response)      | approval-required / default | **asks** | ok       | n/a (see below)  | asks        | asks                   | n/a             | clean             |
| codex-B  | Codex / `gpt-6-luna`, tier `default`                              | full-access / plan          | ok       | ok       | ok               | **written** | **written**            | **written**     | 3 new files       |
| codex-C  | Codex / `gpt-6-luna`, tier `default`                              | approval-required / plan    | **asks** | ok       | **asks**         | asks        | asks                   | asks            | clean             |
| agy-A    | Antigravity / `gemini-3.8-flash-low` (requested; not echoed back) | approval-required / default | ok       | **asks** | **asks** (spawn) | asks        | asks                   | asks (spawn)    | clean             |
| agy-B    | Antigravity / `gemini-3.8-flash-low`                              | full-access / plan          | ok       | ok       | ok               | **written** | **written**            | **written**     | 3 new files       |

"Asks" means the write became an approval request, which the script declined, and nothing was written. Nothing in any cell was blocked outright by the provider.

**Per provider**

- **Claude.** In plan mode Sonnet skipped steps 4–6 on its own in the first turn, so that turn proved nothing. Asked to make the calls, it wrote under full-access, because Claude Code sends plan-mode writes to t3code's `canUseTool`, and full-access allows everything there. Under approval-required, the Write calls (its own and the sub-agent's) became approval requests, but the `node -e` Bash write ran with **no** request. The transcript shows the user-level `PreToolUse` hook returning `{}` and no `canUseTool` call, so Claude Code's own plan-mode permission check allowed it. Without plan mode (claude-A), the same command asked. `ExitPlanMode` is always denied by t3code ("The client captured your proposed plan…"), the session stays in plan mode, and the next write behaved as before, so it is no escape. Plan mode also writes its plan file under `~/.claude/plans/`, outside the project.
- **Codex.** The plan collaboration mode is instructions only; the sandbox follows the runtime mode, so full-access + plan writes everything. Approval-required means `approvalPolicy: untrusted` with a `read-only` sandbox, which on Windows asks even for `Get-Content`, so a reviewer can't read the repo without a prompt per command. A sub-agent's write asked too (codex-C), so sub-agents inherit the policy. In codex-A (default mode), Luna reached for the t3code team tools instead of a native sub-agent and got "MCP credential does not grant the team capability"; in plan mode it used native sub-agents.
- **Antigravity.** The adapter never reads `interactionMode` (`AntigravityAdapter.ts`), so plan mode changes nothing, and agy-B wrote all three files. Approval-required maps to Antigravity's `default` mode, which asks before web search, file search and spawning a sub-agent. A research role would need a prompt for every lookup. Its managed runtime lives under the T3 base dir (`tools/antigravity-acp`), so an isolated home needs a copy of it, or the session fails with "Antigravity is not installed".

**Skipped providers.** OpenCode, Cursor and Grok: no CLI on this machine (`opencode`, `cursor-agent`/`agent` and `grok` aren't on `PATH`), and all three are disabled in the real settings, so there are no credentials to test with.

**Conclusion.** No provider enforces read-only through `runtimeMode` and `interactionMode` alone. The best existing mode, Claude with approval-required and default interaction, stops every write at an approval request, including sub-agent writes. A person can still accept that request, though, and web search asks too. Task 2.2 takes Claude to enforced by answering those requests on the server, and sends the other providers to the isolated-worktree fallback (Q1). The reasoning is in `PHASES.md`.

## 2026-09-29: Phase 2 live check (enforced and isolated read-only workers)

**Setup.** The same isolated server and scratch repo as the matrix, running the Phase 2 code. One Research & plan orchestrator was started over the WebSocket API with the workflow copied into the thread, as the client does. The first message told the planner to skip planning and run a scripted harness test.

| Role                          | Provider / model requested                       | Mode the thread ran with                       | Checkout                                                                |
| ----------------------------- | ------------------------------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------- |
| Planner                       | Claude / `claude-sonnet-5-5`                     | full-access / default                          | scratch repo, `main`                                                    |
| Researcher (enforced path)    | Claude / `claude-sonnet-5-5`                     | approval-required / default (from the mapping) | planner's checkout, no branch                                           |
| Plan reviewer (isolated path) | Codex / `gpt-6-luna`, tier `default`, effort low | full-access / default (the planner's)          | own worktree on `team/aadcb2b8/plan-rev-368bb0c8`, setup script skipped |

**Enforced path.** The researcher made each call for real. The server answered every approval request in the same second, and nobody was asked:

| Call                                               | Server's answer | Result                                  |
| -------------------------------------------------- | --------------- | --------------------------------------- |
| `WebSearch`                                        | accept          | results from nodejs.org                 |
| `Write probe-edit.txt`                             | decline         | "User declined tool execution."         |
| Bash `node -e "…writeFileSync('probe-shell.txt')"` | decline         | "User declined tool execution."         |
| Sub-agent's `Write probe-subagent.txt`             | decline         | the sub-agent reported the same refusal |

The planner got the researcher's reports but no Team update for any of the four requests. Neither read-only worker's Team update had a `Diff:` line. At the end, `git status` in the scratch repo showed only `docs/plans/probe-plan.md`, the planner's own file.

**Isolated path.** The reviewer's first task carried the isolation note and the plan text read from `planPath`. Luna refused to review the inlined text: the plan-reviewer prompt said to read "the plan named in each message" and to treat "the plan" as evidence, and it took that as a ban. It ended its turn without a verdict. The prompt now says to review included plan text when the file isn't in the reviewer's checkout, and the inlined-plan header says the same. After that, round 2 (`team_message_worker` with `planPath`) worked. The reviewer quoted the plan, ran `Get-Location; Test-Path docs/plans/probe-plan.md` inside its worktree, reported the file absent there, and returned a valid APPROVED verdict.

**Worktree cleanup.** After `team_stop_worker`, the reviewer's worktree directory was deleted and `git worktree list` showed only `main`, while its branch stayed. Messaging the stopped reviewer recreated the worktree from that branch (upstream's resume path), and the second stop deleted it again.
