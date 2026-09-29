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
