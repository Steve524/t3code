import type {
  CrewFile,
  CrewRoute,
  CrewStep,
} from "../../../../contracts/src/fork/crews/crewFile.ts";

export interface CrewFlowEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: "next" | "outcome" | "else" | "branch" | "join";
  readonly outcome?: string;
  readonly limit?: Exclude<CrewRoute, string>;
  // Fallback and join edges refer to the original route's counter.
  readonly routeId?: string;
}

interface CrewFlowJoin {
  readonly stepId: string;
  readonly mode: "all" | "any";
  readonly branches: ReadonlyArray<{
    readonly start: string;
    readonly steps: ReadonlyArray<string>;
    readonly exits: ReadonlyArray<string>;
  }>;
  readonly routeIds: ReadonlyArray<string>;
}

function adjacency(ids: ReadonlyArray<string>, edges: ReadonlyArray<CrewFlowEdge>) {
  const result = new Map(ids.map((id) => [id, [] as string[]]));
  for (const edge of edges) if (result.has(edge.to)) result.get(edge.from)?.push(edge.to);
  return result;
}

// Tarjan visits each node and edge once, including disconnected components.
function stronglyConnected(ids: ReadonlyArray<string>, edges: ReadonlyArray<CrewFlowEdge>) {
  const next = adjacency(ids, edges);
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const active = new Set<string>();
  const components: string[][] = [];
  let index = 0;
  function visit(id: string) {
    const current = index++;
    indices.set(id, current);
    low.set(id, current);
    stack.push(id);
    active.add(id);
    for (const target of next.get(id) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        low.set(id, Math.min(low.get(id)!, low.get(target)!));
      } else if (active.has(target)) low.set(id, Math.min(low.get(id)!, indices.get(target)!));
    }
    if (low.get(id) !== current) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      active.delete(member);
      component.push(member);
    } while (member !== id);
    components.push(component);
  }
  for (const id of ids) if (!indices.has(id)) visit(id);
  return components;
}

export function compileCrewFlow(crew: CrewFile) {
  const nodes = Object.entries(crew.flow.steps).map(([id, step]) => ({ id, step }));
  const edges: CrewFlowEdge[] = [];
  const routeEdges = new Map<string, CrewFlowEdge[]>();
  for (const { id, step } of nodes) {
    function route(value: CrewRoute, kind: "next" | "outcome", outcome?: string) {
      const routeId = `${id}/${kind}${outcome === undefined ? "" : `/${outcome}`}`;
      const base = { id: routeId, from: id, kind, ...(outcome === undefined ? {} : { outcome }) };
      if (typeof value === "string") edges.push({ ...base, to: value });
      else {
        edges.push({
          ...base,
          to: value.to,
          limit: { ...value, label: value.label ?? `${id} ${outcome ?? "next"}` },
        });
        edges.push({ id: `${routeId}/else`, from: id, to: value.else, kind: "else", routeId });
      }
    }
    const offset = edges.length;
    if (step.type !== "end") {
      if (step.next) route(step.next, "next");
      for (const [outcome, value] of Object.entries(step.outcomes ?? {}))
        route(value, "outcome", outcome);
    }
    routeEdges.set(id, edges.slice(offset));
    if (step.type === "parallel") {
      for (const [index, branch] of step.branches.entries())
        edges.push({ id: `${id}/branch/${index}`, from: id, to: branch, kind: "branch" });
    }
  }

  const next = adjacency(
    nodes.map(({ id }) => id),
    edges,
  );
  const joins: CrewFlowJoin[] = [];
  const building = new Set<string>();
  const built = new Set<string>();
  const nodeSteps = new Map(nodes.map(({ id, step }) => [id, step]));
  function buildJoin(id: string) {
    const step = nodeSteps.get(id);
    if (
      !step ||
      (step.type !== "parallel" && step.type !== "fanout") ||
      built.has(id) ||
      building.has(id)
    )
      return;
    building.add(id);
    const routes = routeEdges.get(id)!;
    const stop = new Set(routes.map((edge) => edge.to));
    const branches = (step.type === "parallel" ? step.branches : []).map((start) => {
      const seen = new Set<string>();
      const exits: string[] = [];
      function visit(node: string) {
        if (stop.has(node) || seen.has(node) || !next.has(node)) return;
        seen.add(node);
        buildJoin(node);
        const targets = next.get(node)!;
        if (targets.length === 0) exits.push(node);
        for (const target of targets) visit(target);
      }
      visit(start);
      return { start, steps: [...seen], exits };
    });
    for (const branch of branches)
      for (const exit of branch.exits)
        for (const edge of routes) {
          edges.push({
            ...edge,
            id: `${id}/join/${branch.start}/${exit}/${edge.id}`,
            from: exit,
            kind: "join",
            routeId: edge.routeId ?? edge.id,
          });
          if (next.has(edge.to)) next.get(exit)?.push(edge.to);
        }
    joins.push({
      stepId: id,
      mode: step.join ?? "all",
      branches,
      routeIds: routes.filter((edge) => edge.kind !== "else").map((edge) => edge.id),
    });
    building.delete(id);
    built.add(id);
  }
  for (const { id } of nodes) buildJoin(id);

  const selfLoops = new Set(edges.filter((edge) => edge.from === edge.to).map((edge) => edge.from));
  const loopRegions = stronglyConnected(
    nodes.map(({ id }) => id),
    edges,
  )
    .filter((steps) => steps.length > 1 || selfLoops.has(steps[0]!))
    .map((steps) => ({
      id: steps.reduce((a, b) => (a < b ? a : b)),
      steps,
      routeIds: [] as string[],
    }));
  const regionByStep = new Map(
    loopRegions.flatMap((region) => region.steps.map((id) => [id, region] as const)),
  );
  for (const edge of edges)
    if (edge.limit && edge.kind !== "join") regionByStep.get(edge.from)?.routeIds.push(edge.id);
  const fanouts = nodes.flatMap(({ id, step }) =>
    step.type === "fanout"
      ? [
          {
            stepId: id,
            over: step.over,
            roleId: step.role,
            join: step.join ?? "all",
            maxParallel: step.maxParallel ?? crew.defaults?.maxParallel,
          },
        ]
      : [],
  );
  return { start: crew.flow.start, nodes, edges, loopRegions, fanouts, joins };
}

export type CompiledCrewFlow = ReturnType<typeof compileCrewFlow>;

export function findUnlimitedCrewCycles(flow: CompiledCrewFlow) {
  const steps = new Map(flow.nodes.map(({ id, step }) => [id, step]));
  const next = adjacency(
    [...steps.keys()],
    flow.edges.filter((edge) => {
      const step = steps.get(edge.from);
      return !edge.limit && !(step?.type === "gate" && (step.by ?? "user") === "user");
    }),
  );
  const visited = new Set<string>();
  const active = new Map<string, number>();
  const path: string[] = [];
  const cycles: string[][] = [];
  function visit(id: string) {
    visited.add(id);
    active.set(id, path.length);
    path.push(id);
    for (const target of next.get(id) ?? []) {
      const start = active.get(target);
      if (start !== undefined) cycles.push([...path.slice(start), target]);
      else if (!visited.has(target)) visit(target);
      // One witness suffices; enumerating all cycles can produce quadratic output.
      if (cycles.length > 0) return;
    }
    path.pop();
    active.delete(id);
  }
  for (const id of steps.keys()) {
    if (!visited.has(id)) visit(id);
    if (cycles.length > 0) break;
  }
  return cycles;
}

export function crewStepIsolation(crew: CrewFile, step: CrewStep, parallel = false) {
  return (
    step.isolation ??
    crew.defaults?.isolation ??
    (parallel || step.type === "fanout" || step.type === "parallel" ? "worktree" : "shared")
  );
}
