import { describe, expect, it } from "vite-plus/test";

import { compileCrewFlow, findUnlimitedCrewCycles } from "./compileCrewFlow.ts";
import { decodeCrew, end, task, withSteps, worker } from "./crewTestFixtures.ts";

describe("compileCrewFlow", () => {
  it("keeps step ids, normalizes routes, and includes fallback targets in loop regions", () => {
    const crew = decodeCrew(
      withSteps({
        work: { ...task, next: "review" },
        review: {
          ...task,
          outcomes: { changes: { to: "fix", max: 3, else: "approval" }, approve: "approval" },
        },
        fix: { ...task, next: "review" },
        approval: {
          type: "gate",
          prompt: "Approve?",
          outcomes: { reject: "fix", approve: "done" },
        },
        done: end,
      }),
    );
    const snapshot = structuredClone(crew);
    const flow = compileCrewFlow(crew);
    expect(flow.nodes.map((node) => node.id)).toEqual([
      "work",
      "review",
      "fix",
      "approval",
      "done",
    ]);
    expect(flow.edges).toContainEqual({
      id: "review/outcome/changes",
      from: "review",
      to: "fix",
      kind: "outcome",
      outcome: "changes",
      limit: { to: "fix", max: 3, else: "approval", label: "review changes" },
    });
    expect(flow.edges).toContainEqual({
      id: "review/outcome/changes/else",
      from: "review",
      to: "approval",
      kind: "else",
      routeId: "review/outcome/changes",
    });
    expect(flow.loopRegions).toHaveLength(1);
    expect(flow.loopRegions[0]?.steps.toSorted()).toEqual(["approval", "fix", "review"]);
    expect(flow.loopRegions[0]?.routeIds).toEqual(["review/outcome/changes"]);
    expect(findUnlimitedCrewCycles(flow)).toEqual([]);
    expect(crew).toEqual(snapshot);
    expect(compileCrewFlow(crew)).toEqual(flow);
  });

  it.each([
    { name: "unlimited review/fix", route: "fix", gate: undefined, invalid: true },
    {
      name: "limited review/fix",
      route: { to: "fix", max: 2, else: "done" },
      gate: undefined,
      invalid: false,
    },
    { name: "default user gate, AC 2a", route: "fix", gate: {}, invalid: false },
    { name: "explicit user gate, AC 2a", route: "fix", gate: { by: "user" }, invalid: false },
    {
      name: "lead gate does not pace a cycle, AC 2a",
      route: "fix",
      gate: { by: "lead" },
      invalid: true,
    },
    {
      name: "a limited lead decision is bounded",
      route: { to: "fix", max: 2, else: "done" },
      gate: { by: "lead" },
      invalid: false,
    },
    {
      name: "exhausted fallback still loops",
      route: { to: "done", max: 2, else: "fix" },
      gate: undefined,
      invalid: true,
    },
  ])("checks $name", ({ route, gate, invalid }) => {
    const review = gate === undefined ? task : { type: "gate", prompt: "Fix?", ...gate };
    const flow = compileCrewFlow(
      decodeCrew(
        withSteps({
          work: { ...task, next: "review" },
          review: { ...review, outcomes: { changes: route, approve: "done" } },
          fix: { ...task, next: "review" },
          done: end,
        }),
      ),
    );
    const cycles = findUnlimitedCrewCycles(flow);
    expect(cycles.length > 0).toBe(invalid);
    if (invalid) expect(cycles[0]).toEqual(["review", "fix", "review"]);
  });

  it.each([
    { name: "self loop", steps: { work: { ...task, next: "work" } }, regions: [["work"]] },
    {
      name: "disconnected cycles",
      steps: {
        work: { ...task, next: "done" },
        done: end,
        a: { ...task, next: "b" },
        b: { ...task, next: "a" },
        c: { ...task, next: "c" },
      },
      regions: [["a", "b"], ["c"]],
    },
    {
      name: "acyclic singleton steps",
      steps: { work: { ...task, next: "done" }, done: end },
      regions: [],
    },
    {
      name: "unknown references are left for validation",
      steps: { work: { ...task, next: "missing" } },
      regions: [],
    },
  ])("finds SCCs for $name", ({ steps, regions }) => {
    const flow = compileCrewFlow(decodeCrew(withSteps(steps)));
    expect(flow.loopRegions.map((region) => region.steps.toSorted()).sort()).toEqual(regions);
  });

  it.each([undefined, [], ["approval"]])(
    "preserves resetOn=%j and explicit counter labels",
    (resetOn) => {
      const route = {
        to: "work",
        max: 2,
        else: "approval",
        label: "Build attempts",
        ...(resetOn === undefined ? {} : { resetOn }),
      };
      const flow = compileCrewFlow(
        decodeCrew(withSteps({ work: { ...task, next: route }, approval: end })),
      );
      expect(flow.edges[0]?.limit).toEqual(route);
    },
  );

  it.each(["all", "any"] as const)("compiles %s joins and fanout metadata", (join) => {
    const flow = compileCrewFlow(
      decodeCrew(
        withSteps(
          {
            work: { ...task, next: "parallel" },
            parallel: { type: "parallel", branches: ["left", "right"], join, next: "fanout" },
            left: task,
            right: task,
            fanout: {
              ...task,
              type: "fanout",
              over: "artifacts.items",
              maxParallel: 2,
              join,
              next: "done",
            },
            done: end,
          },
          { artifacts: { items: { type: "list", item: "string" } } },
        ),
      ),
    );
    expect(flow.joins[0]).toMatchObject({
      stepId: "parallel",
      mode: join,
      branches: [
        { start: "left", steps: ["left"], exits: ["left"] },
        { start: "right", steps: ["right"], exits: ["right"] },
      ],
    });
    expect(
      flow.edges.filter((edge) => edge.kind === "join").map((edge) => [edge.from, edge.to]),
    ).toEqual([
      ["left", "fanout"],
      ["right", "fanout"],
    ]);
    expect(flow.fanouts).toEqual([
      { stepId: "fanout", roleId: "worker", over: "artifacts.items", maxParallel: 2, join },
    ]);
    expect(flow.loopRegions).toEqual([]);
  });

  it("joins nested groups before collecting the outer branch exits", () => {
    const flow = compileCrewFlow(
      decodeCrew(
        withSteps({
          work: { ...task, next: "outer" },
          outer: { type: "parallel", branches: ["inner", "right"], next: "done" },
          inner: { type: "parallel", branches: ["a", "b"], next: "after" },
          a: task,
          b: task,
          after: task,
          right: task,
          done: end,
        }),
      ),
    );
    expect(
      flow.edges.filter((edge) => edge.kind === "join").map((edge) => [edge.from, edge.to]),
    ).toEqual([
      ["a", "after"],
      ["b", "after"],
      ["after", "done"],
      ["right", "done"],
    ]);
    expect(flow.joins.find((join) => join.stepId === "outer")?.branches[0]?.exits).toEqual([
      "after",
    ]);
    expect(findUnlimitedCrewCycles(flow)).toEqual([]);
  });

  it("includes implicit joins in cycle and region analysis", () => {
    const flow = compileCrewFlow(
      decodeCrew(
        withSteps(
          {
            work: { type: "parallel", branches: ["a", "b"], next: "again" },
            a: task,
            b: task,
            again: { ...task, next: "work" },
          },
          { home: { mode: "lead", role: "lead" }, roles: { worker, lead: worker } },
        ),
      ),
    );
    expect(flow.loopRegions[0]?.steps.toSorted()).toEqual(["a", "again", "b", "work"]);
    expect(findUnlimitedCrewCycles(flow).length).toBeGreaterThan(0);
  });

  it("handles deep acyclic flows without dropping steps", () => {
    const steps = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [
        `s${i}`,
        { ...task, next: i === 499 ? "done" : `s${i + 1}` },
      ]),
    );
    const flow = compileCrewFlow(
      decodeCrew({
        ...withSteps({ ...steps, done: end }),
        flow: { start: "s0", steps: { ...steps, done: end } },
      }),
    );
    expect(flow.nodes).toHaveLength(501);
    expect(flow.edges).toHaveLength(500);
    expect(flow.loopRegions).toEqual([]);
    expect(findUnlimitedCrewCycles(flow)).toEqual([]);
  });
});
