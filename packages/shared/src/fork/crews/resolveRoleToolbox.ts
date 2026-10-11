import type {
  CrewDiagnostic,
  CrewFile,
  ResolvedRoleToolbox,
} from "../../../../contracts/src/fork/crews/crewFile.ts";
import type {
  CrewsToolboxFile,
  CrewToolboxGrant,
  ToolboxMode,
} from "../../../../contracts/src/fork/crews/crewToolbox.ts";
import { crewDiagnostic, type CrewSource } from "./crewDiagnostics.ts";

export interface CrewToolboxDefinition {
  readonly name: string;
  readonly path: string;
  // Supplied by the loader, including canonical casing on Windows.
  readonly realPath: string;
}

export interface CrewToolbox {
  readonly roleSkills?: Readonly<Record<string, ReadonlyArray<CrewToolboxDefinition>>>;
  readonly crewSkills?: ReadonlyArray<CrewToolboxDefinition>;
  readonly homeSkills?: ReadonlyArray<CrewToolboxDefinition>;
  readonly repoSkills?: ReadonlyArray<CrewToolboxDefinition>;
  readonly homeMcp?: ReadonlyArray<CrewToolboxDefinition>;
  readonly repoMcp?: ReadonlyArray<CrewToolboxDefinition>;
  readonly repoTools?: ReadonlyArray<CrewToolboxDefinition>;
  readonly grants?: CrewsToolboxFile | null;
  readonly crewSource?: CrewSource;
  readonly grantsSource?: CrewSource;
}

type ToolboxItem = ResolvedRoleToolbox["items"][number];

export function resolveRoleToolbox(
  crew: CrewFile,
  roleId: string,
  toolbox: CrewToolbox,
  mode: ToolboxMode = "extend",
): ResolvedRoleToolbox {
  const crewSource = toolbox.crewSource ?? { file: "crew.yaml" };
  const grantsSource = toolbox.grantsSource ?? { file: ".t3/crews.yaml" };
  const diagnostic = crewDiagnostic(crewSource);
  const repoDiagnostic = crewDiagnostic(grantsSource);
  const items: ToolboxItem[] = [];
  const diagnostics: CrewDiagnostic[] = [];
  const role = Object.hasOwn(crew.roles, roleId) ? crew.roles[roleId] : undefined;
  if (!role)
    return {
      items,
      diagnostics: [diagnostic("error", `Unknown role "${roleId}".`, ["roles", roleId])],
    };

  const grants = new Map<ToolboxItem["kind"], Map<string, Array<ToolboxItem["grantedBy"][number]>>>(
    [
      ["skill", new Map()],
      ["mcp", new Map()],
      ["tool", new Map()],
    ],
  );
  function grant(
    kind: ToolboxItem["kind"],
    name: string,
    file: string,
    path: CrewDiagnostic["path"],
  ) {
    const names = grants.get(kind)!;
    const sources = names.get(name) ?? [];
    if (
      !sources.some(
        (entry) => entry.file === file && JSON.stringify(entry.path) === JSON.stringify(path),
      )
    )
      sources.push({ file, path });
    names.set(name, sources);
  }
  function grantLists(
    value: CrewToolboxGrant | undefined,
    file: string,
    path: CrewDiagnostic["path"],
  ) {
    for (const [key, kind] of [
      ["skills", "skill"],
      ["mcp", "mcp"],
      ["tools", "tool"],
    ] as const) {
      for (const [index, name] of (value?.[key] ?? []).entries())
        grant(kind, name, file, [...path, key, index]);
    }
  }
  const roleSkills = Object.hasOwn(toolbox.roleSkills ?? {}, roleId)
    ? (toolbox.roleSkills?.[roleId] ?? [])
    : [];
  for (const skill of [...roleSkills, ...(toolbox.crewSkills ?? [])])
    grant("skill", skill.name, skill.path, []);
  grantLists(crew, crewSource.file, []);
  grantLists(role, crewSource.file, ["roles", roleId]);
  const repoGrants = toolbox.grants;
  const specific =
    repoGrants?.crews && Object.hasOwn(repoGrants.crews, crew.id)
      ? repoGrants.crews[crew.id]
      : undefined;
  grantLists(
    specific && Object.hasOwn(specific, roleId) ? specific[roleId] : undefined,
    grantsSource.file,
    ["crews", crew.id, roleId],
  );
  grantLists(specific?.["*"], grantsSource.file, ["crews", crew.id, "*"]);
  for (const tag of new Set(role.tags ?? [])) {
    grantLists(
      repoGrants?.tags && Object.hasOwn(repoGrants.tags, tag) ? repoGrants.tags[tag] : undefined,
      grantsSource.file,
      ["tags", tag],
    );
  }
  grantLists(repoGrants?.crews?.["*"]?.["*"], grantsSource.file, ["crews", "*", "*"]);

  const definitions = new Map<
    ToolboxItem["kind"],
    Array<CrewToolboxDefinition & { source: ToolboxItem["source"] }>
  >();
  const sourced = (
    values: ReadonlyArray<CrewToolboxDefinition> | undefined,
    source: ToolboxItem["source"],
  ) => (values ?? []).map((value) => ({ ...value, source }));
  definitions.set("skill", [
    ...sourced(roleSkills, "role"),
    ...sourced(toolbox.crewSkills, "crew"),
    ...sourced(toolbox.homeSkills, "home"),
    ...sourced(toolbox.repoSkills, "repo"),
  ]);
  definitions.set("mcp", [
    ...sourced(toolbox.homeMcp, "home"),
    ...sourced(toolbox.repoMcp, "repo"),
  ]);
  definitions.set("tool", sourced(toolbox.repoTools, "repo"));

  for (const [kind, names] of grants)
    for (const [name, grantedBy] of names) {
      const candidates = definitions.get(kind)!.filter((item) => item.name === name);
      const home = candidates.filter((item) => item.source !== "repo");
      const repo = candidates.find((item) => item.source === "repo");
      const winner = mode === "override" ? (repo ?? home[0]) : (home[0] ?? repo);
      const origin = grantedBy[0]!;
      const report = origin.file === grantsSource.file ? repoDiagnostic : diagnostic;
      if (!winner) {
        diagnostics.push(
          report(
            "warning",
            `Unresolved ${kind} "${name}"; role "${roleId}" runs without it.`,
            origin.path,
          ),
        );
        continue;
      }
      if (repo && home[0] && repo.realPath !== home[0].realPath) {
        diagnostics.push(
          report(
            "warning",
            `${kind} "${name}" collides at "${home[0].path}" and "${repo.path}"; ${mode} uses "${winner.path}".`,
            origin.path,
          ),
        );
      }
      const shadowed = home.filter((item) => item.realPath !== home[0]?.realPath);
      if (home[0]?.source === "role" && shadowed.length > 0) {
        diagnostics.push(
          report(
            "warning",
            `Role skill "${name}" at "${home[0].path}" shadows ${shadowed.map((item) => `"${item.path}"`).join(", ")}; resolved winner is "${winner.path}".`,
            origin.path,
          ),
        );
      }
      items.push({ kind, name, path: winner.path, source: winner.source, grantedBy });
    }
  return { items, diagnostics };
}
