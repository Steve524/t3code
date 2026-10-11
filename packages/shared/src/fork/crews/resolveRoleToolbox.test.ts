import { describe, expect, it } from "vite-plus/test";

import { decodeCrew, definition, example, worker } from "./crewTestFixtures.ts";
import { resolveRoleToolbox, type CrewToolbox } from "./resolveRoleToolbox.ts";
import { validateCrewsToolbox } from "./validateCrewsToolbox.ts";

const crew = decodeCrew({
  ...example,
  roles: { worker: { ...worker, tags: ["worker", "frontend"] }, reviewer: worker },
});
const d = definition;

describe("role toolbox grants", () => {
  it("AC 15 grants role-folder skills only to that role and crew skills to every role", () => {
    const toolbox = {
      roleSkills: {
        worker: [d("storybook-guide", "/crew/roles/worker/skills/storybook-guide/SKILL.md")],
      },
      crewSkills: [d("repo-map", "/crew/skills/repo-map/SKILL.md")],
      homeSkills: [d("ungranted", "/home/skills/ungranted/SKILL.md")],
      repoSkills: [d("also-ungranted", "/repo/.t3/skills/also-ungranted/SKILL.md")],
    };
    expect(
      resolveRoleToolbox(crew, "worker", toolbox).items.map(({ name, source }) => [name, source]),
    ).toEqual([
      ["storybook-guide", "role"],
      ["repo-map", "crew"],
    ]);
    expect(
      resolveRoleToolbox(crew, "reviewer", toolbox).items.map(({ name, source }) => [name, source]),
    ).toEqual([["repo-map", "crew"]]);
  });

  it.each([
    {
      name: "crew lists",
      input: { ...example, skills: ["skill"], mcp: ["server"], tools: ["tool"] },
    },
    {
      name: "role lists",
      input: {
        ...example,
        roles: { worker: { ...worker, skills: ["skill"], mcp: ["server"], tools: ["tool"] } },
      },
    },
  ])("resolves every kind from $name", ({ input }) => {
    const result = resolveRoleToolbox(decodeCrew(input), "worker", {
      homeSkills: [d("skill", "/home/skill")],
      homeMcp: [d("server", "/home/mcp.yaml")],
      repoTools: [d("tool", "/repo/.t3/tools.yaml")],
    });
    expect(result.items.map(({ kind, name }) => [kind, name])).toEqual([
      ["skill", "skill"],
      ["mcp", "server"],
      ["tool", "tool"],
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it.each([
    {
      name: "exact role",
      grants: { crews: { example: { worker: { tools: ["e2e"] } } } },
      matches: true,
    },
    {
      name: "whole crew",
      grants: { crews: { example: { "*": { tools: ["e2e"] } } } },
      matches: true,
    },
    { name: "role tag", grants: { tags: { frontend: { tools: ["e2e"] } } }, matches: true },
    { name: "everyone", grants: { crews: { "*": { "*": { tools: ["e2e"] } } } }, matches: true },
    {
      name: "other crew",
      grants: { crews: { other: { worker: { tools: ["e2e"] } } } },
      matches: false,
    },
    {
      name: "other role",
      grants: { crews: { example: { reviewer: { tools: ["e2e"] } } } },
      matches: false,
    },
    { name: "other tag", grants: { tags: { backend: { tools: ["e2e"] } } }, matches: false },
  ])("matches $name grants", ({ grants, matches }) => {
    const parsed = validateCrewsToolbox({ version: 1, ...grants }, { crews: [crew] });
    const result = resolveRoleToolbox(crew, "worker", {
      grants: parsed.value,
      repoTools: [d("e2e", "/repo/.t3/tools.yaml")],
    });
    expect(result.items.map((item) => item.name)).toEqual(matches ? ["e2e"] : []);
    expect(result.diagnostics).toEqual([]);
  });

  it("AC 17 grants by tag across crews without naming either crew", () => {
    const toolbox: CrewToolbox = {
      grants: { version: 1, tags: { worker: { tools: ["e2e"] } } },
      repoTools: [d("e2e", "/repo/.t3/tools.yaml")],
    };
    for (const id of ["feature-trio", "bugfix-duo"]) {
      const result = resolveRoleToolbox({ ...crew, id }, "worker", toolbox);
      expect(result.items).toEqual([
        {
          name: "e2e",
          kind: "tool",
          path: "/repo/.t3/tools.yaml",
          source: "repo",
          grantedBy: [{ file: ".t3/crews.yaml", path: ["tags", "worker", "tools", 0] }],
        },
      ]);
    }
  });

  it("AC 18 deduplicates exact and tag grants without a collision", () => {
    const result = resolveRoleToolbox(crew, "worker", {
      grants: {
        version: 1,
        tags: { worker: { tools: ["e2e"] } },
        crews: { example: { worker: { tools: ["e2e"] } } },
      },
      repoTools: [d("e2e", "/repo/.t3/tools.yaml")],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.grantedBy).toEqual([
      { file: ".t3/crews.yaml", path: ["crews", "example", "worker", "tools", 0] },
      { file: ".t3/crews.yaml", path: ["tags", "worker", "tools", 0] },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("unions all four grant sources while retaining their provenance", () => {
    const grantedCrew = {
      ...crew,
      skills: ["shared"],
      roles: {
        ...crew.roles,
        worker: { ...crew.roles.worker!, skills: ["shared"], tags: ["worker", "worker"] },
      },
    };
    const shared = d("shared", "/same/SKILL.md");
    const toolbox: CrewToolbox = {
      roleSkills: { worker: [shared] },
      crewSkills: [shared],
      grants: {
        version: 1,
        tags: { worker: { skills: ["shared"] } },
        crews: {
          example: { worker: { skills: ["shared"] }, "*": { tools: ["lint"] } },
          "*": { "*": { mcp: ["server"] } },
        },
      },
      repoTools: [d("lint", "/repo/tools.yaml")],
      repoMcp: [d("server", "/repo/mcp.yaml")],
    };
    const snapshot = structuredClone(toolbox);
    const result = resolveRoleToolbox(grantedCrew, "worker", toolbox);
    expect(result.items.map((item) => item.name)).toEqual(["shared", "server", "lint"]);
    expect(result.items[0]?.grantedBy).toHaveLength(5);
    expect(result.diagnostics).toEqual([]);
    expect(toolbox).toEqual(snapshot);
  });

  it.each(["skill", "mcp", "tool"] as const)("keeps missing %s references soft", (kind) => {
    const key = kind === "skill" ? "skills" : kind === "tool" ? "tools" : "mcp";
    const result = resolveRoleToolbox({ ...crew, [key]: ["missing", "missing"] }, "worker", {});
    expect(result.items).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      severity: "warning",
      path: [key, 0],
      line: 1,
      column: 1,
    });
  });

  it("locates missing repo grants in their own file", () => {
    const result = resolveRoleToolbox(crew, "worker", {
      grants: { version: 1, tags: { worker: { tools: ["missing"] } } },
      grantsSource: {
        file: "/repo/.t3/crews.yaml",
        text: "version: 1\ntags:\n  worker:\n    tools: [missing]\n",
      },
    });
    expect(result.diagnostics[0]).toMatchObject({
      file: "/repo/.t3/crews.yaml",
      line: 4,
      column: 13,
      path: ["tags", "worker", "tools", 0],
    });
  });
});

describe("definition precedence", () => {
  it.each(["extend", "override"] as const)("uses the %s winner and names both paths", (mode) => {
    const result = resolveRoleToolbox(
      { ...crew, skills: ["testing"], mcp: ["server"] },
      "worker",
      {
        homeSkills: [d("testing", "/home/testing")],
        repoSkills: [d("testing", "/repo/testing")],
        homeMcp: [d("server", "/home/mcp.yaml")],
        repoMcp: [d("server", "/repo/mcp.yaml")],
      },
      mode,
    );
    expect(result.items.map((item) => item.source)).toEqual([
      mode === "extend" ? "home" : "repo",
      mode === "extend" ? "home" : "repo",
    ]);
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics[0]?.message).toContain('"/home/testing" and "/repo/testing"');
    expect(result.diagnostics[0]?.message).toContain(
      `${mode} uses "/${mode === "extend" ? "home" : "repo"}/testing"`,
    );
  });

  it.each([
    {
      name: "role before crew and library",
      role: true,
      crew: true,
      expected: "role",
      warning: true,
    },
    { name: "role before library", role: true, crew: false, expected: "role", warning: true },
    { name: "crew before library", role: false, crew: true, expected: "crew", warning: false },
    { name: "library alone", role: false, crew: false, expected: "home", warning: false },
  ])("resolves $name", ({ role, crew: crewFolder, expected, warning }) => {
    const result = resolveRoleToolbox({ ...crew, skills: ["testing"] }, "worker", {
      roleSkills: { worker: role ? [d("testing", "/role/testing")] : [] },
      crewSkills: crewFolder ? [d("testing", "/crew/testing")] : [],
      homeSkills: [d("testing", "/home/testing")],
    });
    expect(result.items[0]?.source).toBe(expected);
    expect(result.diagnostics.length > 0).toBe(warning);
  });

  it.each(["extend", "override"] as const)(
    "same realpath counts once without collisions in %s",
    (mode) => {
      const result = resolveRoleToolbox(
        { ...crew, skills: ["testing"], mcp: ["server"] },
        "worker",
        {
          roleSkills: { worker: [d("testing", "/role/link", "/same/skill")] },
          crewSkills: [d("testing", "/crew/link", "/same/skill")],
          homeSkills: [d("testing", "/home/link", "/same/skill")],
          repoSkills: [d("testing", "/repo/link", "/same/skill")],
          homeMcp: [d("server", "/home/mcp.yaml", "/same/mcp.yaml")],
          repoMcp: [d("server", "/repo/mcp.yaml", "/same/mcp.yaml")],
        },
        mode,
      );
      expect(result.items).toHaveLength(2);
      expect(result.diagnostics).toEqual([]);
    },
  );

  it("keeps bare names separate by kind, including several tools in one file", () => {
    const result = resolveRoleToolbox(
      { ...crew, skills: ["same"], mcp: ["same"], tools: ["same", "second"] },
      "worker",
      {
        homeSkills: [d("same", "/skill")],
        homeMcp: [d("same", "/mcp.yaml")],
        repoTools: [d("same", "/tools.yaml"), d("second", "/tools.yaml")],
      },
    );
    expect(result.items.map((item) => [item.kind, item.name])).toEqual([
      ["skill", "same"],
      ["mcp", "same"],
      ["tool", "same"],
      ["tool", "second"],
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it.each(["extend", "override"] as const)(
    "falls back to either side in %s without removing grants",
    (mode) => {
      const result = resolveRoleToolbox(
        { ...crew, skills: ["home-only", "repo-only"] },
        "worker",
        {
          homeSkills: [d("home-only", "/home/skill")],
          repoSkills: [d("repo-only", "/repo/skill")],
        },
        mode,
      );
      expect(result.items.map((item) => item.source)).toEqual(["home", "repo"]);
      expect(result.diagnostics).toEqual([]);
    },
  );
});
