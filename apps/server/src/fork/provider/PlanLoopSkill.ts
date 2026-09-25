import type { TeamWorkflow } from "@t3tools/contracts";

import skill from "../skills/t3-plan-loop/SKILL.md";
import planner from "../skills/t3-plan-loop/references/planner.md";
import reviewer from "../skills/t3-plan-loop/references/reviewer.md";
import researcher from "../skills/t3-plan-loop/references/researcher.md";

export const PLAN_LOOP_PROTOCOL = "t3-plan-loop";
export const PLAN_LOOP_SKILL_VERSION = "1.0.0";
export const PLAN_LOOP_INVOCATION = /^\s*[/$]t3-plan-loop(?=\s|$)/u;

const roleInstructions: Readonly<Record<string, string>> = { planner, reviewer, researcher };

export function planLoopCoordinatorInstructions(workflow: TeamWorkflow): string {
  if (workflow.skillVersion !== PLAN_LOOP_SKILL_VERSION) {
    return `The Research and plan workflow requires t3-plan-loop ${PLAN_LOOP_SKILL_VERSION}, but this thread has ${workflow.skillVersion ?? "no version"}. Update the workflow package and start a compatible thread. Do not dispatch workers.`;
  }

  const roster = workflow.roles
    .filter((role) => role.enabled)
    .map(
      (role) =>
        `- ${role.label} (${role.id}, ${role.kind}): ${role.summary}; model=${JSON.stringify(role.modelSelection ?? "same as host")}; permissions=${role.runtimeMode ?? "same as host"}`,
    )
    .join("\n");
  const custom = workflow.orchestratorInstructions.trim();
  return `${skill}\n\n<team_roster>\n${roster}\nLimits: ${workflow.maxParallelWorkers} parallel workers, ${workflow.maxReviewRounds} review attempts, ${workflow.maxAutoReports} automatic updates, ${workflow.deepResearchWorkers ?? 3} deep-research workers.\n</team_roster>${custom ? `\n\n<team_orchestrator_instructions>\n${custom}\n</team_orchestrator_instructions>` : ""}`;
}

export function planLoopWorkerInstructions(input: {
  readonly roleId: string;
  readonly roleLabel: string;
  readonly roleInstructions: string;
  readonly orchestratorTitle: string;
}): string {
  const role = input.roleInstructions.trim() || roleInstructions[input.roleId] || "";
  return `<team_worker>\nYou are the ${input.roleLabel} worker for the T3 Code Research and plan thread "${input.orchestratorTitle}". Return your complete result to the coordinator. Do not edit project source, commit, push, open a pull request, or delegate with native subagent tools.\n</team_worker>${role ? `\n\n<team_role_instructions>\n${role}\n</team_role_instructions>` : ""}`;
}

export function resolvePlanLoopInvocation(
  prompt: string | undefined,
  team:
    | { readonly role: "orchestrator"; readonly workflow: TeamWorkflow }
    | { readonly role: "worker" }
    | undefined,
): { readonly input?: string; readonly error?: string } {
  if (!prompt) return {};
  const match = PLAN_LOOP_INVOCATION.exec(prompt);
  if (!match) return {};
  if (team?.role !== "orchestrator" || team.workflow.protocolId !== PLAN_LOOP_PROTOCOL) {
    return {
      error:
        "Open a Research and plan orchestrator thread, then use /t3-plan-loop <request> there.",
    };
  }
  if (team.workflow.skillVersion !== PLAN_LOOP_SKILL_VERSION) {
    return {
      error: `This thread uses t3-plan-loop ${team.workflow.skillVersion ?? "without a version"}; this server bundles ${PLAN_LOOP_SKILL_VERSION}. Update the skill and open a compatible workflow thread.`,
    };
  }
  const missing = ["planner", "reviewer", "researcher"].filter(
    (id) => !team.workflow.roles.some((role) => role.id === id && role.enabled),
  );
  if (missing.length > 0) {
    return {
      error: `Enable the ${missing.join(", ")} role${missing.length === 1 ? "" : "s"} in Settings > Workflows before starting t3-plan-loop.`,
    };
  }
  const args = prompt.slice(match[0].length).trimStart();
  return {
    input: args || "Start the bundled t3-plan-loop protocol.",
  };
}
