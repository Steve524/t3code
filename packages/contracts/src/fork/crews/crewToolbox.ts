import type * as FileSchema from "../../../../shared/src/fork/crews/crewFileSchema.ts";
import type { CrewDiagnostic, CrewMcpFile, CrewToolsFile } from "./crewFile.ts";

export type CrewsToolboxFile = typeof FileSchema.CrewsToolboxFile.Type;
export type CrewToolboxGrant = typeof FileSchema.CrewToolboxGrant.Type;
export type ToolboxMode = "extend" | "override";

export interface ProjectToolbox {
  readonly mode: ToolboxMode;
  readonly skills: ReadonlyArray<{ readonly name: string; readonly path: string }>;
  readonly mcp: CrewMcpFile;
  readonly tools: CrewToolsFile;
  readonly grants: CrewsToolboxFile | null;
  readonly diagnostics: ReadonlyArray<CrewDiagnostic>;
}
