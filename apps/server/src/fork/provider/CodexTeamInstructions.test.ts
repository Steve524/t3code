import { BUILT_IN_TEAM_WORKFLOW, RESEARCH_PLAN_TEAM_WORKFLOW } from "@t3tools/shared/team";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ThreadId } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";

import {
  buildTurnStartParams,
  openCodexThread,
} from "../../provider/Layers/CodexSessionRuntime.ts";
import { buildTeamInstructions, type RuntimeInstructionTeam } from "./TeamRuntimeInstructions.ts";

const teams: ReadonlyArray<{ label: string; team: RuntimeInstructionTeam }> = [
  {
    label: "planning coordinator",
    team: { role: "orchestrator", workflow: RESEARCH_PLAN_TEAM_WORKFLOW },
  },
  {
    label: "plan reviewer",
    team: {
      role: "worker",
      roleId: RESEARCH_PLAN_TEAM_WORKFLOW.roles[1]!.id,
      roleLabel: "Reviewer",
      roleInstructions: "",
      orchestratorTitle: "Research and plan",
      branch: "team/review",
      workflow: RESEARCH_PLAN_TEAM_WORKFLOW,
    },
  },
  {
    label: "Full-stack coordinator",
    team: { role: "orchestrator", workflow: BUILT_IN_TEAM_WORKFLOW },
  },
];

describe("Codex team instructions on the outbound turn request", () => {
  for (const interactionMode of ["default", "plan"] as const) {
    for (const { label, team } of teams) {
      it.effect(`delivers ${label} instructions in ${interactionMode} mode`, () =>
        Effect.gen(function* () {
          const params = yield* buildTurnStartParams({
            threadId: "provider-thread",
            runtimeMode: "full-access",
            prompt: "research=web notes=temporary\nReview the project plan.",
            model: "gpt-6-luna",
            effort: "medium",
            interactionMode,
            team,
          });

          assert.include(
            params.collaborationMode?.settings.developer_instructions ?? "",
            buildTeamInstructions(team),
          );
          assert.equal(params.model, "gpt-6-luna");
          assert.equal(params.serviceTier, undefined);
          if (team.role === "worker" && team.roleId === "reviewer") {
            expect(params.outputSchema).toMatchObject({
              type: "object",
              additionalProperties: false,
              required: [
                "verdict",
                "planHash",
                "baseline",
                "summary",
                "findings",
                "coverage",
                "limitations",
              ],
              properties: {
                verdict: { enum: ["APPROVED", "REVISE", "BLOCKED"] },
                findings: {
                  items: {
                    additionalProperties: false,
                    required: ["id", "severity", "evidence", "proposedFix"],
                  },
                },
              },
            });
          } else {
            assert.equal(params.outputSchema, undefined);
          }
          assert.deepEqual(params.input, [
            { type: "text", text: "research=web notes=temporary\nReview the project plan." },
          ]);
        }),
      );
    }
  }

  it.effect("keeps an ordinary thread free of team instructions", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "ordinary-thread",
        runtimeMode: "full-access",
        prompt: "Inspect the project.",
        interactionMode: "default",
      });
      assert.notInclude(params.collaborationMode?.settings.developer_instructions ?? "", "team_");
      assert.equal(params.outputSchema, undefined);
    }),
  );
});

// Codex 0.157.1 retains collaboration-mode overrides in settings but omits them
// from the model request. Team instructions must also be installed on the thread.
describe("Codex team instructions at thread creation and resume", () => {
  for (const route of ["start", "resume", "fallback"] as const) {
    for (const { label, team } of [...teams, { label: "ordinary thread", team: undefined }]) {
      it.effect(`${route} installs instructions for ${label}`, () =>
        Effect.gen(function* () {
          const calls: Array<{ method: string; payload: unknown }> = [];
          const stop = new CodexErrors.CodexAppServerRequestError({
            code: -32603,
            errorMessage: "probe complete",
          });
          yield* openCodexThread({
            client: {
              request: (method, payload) => {
                calls.push({ method, payload });
                return Effect.fail(stop);
              },
              raw: {
                request: (method, payload) => {
                  calls.push({ method, payload });
                  return Effect.fail(
                    route === "fallback"
                      ? new CodexErrors.CodexAppServerRequestError({
                          code: -32603,
                          errorMessage: "thread not found",
                        })
                      : stop,
                  );
                },
              },
            },
            threadId: ThreadId.make("team-thread"),
            runtimeMode: "full-access",
            cwd: "/fixture",
            requestedModel: "gpt-6-luna",
            serviceTier: undefined,
            resumeThreadId: route === "start" ? undefined : "saved-thread",
            team,
          }).pipe(Effect.result);
          expect(calls.map(({ method }) => method)).toEqual(
            route === "fallback"
              ? ["thread/resume", "thread/start"]
              : [route === "start" ? "thread/start" : "thread/resume"],
          );
          for (const { payload } of calls) {
            if (team)
              expect(payload).toMatchObject({ developerInstructions: buildTeamInstructions(team) });
            else expect(payload).not.toHaveProperty("developerInstructions");
          }
        }),
      );
    }
  }
});
