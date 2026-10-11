import type { ModelSelection, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { getBrowseParentPath } from "@t3tools/client-runtime/state/projects";
import * as Equal from "effect/Equal";

import type {
  CrewDetail,
  CrewRoleOverrideScope,
  ProjectToolbox,
} from "../../../../../../packages/contracts/src/fork/crews/crewRpc";
import type {
  CrewDiagnostic,
  CrewRole,
  CrewSummary,
  ResolvedRoleToolbox,
} from "../../../../../../packages/contracts/src/fork/crews/crewFile";
import type { ResolvedRoleModel } from "../../../../../../packages/contracts/src/fork/crews/crewModel";
import type { ResolvedSettingsScope } from "../../../components/settings/settingsScope";
import type { ProviderInstanceEntry } from "../../../providerInstances";
import type { ModelEsque } from "../../../components/chat/providerIconUtils";

export function crewOverrideScope(projectId: ProjectId | null): CrewRoleOverrideScope {
  return projectId === null ? { scope: "environment" } : { scope: "project", projectId };
}

export function showsRepoToolbox(kind: ResolvedSettingsScope["kind"]) {
  return kind === "project" || kind === "checkout";
}

export function crewPath(directory: string, relative: string) {
  const separator = directory.includes("\\") ? "\\" : "/";
  return `${directory.replace(/[/\\]+$/u, "")}${separator}${relative.replaceAll("/", separator)}`;
}

/** Server paths put keybindings in <T3 home>/{userdata,dev}; never assume a local home. */
export function crewsDirectory(keybindingsConfigPath: string) {
  const state = getBrowseParentPath(keybindingsConfigPath);
  const home = state && getBrowseParentPath(state);
  return home ? crewPath(home, "crews") : null;
}

export function crewHomeLine(summary: CrewSummary, definition: CrewDetail["definition"]) {
  const home = summary.home;
  if (!home) return "Runs in your thread: not resolved";
  const name = summary.roles.find((role) => role.id === home.roleId)?.name ?? home.roleId;
  const mode = home.mode === "lead" ? "lead" : "first step";
  const source = home.source === "auto" ? ", auto-detected" : "";
  const canEdit = definition?.home?.mode === "lead" && definition.home.canEdit;
  const access = home.mode === "lead" ? (canEdit ? " · can edit" : " · read-only") : "";
  return `Runs in your thread: ${name} (${mode}${source})${access}`;
}

export function orderedCrewRoles(summary: CrewSummary) {
  const lead = summary.home?.mode === "lead" ? summary.home.roleId : null;
  return summary.roles.toSorted((a, b) => Number(b.id === lead) - Number(a.id === lead));
}

export function crewModelSource(source: ResolvedRoleModel["source"], project: boolean) {
  switch (source) {
    case "crew-hint":
      return "Crew default";
    case "environment":
      return project ? "Inherited from All projects" : "All projects";
    case "project":
      return "This project";
    case "composer":
      return "Composer model";
    case "run":
      return "This run";
  }
}

export function crewModelsMixed(models: readonly ResolvedRoleModel[]) {
  const first = models[0];
  return (
    first !== undefined &&
    models.some(
      (model) => model.source !== first.source || !Equal.equals(model.selection, first.selection),
    )
  );
}

export function crewModelDisabledReason(
  selection: Pick<ModelSelection, "instanceId" | "model">,
  sourceEntries: readonly ProviderInstanceEntry[],
  targets: readonly {
    label: string;
    entries: readonly ProviderInstanceEntry[];
    options: ReadonlyMap<ProviderInstanceId, readonly ModelEsque[]>;
  }[],
) {
  const source = sourceEntries.find((entry) => entry.instanceId === selection.instanceId);
  for (const target of targets) {
    const entry = target.entries.find((entry) => entry.instanceId === selection.instanceId);
    if (
      !entry?.enabled ||
      !entry.isAvailable ||
      entry.driverKind !== source?.driverKind ||
      !target.options
        .get(selection.instanceId)
        ?.some((model) => model.slug === selection.model && !model.isUnavailable)
    ) {
      return `This model is unavailable on ${target.label}. Select that machine to choose its model separately.`;
    }
  }
  return null;
}

export function diagnosticLocation(diagnostic: CrewDiagnostic) {
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}`;
}

const TOOLBOX_SOURCES = { role: "role", crew: "crew", home: "T3 home", repo: "repo" } as const;

export function crewToolboxChips(toolbox: ResolvedRoleToolbox, project: boolean) {
  const chips = toolbox.items
    .filter((item) => project || item.source !== "repo")
    .map((item) => {
      const grants = item.grantedBy.map((grant) => {
        const selector =
          grant.path[0] === "tags"
            ? grant.path.slice(0, 2)
            : grant.path[0] === "crews"
              ? grant.path.slice(0, 3)
              : grant.path;
        return `${grant.file}${selector.length ? ` · ${selector.join(".")}` : ""}`;
      });
      // Phase 3 carries collision paths in diagnostics, not as additional item fields.
      const collisions = toolbox.diagnostics.filter(
        (diagnostic) =>
          diagnostic.message.startsWith(`${item.kind} "${item.name}" collides `) ||
          (item.kind === "skill" && diagnostic.message.startsWith(`Role skill "${item.name}" at `)),
      );
      const source = TOOLBOX_SOURCES[item.source];
      return {
        key: `${item.kind}:${item.name}`,
        kind: item.kind,
        label: `${item.name} · ${source}`,
        warning: collisions.length > 0,
        tooltip: [source, item.path, ...grants, ...collisions.map((entry) => entry.message)].join(
          "\n",
        ),
      };
    });
  if (project)
    for (const diagnostic of toolbox.diagnostics) {
      const missing = /^Unresolved (skill|mcp|tool) "([^"]+)";/u.exec(diagnostic.message);
      const kind = missing?.[1];
      if (!missing || (kind !== "skill" && kind !== "mcp" && kind !== "tool")) continue;
      chips.push({
        key: `${missing[1]}:${missing[2]}`,
        kind,
        label: `${missing[2]} · not defined in this project`,
        warning: true,
        tooltip: `${diagnostic.message}\n${diagnosticLocation(diagnostic)} · ${diagnostic.path.join(".")}`,
      });
    }
  return chips;
}

export function toolboxGrantCount(grants: ProjectToolbox["grants"]) {
  if (!grants) return 0;
  return (
    Object.keys(grants.tags ?? {}).length +
    Object.values(grants.crews ?? {}).reduce(
      (count, roles) => count + Object.keys(roles ?? {}).length,
      0,
    )
  );
}

/** Same inline/file distinction as the authoring validator. */
export function roleInstructions(roleId: string, role: CrewRole) {
  const text = role.instructions;
  if (!text) return { paths: [`roles/${roleId}/role.md`, `roles/${roleId}.md`], text: null };
  const reference =
    text.startsWith("file:") ||
    (!text.includes("\n") &&
      !text.includes("{{") &&
      (/^(?:[./\\]|[A-Za-z]:)/u.test(text) ||
        /\.(?:md|mdx|markdown|txt)$/iu.test(text) ||
        /^\S+[/\\]\S+$/u.test(text)));
  return reference
    ? { paths: [text.startsWith("file:") ? text.slice(5).trim() : text], text: null }
    : { paths: [], text };
}

/** Invalid crews remain visible, but their instruction links still stay inside the crew. */
export function safeInstructionPath(path: string | undefined) {
  if (!path || /^(?:[/\\]|[A-Za-z]:)/u.test(path)) return null;
  const parts: string[] = [];
  for (const part of path.split(/[/\\]/u)) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      if (!parts.pop()) return null;
    } else parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

export function instructionMarkdown(text: string) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "");
}

export const CREWS_TOOLBOX_EXAMPLE = `# Repo grants add to every crew's own tools.
version: 1
# On a name clash, T3 home wins unless Settings selects override.
# tags:
#   worker:
#     skills: [storybook]
# crews:
#   feature-trio:
#     implementer:
#       tools: [test]
`;
