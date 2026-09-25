import * as NodeServices from "@effect/platform-node/NodeServices";
import { RESEARCH_PLAN_TEAM_WORKFLOW } from "@t3tools/shared/team";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverClaudeSkills } from "../../provider/Drivers/ClaudeSkills.ts";
import { buildTeamInstructions } from "./TeamRuntimeInstructions.ts";
import { PLAN_LOOP_SKILL_VERSION, resolvePlanLoopInvocation } from "./PlanLoopSkill.ts";

const team = { role: "orchestrator" as const, workflow: RESEARCH_PLAN_TEAM_WORKFLOW };

describe("t3-plan-loop protocol", () => {
  it("preserves command arguments and blocks incompatible threads before dispatch", () => {
    const args = "mode=review research=deep notes=docs/research/my notes\nReview this plan.";
    for (const prefix of ["/", "$"]) {
      expect(resolvePlanLoopInvocation(`${prefix}t3-plan-loop ${args}`, team)).toEqual({
        input: args,
      });
    }
    expect(resolvePlanLoopInvocation("ordinary request", undefined)).toEqual({});
    expect(resolvePlanLoopInvocation("/t3-plan-loop plan it", undefined).error).toContain(
      "Open a Research and plan orchestrator thread",
    );
    expect(resolvePlanLoopInvocation("/t3-plan-loop plan it", { role: "worker" }).error).toContain(
      "Open a Research and plan orchestrator thread",
    );
    expect(
      resolvePlanLoopInvocation("/t3-plan-loop plan it", {
        ...team,
        workflow: { ...team.workflow, skillVersion: "0.9.0" },
      }).error,
    ).toContain(PLAN_LOOP_SKILL_VERSION);
    expect(
      resolvePlanLoopInvocation("/t3-plan-loop plan it", {
        ...team,
        workflow: {
          ...team.workflow,
          roles: team.workflow.roles.filter(({ id }) => id !== "reviewer"),
        },
      }).error,
    ).toContain("reviewer");
  });

  it("selects planning instructions without the coding team's commit protocol", () => {
    const coordinator = buildTeamInstructions(team);
    const worker = buildTeamInstructions({
      role: "worker",
      roleId: RESEARCH_PLAN_TEAM_WORKFLOW.roles[0]!.id,
      roleLabel: "Planner",
      roleInstructions: "",
      orchestratorTitle: "Research the feature",
      branch: "research/one",
      workflow: RESEARCH_PLAN_TEAM_WORKFLOW,
    });

    expect(team.workflow.skillVersion).toBe(PLAN_LOOP_SKILL_VERSION);
    expect(coordinator).toContain(`version: ${PLAN_LOOP_SKILL_VERSION}`);
    expect(coordinator).toContain("Before work starts, require the server's guarded planning-run");
    expect(coordinator).toContain('model="same as host"');
    expect(coordinator).not.toContain("When implementers are done, call team_integrate");
    expect(worker).toContain("Maintain an assumptions ledger");
    expect(worker).not.toContain("Commit your work to this branch");
  });
});

it.layer(NodeServices.layer)("installable t3-plan-loop package", (it) => {
  it.effect("is discovered with its references from an isolated Claude skill location", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plan-loop-skill-" });
      const homePath = path.join(temp, "claude-home");
      const destination = path.join(homePath, "skills", "t3-plan-loop");
      const source = yield* path.fromFileUrl(new URL("../skills/t3-plan-loop", import.meta.url));
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      yield* fs.copy(source, destination);

      const skills = yield* discoverClaudeSkills({ homePath }, temp);
      assert.equal(
        skills.find(({ name }) => name === "t3-plan-loop")?.path,
        path.join(destination, "SKILL.md"),
      );
      assert.isTrue(yield* fs.exists(path.join(destination, "references", "reviewer.md")));
    }),
  );
});
