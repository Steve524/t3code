import type {
  CrewArtifactShape,
  CrewFile,
  CrewStep,
} from "../../../../contracts/src/fork/crews/crewFile.ts";

export function isCrewListShape(
  shape: CrewArtifactShape | undefined,
): shape is { readonly type: "list"; readonly item: CrewArtifactShape } {
  return typeof shape === "object" && shape.type === "list" && "item" in shape;
}

function listItem(shape: CrewArtifactShape | undefined): CrewArtifactShape | undefined {
  if (shape === "string[]") return "string";
  if (isCrewListShape(shape)) return shape.item;
  return undefined;
}

function field(shape: CrewArtifactShape | undefined, path: ReadonlyArray<string>) {
  for (const key of path) {
    const item = listItem(shape);
    if (item !== undefined) shape = /^(0|[1-9]\d*)$/u.test(key) ? item : undefined;
    else
      shape =
        typeof shape === "object" && !isCrewListShape(shape) && Object.hasOwn(shape, key)
          ? shape[key]
          : undefined;
  }
  return shape;
}

export function crewArtifactAt(crew: CrewFile, reference: string) {
  const [root, name, ...path] = reference.split(".");
  if (root !== "artifacts" || !name || !Object.hasOwn(crew.artifacts ?? {}, name)) return undefined;
  const artifact = crew.artifacts?.[name];
  if (!artifact) return undefined;
  const shape =
    artifact.type === "object"
      ? artifact.schema
      : artifact.type === "list"
        ? { type: "list" as const, item: artifact.item }
        : "string";
  return field(shape, path);
}

export function crewFanoutItem(crew: CrewFile, step: CrewStep) {
  return step.type === "fanout" ? listItem(crewArtifactAt(crew, step.over)) : undefined;
}

export function crewTemplateKeyExists(crew: CrewFile, key: string, step?: CrewStep) {
  const [root, name, ...path] = key.split(".");
  switch (root) {
    case "inputs":
      return name !== undefined && path.length === 0 && Object.hasOwn(crew.inputs ?? {}, name);
    case "artifacts":
      return crewArtifactAt(crew, key) !== undefined;
    case "steps":
      return (
        name !== undefined &&
        Object.hasOwn(crew.flow.steps, name) &&
        path.length === 1 &&
        ["summary", "outcome"].includes(path[0]!)
      );
    case "run":
      return name === "branch" && path.length === 0;
    case "item":
      return (
        step?.type === "fanout" &&
        field(crewFanoutItem(crew, step), name === undefined ? [] : [name, ...path]) !== undefined
      );
    default:
      return false;
  }
}

export function invalidCrewTemplateKeys(crew: CrewFile, text: string, step?: CrewStep) {
  return [...text.matchAll(/\{\{([\s\S]*?)\}\}/gu)].flatMap((match) => {
    const key = match[1]!.trim();
    return crewTemplateKeyExists(crew, key, step) ? [] : [{ key, offset: match.index }];
  });
}
