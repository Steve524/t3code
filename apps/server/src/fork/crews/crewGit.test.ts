import { describe, expect, it } from "vite-plus/test";

import { decodeCrew } from "../../../../../packages/shared/src/fork/crews/crewTestFixtures.ts";
import {
  crewCardBranch,
  crewCardOwns,
  crewCommitMessage,
  crewOwnershipViolations,
  isPlainToolArgument,
} from "./crewGit.ts";
import type { CrewCard } from "./engine/types.ts";

const card = {
  stepId: "build",
  visit: 1,
  itemIndex: 1,
  attempt: 1,
  roleId: "implementer",
  item: { owns: ["src/api/**", "docs"] },
} as CrewCard;
const model = { instanceId: "codex-work", model: "gpt-5.6-terra" } as never;

describe("crew git", () => {
  it("names a card's branch by run, step, visit and item, and a later attempt apart", () => {
    expect(crewCardBranch("crew-run:0123456789abcdef", card)).toBe("crew/89abcdef/build-1-1");
    expect(
      crewCardBranch("crew-run:0123456789abcdef", { ...card, itemIndex: null, attempt: 2 }),
    ).toBe("crew/89abcdef/build-1-a2");
  });

  it("writes the commit subject from the summary's first line and the trailers", () => {
    const [subject, trailers] = crewCommitMessage({
      runId: "crew-run:0123456789abcdef",
      card,
      model,
      summary: "\nAdd health check handler\nand more",
    });
    expect(subject).toBe("crew(build): Add health check handler");
    expect(trailers.split("\n")).toEqual([
      "Crew-Run: 89abcdef",
      "Crew-Step: build#2 (visit 1, attempt 1)",
      "Crew-Role: implementer",
      "Crew-Model: codex-work/gpt-5.6-terra",
    ]);
  });

  it("falls back to a work-in-progress subject and cuts a long one at 72 characters", () => {
    const message = (summary: string | null) =>
      crewCommitMessage({ runId: "r", card, model: null, summary })[0];
    expect(message(null)).toBe("crew(build): work in progress");
    expect(message("x".repeat(200))).toHaveLength(72);
  });

  it("takes a card's globs from its item, its step or its role", () => {
    const crew = decodeCrew({
      version: 1,
      id: "owns",
      name: "Owns",
      roles: { implementer: { name: "Implementer", owns: ["src/**"] } },
      artifacts: {
        plan: { type: "object", schema: { tasks: { type: "list", item: { owns: "string[]" } } } },
      },
      flow: {
        start: "build",
        steps: {
          build: {
            type: "fanout",
            over: "artifacts.plan.tasks",
            role: "implementer",
            task: "Build.",
            owns: "{{item.owns}}",
          },
          polish: { role: "implementer", task: "Polish.", owns: ["web/**"] },
          free: { role: "implementer", task: "Anything." },
        },
      },
    });
    expect(crewCardOwns(crew, card)).toEqual(["src/api/**", "docs"]);
    expect(crewCardOwns(crew, { ...card, stepId: "polish" })).toEqual(["web/**"]);
    expect(crewCardOwns(crew, { ...card, stepId: "free" })).toEqual(["src/**"]);
  });

  it("reports the changed paths outside a card's globs", () => {
    const owns = ["src/api/**", "docs", "README.md"];
    expect(
      crewOwnershipViolations(
        ["src/api/health.ts", "docs/guide/a.md", "README.md", "src/web/app.ts", "docs.md"],
        owns,
      ),
    ).toEqual(["src/web/app.ts", "docs.md"]);
    // A card that owns nothing in particular may change anything.
    expect(crewOwnershipViolations(["anything.ts"], [])).toEqual([]);
  });

  it("accepts only plain words as tool arguments", () => {
    expect(
      ["src/health.test.ts", "--run", "-t=health", "C:\\repo\\a.ts"].map(isPlainToolArgument),
    ).toEqual([true, true, true, true]);
    expect(
      ["a b", "$(rm -rf .)", "a;b", "a&&b", "`id`", '"x"', "", "a|b", ">out"].map(
        isPlainToolArgument,
      ),
    ).toEqual(Array.from({ length: 9 }, () => false));
  });
});
