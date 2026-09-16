import type { TeamRoleId, TeamWorkflow } from "@t3tools/contracts";

const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.
</pull_request_linking>`;

const TEAM_ORCHESTRATOR_INSTRUCTIONS = `<team_orchestrator>
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
</team_orchestrator>`;

const TEAM_WORKER_INSTRUCTIONS = `<team_worker>
You are the {roleLabel} worker on a T3 Code team led by the orchestrator thread "{orchestratorTitle}".
Work only on the task in the first message. You are in your own worktree on branch {branch}.
Inspect the relevant code before editing. Keep changes inside your task. Commit your work to this branch with conventional commit messages. Do not push or open a PR unless the task says to.
Do not use built-in subagent or task-delegation tools.
If you need a decision, ask it and stop.
Finish with a short report: what changed, files touched, checks you ran and their results, and anything another role needs to know.
</team_worker>`;

const BUILT_IN_ROLE_INSTRUCTIONS: Readonly<Record<string, string>> = {
  frontend:
    "Build UI in the project's existing component library and styling system. Match existing patterns before adding new ones. Handle loading, empty, and error states. Run the project's frontend tests and type checks for the files you touched.",
  backend:
    "Implement APIs and business logic in the project's existing framework. Validate input at the boundary. Return typed errors. Add focused tests for new behavior.",
  database:
    "Write schema changes as migrations the project's tooling can run forward. State whether each migration is reversible. Do not modify existing migrations. Report the new schema to the orchestrator in your final message so other roles can build on it.",
  devops:
    "Change CI, build, and deployment configuration only as the task requires. Never add or print secrets. Explain any new environment variable in your final message.",
  qa: "You are reviewing the integration branch. Do not add features. Run the test suite and the checks the project defines. Read the diff against the base branch. Report findings with file and line, severity, and the owning role. End with exactly one line: `VERDICT: APPROVED`, `VERDICT: REVISE`, or `VERDICT: BLOCKED`.",
};

export type RuntimeInstructionTeam =
  | {
      readonly role: "orchestrator";
      readonly workflow: TeamWorkflow;
    }
  | {
      readonly role: "worker";
      readonly roleId: TeamRoleId;
      readonly roleLabel: string;
      readonly roleInstructions: string;
      readonly orchestratorTitle: string;
      readonly branch: string;
    };

/** Shared runtime context; omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly team?: RuntimeInstructionTeam | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${model}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const base = `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}`;
  return runtime.team ? `${base}\n\n${buildTeamInstructions(runtime.team)}` : base;
}

function buildTeamInstructions(team: RuntimeInstructionTeam): string {
  if (team.role === "orchestrator") {
    const roles = team.workflow.roles
      .filter((role) => role.enabled)
      .map((role) => `- ${role.label} (${role.id}, ${role.kind}): ${role.summary}`)
      .join("\n");
    const roster = `<team_roster>\nWorkflow: ${team.workflow.name}\nAvailable roles:\n${roles}\nLimits: ${team.workflow.maxParallelWorkers} parallel workers, ${team.workflow.maxReviewRounds} review rounds, ${team.workflow.maxAutoReports} automatic updates.\n</team_roster>`;
    const custom = team.workflow.orchestratorInstructions.trim();
    return `${TEAM_ORCHESTRATOR_INSTRUCTIONS}\n\n${roster}${custom ? `\n\n<team_orchestrator_instructions>\n${custom}\n</team_orchestrator_instructions>` : ""}`;
  }

  const worker = TEAM_WORKER_INSTRUCTIONS.replace("{roleLabel}", team.roleLabel)
    .replace("{orchestratorTitle}", team.orchestratorTitle)
    .replace("{branch}", team.branch);
  const roleInstructions =
    team.roleInstructions.trim() || BUILT_IN_ROLE_INSTRUCTIONS[team.roleId] || "";
  return `${worker}${roleInstructions ? `\n\n<team_role_instructions>\n${roleInstructions}\n</team_role_instructions>` : ""}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
