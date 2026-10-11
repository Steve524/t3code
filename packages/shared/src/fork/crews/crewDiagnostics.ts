import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { isNode, LineCounter, parseDocument } from "yaml";

import type { CrewDiagnostic } from "../../../../contracts/src/fork/crews/crewFile.ts";

export interface CrewSource {
  readonly file: string;
  readonly text?: string;
}

export function crewDiagnostic(source: CrewSource) {
  const lines = new LineCounter();
  const document =
    source.text === undefined ? undefined : parseDocument(source.text, { lineCounter: lines });
  return (
    severity: CrewDiagnostic["severity"],
    message: string,
    path: CrewDiagnostic["path"] = [],
  ): CrewDiagnostic => {
    if (document)
      for (let length = path.length; length >= 0; length--) {
        const node = document.getIn(path.slice(0, length), true);
        if (isNode(node) && node.range) {
          const { line, col } = lines.linePos(node.range[0]);
          return { severity, message, file: source.file, line, column: col, path };
        }
      }
    return { severity, message, file: source.file, line: 1, column: 1, path };
  };
}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

export function decodeCrewValue<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
  diagnostic: ReturnType<typeof crewDiagnostic>,
) {
  const result = Schema.decodeUnknownResult(schema, { errors: "all", onExcessProperty: "error" })(
    input,
  );
  if (Result.isSuccess(result)) return { value: result.success, diagnostics: [] };
  const diagnostics = formatIssues(result.failure.issue).issues.map((issue) => {
    const path = (issue.path ?? []).map((segment) => {
      const key = typeof segment === "object" ? segment.key : segment;
      return typeof key === "number" ? key : String(key);
    });
    return diagnostic("error", issue.message, path);
  });
  return { value: null, diagnostics };
}
