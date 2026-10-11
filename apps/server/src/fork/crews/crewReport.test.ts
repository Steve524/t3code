import { describe, expect, it } from "vite-plus/test";

import {
  decodeCrew,
  end,
  task,
  withSteps,
} from "../../../../../packages/shared/src/fork/crews/crewTestFixtures.ts";
import {
  crewArtifactErrors,
  crewReportErrors,
  crewStepOutcomes,
  parseCrewReportBlock,
} from "./crewReport.ts";

const crew = decodeCrew(
  withSteps(
    {
      work: { ...task, produces: ["plan"], next: "review" },
      review: { ...task, outcomes: { approve: "done", changes: "work" } },
      done: end,
    },
    {
      artifacts: {
        plan: {
          type: "object",
          schema: { tasks: { type: "list", item: { id: "string", owns: "string[]" } } },
        },
        notes: { type: "markdown" },
      },
    },
  ),
);
const plan = (tasks: unknown) => ({
  outcome: "done",
  summary: "Planned.",
  artifacts: { plan: { tasks } },
});

describe("crew report rules", () => {
  it("offers a step's routed outcomes, and done only when it has a plain next", () => {
    expect(crewStepOutcomes(crew, "work")).toEqual(["done"]);
    expect(crewStepOutcomes(crew, "review")).toEqual(["approve", "changes"]);
    expect(crewStepOutcomes(crew, "done")).toEqual([]);
  });

  it("accepts a report with an allowed outcome and a well-shaped artifact", () => {
    expect(crewReportErrors(crew, "work", plan([{ id: "a", owns: ["src/a.ts"] }]))).toEqual([]);
  });

  it("names the field a malformed artifact is missing", () => {
    const errors = crewReportErrors(
      crew,
      "work",
      plan([{ id: "a", owns: ["src/a.ts"] }, { id: "b" }]),
    );
    expect(errors).toEqual(["plan.tasks[1].owns is required."]);
  });

  it.each([
    [
      "an outcome the step does not route",
      { outcome: "approve", summary: "", artifacts: {} },
      /Outcome "approve" is not allowed\. Use one of: done, failed\./u,
    ],
    [
      "a missing produced artifact",
      { outcome: "done", summary: "", artifacts: {} },
      /Artifact "plan" is required\./u,
    ],
    [
      "an artifact the step does not produce",
      { ...plan([]), artifacts: { plan: { tasks: [] }, notes: "x" } },
      /Artifact "notes" is not produced by this step\. It produces: plan\./u,
    ],
  ])("refuses %s and says what is allowed", (_name, report, expected) => {
    expect(crewReportErrors(crew, "work", report).join(" ")).toMatch(expected);
  });

  it("lets a role report failed without the artifacts it could not produce", () => {
    expect(
      crewReportErrors(crew, "work", { outcome: "failed", summary: "Blocked.", artifacts: {} }),
    ).toEqual([]);
  });

  it.each([
    [{ type: "markdown" } as const, 4, ["notes must be a string."]],
    [{ type: "list", item: "number" } as const, [1, "2"], ["notes[1] must be a number."]],
    [{ type: "list", item: "number" } as const, "no", ["notes must be a list."]],
    [{ type: "object", schema: { done: "boolean" } } as const, [], ["notes must be an object."]],
  ])("checks an artifact against shape %j", (artifact, value, expected) => {
    expect(crewArtifactErrors(artifact, value, "notes")).toEqual(expected);
  });
});

describe("crew-report block", () => {
  const block = (body: string) => `Done.\n\n\`\`\`crew-report\n${body}\n\`\`\`\n`;

  it("reads the report a role ends its message with", () => {
    expect(
      parseCrewReportBlock(block('{ "outcome": "approve", "summary": "Looks right." }')),
    ).toEqual({ outcome: "approve", summary: "Looks right.", artifacts: {} });
  });

  it("uses the last block when a message quotes an earlier one", () => {
    const text =
      block('{ "outcome": "changes", "summary": "first" }') +
      block('{ "outcome": "approve", "summary": "final" }');
    expect(parseCrewReportBlock(text)?.outcome).toBe("approve");
  });

  it.each([
    ["no block", "I finished the work."],
    ["a block that is not JSON", block("outcome: approve")],
    ["a block without an outcome", block('{ "summary": "x" }')],
    ["another fenced language", '```json\n{ "outcome": "approve", "summary": "x" }\n```'],
  ])("finds no report in %s", (_name, text) => {
    expect(parseCrewReportBlock(text)).toBeNull();
  });
});
