/**
 * What `/crew-init` needs to know about a crew in one project: every skill, MCP server and tool
 * name it uses, and which of them nothing resolves yet. Pure; the catalog supplies the inputs.
 *
 * @module crewNeeds
 */
import type {
  CrewInitCrew,
  CrewToolboxNames,
} from "../../../../../../packages/contracts/src/fork/crews/crewInit.ts";
import type {
  CrewMcpFile,
  ResolvedRoleToolbox,
} from "../../../../../../packages/contracts/src/fork/crews/crewFile.ts";
import type { CrewDetail } from "../../../../../../packages/contracts/src/fork/crews/crewRpc.ts";

const KINDS = [
  ["skills", "skill"],
  ["mcp", "mcp"],
  ["tools", "tool"],
] as const;

const names = (lists: ReadonlyArray<ReadonlyArray<string> | undefined>) => [
  ...new Set(lists.flatMap((list) => list ?? [])),
];

const byKind = (
  pick: (kind: (typeof KINDS)[number]) => ReadonlyArray<string>,
): CrewToolboxNames => ({
  skills: pick(KINDS[0]),
  mcp: pick(KINDS[1]),
  tools: pick(KINDS[2]),
});

/**
 * The crew's references and what stays unresolved. A role's name resolves when its toolbox has
 * it; a tool a `script` step names resolves when the project defines it.
 */
export function describeCrewNeeds(
  detail: Pick<CrewDetail, "definition"> & {
    readonly roles: ReadonlyArray<{ readonly id: string; readonly toolbox: ResolvedRoleToolbox }>;
  },
  projectTools: ReadonlySet<string>,
): Omit<CrewInitCrew, "summary" | "diagnostics"> {
  const crew = detail.definition;
  if (crew === null) {
    const none = byKind(() => []);
    return { roles: [], steps: [], references: none, unresolved: none };
  }
  const roles = Object.entries(crew.roles).map(([id, role]) => {
    const toolbox = detail.roles.find((resolved) => resolved.id === id)?.toolbox.items ?? [];
    const references = byKind(([key]) => names([crew[key], role[key]]));
    const unresolved = byKind(([key, kind]) =>
      references[key].filter(
        (name) => !toolbox.some((item) => item.kind === kind && item.name === name),
      ),
    );
    return { id, references, toolbox, unresolved };
  });
  const steps = Object.entries(crew.flow.steps).map(([id, step]) => ({
    id,
    type: step.type,
    ...("role" in step ? { role: step.role } : {}),
    ...("task" in step ? { task: step.task } : {}),
    ...("tool" in step ? { tool: step.tool } : {}),
  }));
  const scriptTools = names([
    steps.flatMap((step) => (step.tool === undefined ? [] : [step.tool])),
  ]);
  return {
    roles: roles.map(({ id, references, toolbox }) => ({ id, references, toolbox })),
    steps,
    references: byKind(([key]) =>
      names([...roles.map((role) => role.references[key]), key === "tools" ? scriptTools : []]),
    ),
    unresolved: byKind(([key]) =>
      names([
        ...roles.map((role) => role.unresolved[key]),
        key === "tools" ? scriptTools.filter((tool) => !projectTools.has(tool)) : [],
      ]),
    ),
  };
}

/** `servers` with every env value either a `${secret:NAME}` reference or `<redacted>`. */
export function redactMcpEnv(file: CrewMcpFile): CrewMcpFile {
  return {
    servers: Object.fromEntries(
      Object.entries(file.servers).map(([name, server]) => [
        name,
        server.env === undefined
          ? server
          : {
              ...server,
              env: Object.fromEntries(
                Object.entries(server.env).map(([key, value]) => [
                  key,
                  /^\$\{secret:[\w-]+\}$/u.test(value) ? value : "<redacted>",
                ]),
              ),
            },
      ]),
    ),
  };
}
