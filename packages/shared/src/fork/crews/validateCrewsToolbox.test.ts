import { describe, expect, it } from "vite-plus/test";
import { stringify } from "yaml";

import { decodeCrew, definition, example, worker } from "./crewTestFixtures.ts";
import { resolveRoleToolbox } from "./resolveRoleToolbox.ts";
import { validateCrewsToolbox } from "./validateCrewsToolbox.ts";

const crew = decodeCrew({
  ...example,
  roles: { worker: { ...worker, tags: ["worker"] } },
  tools: ["base"],
});

describe("project toolbox validation", () => {
  it.each([
    { name: "invalid version", input: { version: 2 }, severity: "error" },
    {
      name: "invalid grants",
      input: { version: 1, tags: { worker: { tools: "e2e" } } },
      severity: "error",
    },
    {
      name: "wildcard crew with a named role",
      input: { version: 1, crews: { "*": { worker: { tools: ["e2e"] } } } },
      severity: "error",
    },
    {
      name: "unknown crew",
      input: { version: 1, crews: { absent: { "*": { tools: ["e2e"] } } } },
      severity: "warning",
    },
    {
      name: "unknown role",
      input: { version: 1, crews: { example: { missing: { tools: ["e2e"] } } } },
      severity: "warning",
    },
    {
      name: "unused tag",
      input: { version: 1, tags: { frontend: { tools: ["e2e"] } } },
      severity: "info",
    },
  ])("reports $name on the project", ({ input, severity }) => {
    const result = validateCrewsToolbox(input, {
      crews: [crew],
      source: { file: "/repo/.t3/crews.yaml", text: stringify(input) },
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.severity).toBe(severity);
    expect(result.diagnostics[0]?.file).toBe("/repo/.t3/crews.yaml");
    expect(result.diagnostics[0]?.line).toBeGreaterThan(0);
    expect(result.diagnostics[0]?.column).toBeGreaterThan(0);
    expect(result.value === null).toBe(severity === "error");
  });

  it("reports an ignored project crew directory even if the grant file is invalid", () => {
    const result = validateCrewsToolbox(
      { version: 2 },
      { crews: [], hasProjectCrewsDirectory: true },
    );
    expect(
      result.diagnostics.some(
        (issue) =>
          issue.severity === "info" &&
          issue.file === ".t3/crews.yaml" &&
          issue.message.includes("ignored"),
      ),
    ).toBe(true);
  });

  it("accepts all supported selectors and tags carried by any installed role", () => {
    const result = validateCrewsToolbox(
      {
        version: 1,
        tags: { worker: { tools: ["e2e"] } },
        crews: {
          example: { worker: { skills: ["guide"] }, "*": { tools: ["lint"] } },
          "*": { "*": { mcp: ["docs"] } },
        },
      },
      { crews: [crew] },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.value).not.toBeNull();
  });

  it("ignores every grant in a malformed file while retaining crew grants", () => {
    const parsed = validateCrewsToolbox(
      {
        version: 1,
        tags: { worker: { tools: ["e2e"] } },
        crews: { "*": { worker: { tools: ["bad"] } } },
      },
      { crews: [crew] },
    );
    expect(parsed.value).toBeNull();
    const result = resolveRoleToolbox(crew, "worker", {
      grants: parsed.value,
      repoTools: [definition("base", "/repo/tools.yaml"), definition("e2e", "/repo/tools.yaml")],
    });
    expect(result.items.map((item) => item.name)).toEqual(["base"]);
    expect(result.diagnostics).toEqual([]);
  });
});
