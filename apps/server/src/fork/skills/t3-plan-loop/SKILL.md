---
name: t3-plan-loop
description: Coordinate research, planning, and independent plan review in a T3 Code Research and plan orchestrator thread.
metadata:
  version: 1.0.0
---

# Research and plan

Use this protocol only in a T3 Code orchestrator thread whose snapshotted workflow has protocol `t3-plan-loop` and the same skill version. `/t3-plan-loop <request>` starts or resumes the run; `mode=review` starts with an existing plan. The first request in a Research and plan thread also starts the protocol. Preserve the user's arguments, including research depth and notes destination.

The T3 server owns the roster, model selections, permissions, run state, limits, and artifacts. Call `team_roster` before dispatch. Display the requested role models and options; claim an observed model identity only when the provider reports it. The planner, reviewer, and researcher roles must be enabled. Do not substitute a model when a configured one is unavailable.

Before work starts, require the server's guarded planning-run, review-dispatch, full-result, and artifact operations. If any required operation is unavailable, report the missing capability and stop. Do not use generic worker messages or native subagents to bypass a guard. An installed copy of this skill supplies instructions only; it does not supply T3 credentials or a standalone team.

Use `team_plan_run` with `action=start` and the agreed `researchDepth`. It captures committed HEAD; tell the user that uncommitted changes are excluded. `action=dispatch` takes a unique `requestId`, `purpose` (`planner`, `reviewer`, `research-lead`, or `research-worker`), `title`, and `task`. An identical retry must reuse its request ID. After a completion report, `action=status` reconciles reserved turns and returns result references. `action=record-plan` consumes the planner request ID; revisions include `dispositions` with finding `id`, `decision` (`accepted` or `rejected`), and `evidence`. `action=record-review` consumes the reviewer request ID and validates the full saved result. `action=cancel` stops owned work; `action=resume` preserves budgets and never replays launches. Never claim read-only enforcement from a permission label; provider enforcement still requires capability verification.

1. Resolve the research depth (`none`, `web`, or `deep`), the selected notes destination, and the snapshotted limits. Ask once when depth is unspecified and external research matters. Do not choose a notes destination silently. Show the concrete research questions before dispatch; ask again only if their scope materially differs from the request.
2. Ask the planner to inspect the relevant project and identify uncertainties. For targeted web research, use the researcher directly. For deep research, have the researcher return distinct tasks; dispatch the configured number of research workers through guarded T3 operations, in batches if the parallel limit is lower. Read every page of each completed turn with `team_get_worker_result` before passing evidence to the same researcher for synthesis.
3. Have the planner present a sourced assumptions ledger and batch independent decisions. Record the user's decisions. Draft a plan with goals, measurable acceptance criteria, concrete changes, alternatives, risks, non-goals, and focused checks. Link material findings in the brief by stable identifiers.
4. Submit a versioned plan and its hash to a separate reviewer through the guarded review operation. Retrieve the full reviewer result before interpreting it. A revision goes back to the planner with finding dispositions, then to the same reviewer for another guarded attempt. Do not interpret a truncated report or a coordinator summary as approval.
5. Export final worker results with `team_export_worker_result`. Research requires the user's chosen `temporary`, `custom`, or `project` destination. The export returns an attachment resource; resolve it through the connected environment's asset API for remote download. `team_list_artifacts` recovers saved versions after a restart. Tell the user that operating-system cleanup can remove temporary notes, while the saved attachment copy remains available. Finish with the plan, research brief, complete review history, rounds used, artifact locations, and any remaining limitations. Approval applies only to the reviewed plan hash. A blocked, invalid, failed, or exhausted review remains visible.

Use the role instructions in [planner](references/planner.md), [reviewer](references/reviewer.md), and [researcher](references/researcher.md) when assigning work. The research lead is idle while its workers run; the coordinator routes their evidence back to it. End the coordinator turn after dispatch and wait for T3's completion update instead of polling.

Planning does not authorize source edits, commits, pushes, implementation, or a pull request. Export only the user's selected notes artifact through the server operation. A later build requires separate authorization.
