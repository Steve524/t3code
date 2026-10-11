import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { isNode, LineCounter, parseDocument } from "yaml";

import type { CrewDiagnostic } from "../../../../contracts/src/fork/crews/crewFile.ts";
import { CrewFile, CrewMcpFile, CrewsToolboxFile, CrewToolsFile } from "./crewFileSchema.ts";

export interface CrewYamlResult<T> {
  readonly value: T | null;
  readonly diagnostics: ReadonlyArray<CrewDiagnostic>;
}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

function parseFile<S extends Schema.ConstraintDecoder<unknown>>(
  text: string,
  schema: S,
  file: string,
): CrewYamlResult<S["Type"]> {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter });
  const diagnostics: CrewDiagnostic[] = [...document.errors, ...document.warnings].map((issue) => {
    const { line, col } = lineCounter.linePos(issue.pos[0]);
    return {
      severity: issue.name === "YAMLWarning" ? "warning" : "error",
      message: `Invalid YAML (code=${issue.code}, line=${line}, column=${col}). ${issue.message}`,
      file,
      line,
      column: col,
      path: [],
    };
  });
  if (document.errors.length > 0) return { value: null, diagnostics };

  function position(path: ReadonlyArray<string | number>) {
    // Missing properties have no node; locate their closest containing YAML node.
    for (let length = path.length; length >= 0; length--) {
      const node = document.getIn(path.slice(0, length), true);
      if (isNode(node) && node.range) return lineCounter.linePos(node.range[0]);
    }
    return { line: 1, col: 1 };
  }

  let input: unknown;
  try {
    input = document.toJS();
  } catch (error) {
    const { line, col } = position([]);
    diagnostics.push({
      severity: "error",
      message: error instanceof Error ? error.message : "Invalid YAML.",
      file,
      line,
      column: col,
      path: [],
    });
    return { value: null, diagnostics };
  }

  const decoded = Schema.decodeUnknownResult(schema, { errors: "all", onExcessProperty: "error" })(
    input,
  );
  if (Result.isSuccess(decoded)) return { value: decoded.success, diagnostics };

  for (const issue of formatIssues(decoded.failure.issue).issues) {
    const path = (issue.path ?? []).map((segment) => {
      const key = typeof segment === "object" ? segment.key : segment;
      return typeof key === "number" ? key : String(key);
    });
    const { line, col } = position(path);
    diagnostics.push({ severity: "error", message: issue.message, file, line, column: col, path });
  }
  return { value: null, diagnostics };
}

// `file` labels the diagnostics; loaders pass the path on disk.
export function parseCrewYaml(text: string, file = "crew.yaml") {
  return parseFile(text, CrewFile, file);
}

export function parseCrewsToolboxYaml(text: string, file = ".t3/crews.yaml") {
  return parseFile(text, CrewsToolboxFile, file);
}

export function parseCrewMcpYaml(text: string, file = "mcp.yaml") {
  return parseFile(text, CrewMcpFile, file);
}

export function parseCrewToolsYaml(text: string, file = ".t3/tools.yaml") {
  return parseFile(text, CrewToolsFile, file);
}
