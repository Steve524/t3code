import type {
  CrewDiagnostic,
  CrewFile as CrewDefinition,
  CrewStep,
} from "../../../../contracts/src/fork/crews/crewFile.ts";
import type { ToolboxMode } from "../../../../contracts/src/fork/crews/crewToolbox.ts";
import type { ServerProvider } from "../../../../contracts/src/server.ts";
import { compileCrewFlow, crewStepIsolation, findUnlimitedCrewCycles } from "./compileCrewFlow.ts";
import { crewDiagnostic, decodeCrewValue, type CrewSource } from "./crewDiagnostics.ts";
import { CrewFile } from "./crewFileSchema.ts";
import { detectCrewHome } from "./crewHome.ts";
import { crewFanoutItem, invalidCrewTemplateKeys } from "./crewTemplates.ts";
import { resolveRoleToolbox, type CrewToolbox } from "./resolveRoleToolbox.ts";

export interface CrewValidationContext {
  readonly directoryName: string;
  readonly crewDirectory: string;
  readonly source?: CrewSource;
  // Keys are crew-relative paths; realPath and text come from the loader.
  readonly files: Readonly<Record<string, { readonly realPath: string; readonly text: string }>>;
  readonly providerSnapshot?: ReadonlyArray<
    Pick<ServerProvider, "driver" | "enabled"> & {
      readonly models: ReadonlyArray<Pick<ServerProvider["models"][number], "slug">>;
    }
  >;
  readonly toolbox?: CrewToolbox;
  readonly toolboxMode?: ToolboxMode;
}

/** A crew-relative path as the loader keys its files. */
export function normalizedPath(value: string) {
  const parts: string[] = [];
  for (const part of value.replaceAll("\\", "/").split("/")) {
    if (part === "." || part === "") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function owns(crew: CrewDefinition, step: CrewStep) {
  if ("owns" in step && step.owns !== undefined)
    return typeof step.owns === "string" ? [step.owns] : step.owns;
  return "role" in step && Object.hasOwn(crew.roles, step.role)
    ? (crew.roles[step.role]?.owns ?? [])
    : [];
}

function ownershipMayOverlap(left: string, right: string) {
  const prefix = (glob: string) => glob.split(/[*?[{(!]/u)[0]!;
  const suffix = (glob: string) => glob.split(/[*?\]}!)]/u).at(-1)!;
  // shortcut: complex glob intersections are conservative warnings; use an intersection parser if false positives become disruptive.
  return (
    (prefix(left).startsWith(prefix(right)) || prefix(right).startsWith(prefix(left))) &&
    (suffix(left).endsWith(suffix(right)) || suffix(right).endsWith(suffix(left)))
  );
}

export function validateCrew(input: unknown, context: CrewValidationContext) {
  const source = context.source ?? { file: "crew.yaml" };
  const diagnostic = crewDiagnostic(source);
  const decoded = decodeCrewValue(CrewFile, input, diagnostic);
  const diagnostics: CrewDiagnostic[] = [...decoded.diagnostics];
  const result = () => ({
    errors: diagnostics.filter((entry) => entry.severity === "error"),
    warnings: diagnostics.filter((entry) => entry.severity === "warning"),
    info: diagnostics.filter((entry) => entry.severity === "info"),
  });
  const crew = decoded.value;
  if (!crew) return result();
  const error = (message: string, path: CrewDiagnostic["path"]) =>
    diagnostics.push(diagnostic("error", message, path));
  const warning = (message: string, path: CrewDiagnostic["path"]) =>
    diagnostics.push(diagnostic("warning", message, path));
  if (crew.id !== context.directoryName)
    error(`Crew id "${crew.id}" must match directory "${context.directoryName}".`, ["id"]);

  const detected = detectCrewHome(crew, source);
  diagnostics.push(...detected.diagnostics);
  const lead = detected.home?.mode === "lead" ? detected.home.roleId : undefined;
  const flow = compileCrewFlow(crew);
  const steps = new Map(flow.nodes.map(({ id, step }) => [id, step]));
  const usedRoles = new Set(lead ? [lead] : []);
  const toolbox = { ...context.toolbox, crewSource: source };
  const hasFile = (path: string) => Object.hasOwn(context.files, normalizedPath(path));

  function checkText(text: string, path: CrewDiagnostic["path"], step?: CrewStep, file?: string) {
    for (const issue of invalidCrewTemplateKeys(crew!, text, step)) {
      if (file) {
        const before = text.slice(0, issue.offset);
        diagnostics.push({
          severity: "error",
          message: `Unknown template key "${issue.key}".`,
          file,
          path,
          line: before.split("\n").length,
          column: before.length - before.lastIndexOf("\n"),
        });
      } else error(`Unknown template key "${issue.key}".`, path);
    }
  }

  function checkFile(
    value: string,
    path: CrewDiagnostic["path"],
    step?: CrewStep,
    required = false,
  ) {
    const filename = value.startsWith("file:") ? value.slice(5).trim() : value;
    const reference =
      required ||
      value.startsWith("file:") ||
      hasFile(filename) ||
      (!value.includes("\n") &&
        !value.includes("{{") &&
        (/^(?:[./\\]|[A-Za-z]:)/u.test(value) ||
          /\.(?:md|mdx|markdown|txt)$/iu.test(value) ||
          /^\S+[/\\]\S+$/u.test(value)));
    if (!reference) {
      checkText(value, path, step);
      return;
    }
    const relative = normalizedPath(filename);
    if (/^(?:[/\\]|[A-Za-z]:)/u.test(filename) || relative === ".." || relative.startsWith("../")) {
      error(`Path "${filename}" escapes the crew directory.`, path);
      return;
    }
    const file = Object.hasOwn(context.files, relative) ? context.files[relative] : undefined;
    if (!file) {
      error(`Referenced file "${filename}" is missing.`, path);
      return;
    }
    const windows = /^(?:[A-Za-z]:|\\\\)/u.test(context.crewDirectory);
    const canonical = (value: string) =>
      windows ? normalizedPath(value).toLowerCase() : normalizedPath(value);
    const root = canonical(context.crewDirectory);
    if (!canonical(file.realPath).startsWith(`${root}/`)) {
      error(`Path "${filename}" resolves outside the crew directory to "${file.realPath}".`, path);
      return;
    }
    checkText(file.text, path, step, file.realPath);
  }

  for (const [roleId, role] of Object.entries(crew.roles)) {
    const path = ["roles", roleId];
    if (role.instructions) checkFile(role.instructions, [...path, "instructions"]);
    else {
      const folder = `roles/${roleId}/role.md`;
      const flat = `roles/${roleId}.md`;
      if (hasFile(folder)) {
        checkFile(folder, path, undefined, true);
        if (hasFile(flat)) warning(`Both "${folder}" and "${flat}" exist; "${folder}" wins.`, path);
      } else if (hasFile(flat)) checkFile(flat, path, undefined, true);
      else error(`Role "${roleId}" has no instructions or role file.`, path);
    }
    for (const [key, value] of Object.entries(role.persona ?? {})) {
      if (Array.isArray(value))
        value.forEach((text, index) =>
          key === "facts" && text.startsWith("file:")
            ? checkFile(text, [...path, "persona", key, index], undefined, true)
            : checkText(text, [...path, "persona", key, index]),
        );
      else if (typeof value === "string") checkText(value, [...path, "persona", key]);
    }
    if (
      role.model &&
      context.providerSnapshot !== undefined &&
      !context.providerSnapshot.some(
        (provider) =>
          provider.enabled &&
          provider.driver === role.model!.driver &&
          provider.models.some((model) => model.slug === role.model!.model),
      )
    ) {
      warning(
        `No enabled provider offers model hint ${role.model.driver}/${role.model.model}; model selection will fall back.`,
        [...path, "model"],
      );
    }
    diagnostics.push(...resolveRoleToolbox(crew, roleId, toolbox, context.toolboxMode).diagnostics);
  }

  function checkRole(roleId: string, path: CrewDiagnostic["path"]) {
    usedRoles.add(roleId);
    if (!Object.hasOwn(crew!.roles, roleId)) error(`Unknown role "${roleId}".`, path);
  }
  function checkStep(stepId: string, path: CrewDiagnostic["path"]) {
    if (!steps.has(stepId)) error(`Unknown step "${stepId}".`, path);
  }
  checkStep(crew.flow.start, ["flow", "start"]);
  const branchSteps = new Set(
    flow.joins.flatMap((join) => join.branches.flatMap((branch) => branch.steps)),
  );
  for (const { id, step } of flow.nodes) {
    const path = ["flow", "steps", id];
    if ("role" in step) {
      checkRole(step.role, [...path, "role"]);
      if (step.role === lead && (step.type === "fanout" || branchSteps.has(id)))
        error(`Lead role "${lead}" cannot run in fanout or parallel branches.`, [...path, "role"]);
      checkFile(step.task, [...path, "task"], step);
      for (const key of ["produces", "consumes"] as const)
        for (const [index, artifact] of (step[key] ?? []).entries()) {
          if (!Object.hasOwn(crew.artifacts ?? {}, artifact))
            error(`Unknown artifact "${artifact}".`, [...path, key, index]);
        }
    }
    if (step.type === "merge" && typeof step.onConflict === "object") {
      checkRole(step.onConflict.role, [...path, "onConflict", "role"]);
      if (step.onConflict.role === lead && branchSteps.has(id))
        error(`Lead role "${lead}" cannot run in parallel branches.`, [
          ...path,
          "onConflict",
          "role",
        ]);
    }
    if (step.type === "gate") {
      if (step.by === "lead" && !lead)
        error("A gate with by: lead requires lead home mode.", [...path, "by"]);
      checkText(step.prompt, [...path, "prompt"], step);
    }
    if (step.type === "script") {
      if ("tool" in step && !toolbox.repoTools?.some((tool) => tool.name === step.tool))
        error(`Script tool "${step.tool}" is not defined in this project's .t3/tools.yaml.`, [
          ...path,
          "tool",
        ]);
      if ("run" in step) checkText(step.run, [...path, "run"], step);
    }
    if (step.type === "fanout" && crewFanoutItem(crew, step) === undefined)
      error(`Fanout over "${step.over}" must reference a list artifact or list field.`, [
        ...path,
        "over",
      ]);
    if (step.type === "parallel")
      step.branches.forEach((branch, index) => checkStep(branch, [...path, "branches", index]));
    const routes = [
      ...(step.next ? [{ value: step.next, path: [...path, "next"] }] : []),
      ...Object.entries(step.outcomes ?? {}).map(([outcome, value]) => ({
        value,
        path: [...path, "outcomes", outcome],
      })),
    ];
    for (const route of routes) {
      if (typeof route.value === "string") checkStep(route.value, route.path);
      else {
        checkStep(route.value.to, [...route.path, "to"]);
        checkStep(route.value.else, [...route.path, "else"]);
        route.value.resetOn?.forEach((reset, index) =>
          checkStep(reset, [...route.path, "resetOn", index]),
        );
      }
    }
    const ownership = owns(crew, step);
    ownership.forEach((glob, index) => checkText(glob, [...path, "owns", index], step));
    if (
      (step.type === "parallel" || step.type === "fanout" || branchSteps.has(id)) &&
      crewStepIsolation(crew, step, branchSteps.has(id)) === "shared" &&
      ownership.length === 0 &&
      (step.type === "parallel" || step.type === "fanout" || step.type === "task")
    ) {
      error(`Concurrent shared step "${id}" needs owns to keep writers separate.`, [
        ...path,
        "owns",
      ]);
    }
  }

  const next = new Map(flow.nodes.map(({ id }) => [id, [] as string[]]));
  for (const edge of flow.edges) if (steps.has(edge.to)) next.get(edge.from)?.push(edge.to);
  const reached = new Set<string>();
  const pending = [flow.start];
  while (pending.length) {
    const id = pending.pop()!;
    if (reached.has(id) || !steps.has(id)) continue;
    reached.add(id);
    pending.push(...next.get(id)!);
  }
  for (const id of steps.keys())
    if (!reached.has(id)) error(`Step "${id}" is unreachable from start.`, ["flow", "steps", id]);
  if (![...reached].some((id) => steps.get(id)?.type === "end"))
    error("No path from flow.start to an end step.", ["flow", "start"]);
  for (const cycle of findUnlimitedCrewCycles(flow))
    error(`Unlimited cycle: ${cycle.join(" -> ")}. Add a limited route or a user gate.`, [
      "flow",
      "steps",
      cycle[0]!,
    ]);

  for (const roleId of Object.keys(crew.roles))
    if (!usedRoles.has(roleId))
      warning(`Role "${roleId}" is never used by a step.`, ["roles", roleId]);
  if (
    crew.home?.mode === "lead" &&
    crew.home.canEdit &&
    flow.nodes.some(
      ({ id, step }) =>
        (step.type === "task" ||
          step.type === "fanout" ||
          step.type === "script" ||
          step.type === "merge") &&
        crewStepIsolation(crew, step, branchSteps.has(id)) === "shared",
    )
  ) {
    warning("The lead can edit while shared steps use the same integration worktree.", [
      "home",
      "canEdit",
    ]);
  }
  const warnedPairs = new Set<string>();
  for (const join of flow.joins.filter(
    (join) =>
      Math.min(
        steps.get(join.stepId)?.maxParallel ?? Infinity,
        crew.defaults?.maxParallel ?? Infinity,
      ) > 1,
  ))
    for (let i = 0; i < join.branches.length; i++)
      for (let j = i + 1; j < join.branches.length; j++) {
        for (const left of join.branches[i]!.steps)
          for (const right of join.branches[j]!.steps) {
            const pair = [left, right].sort().join("/");
            if (warnedPairs.has(pair)) continue;
            const a = steps.get(left)!;
            const b = steps.get(right)!;
            if (
              crewStepIsolation(crew, a, true) === "read-only" ||
              crewStepIsolation(crew, b, true) === "read-only" ||
              ("role" in a &&
                "role" in b &&
                a.role === b.role &&
                crew.roles[a.role]?.maxConcurrent === 1)
            )
              continue;
            if (owns(crew, a).some((x) => owns(crew, b).some((y) => ownershipMayOverlap(x, y)))) {
              warnedPairs.add(pair);
              warning(
                `Concurrent steps "${left}" and "${right}" have owns globs that may overlap.`,
                ["flow", "steps", join.stepId],
              );
            }
          }
      }
  for (const { id, step } of flow.nodes)
    if (
      step.type === "fanout" &&
      crewStepIsolation(crew, step) !== "read-only" &&
      Math.min(
        step.maxParallel ?? Infinity,
        crew.defaults?.maxParallel ?? Infinity,
        crew.roles[step.role]?.maxConcurrent ?? Infinity,
      ) > 1 &&
      owns(crew, step).some((glob) => !/\{\{\s*item(?:\.|\s*\}\})/u.test(glob))
    ) {
      warning(
        `Fanout "${id}" gives concurrent items overlapping owns globs. Use item-specific ownership.`,
        ["flow", "steps", id, "owns"],
      );
    }
  return result();
}
