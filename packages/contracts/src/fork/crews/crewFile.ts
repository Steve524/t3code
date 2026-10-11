import type * as FileSchema from "../../../../shared/src/fork/crews/crewFileSchema.ts";

// Type-only imports keep the authoring schemas authoritative without loading YAML in clients.
export type CrewFile = typeof FileSchema.CrewFile.Type;
export type CrewRole = typeof FileSchema.CrewRole.Type;
export type CrewStep = typeof FileSchema.CrewStep.Type;
export type CrewRoute = typeof FileSchema.CrewRoute.Type;
export type CrewModelHint = typeof FileSchema.CrewModelHint.Type;
export type CrewRoleFrontmatter = typeof FileSchema.CrewRoleFrontmatter.Type;
export type CrewMcpFile = typeof FileSchema.CrewMcpFile.Type;
export type CrewToolsFile = typeof FileSchema.CrewToolsFile.Type;
export type CrewArtifact = typeof FileSchema.CrewArtifact.Type;
export type { CrewArtifactShape } from "../../../../shared/src/fork/crews/crewFileSchema.ts";

export interface CrewDiagnostic {
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly path: ReadonlyArray<string | number>;
}

export interface CrewSummary {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly path: string;
  readonly roles: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly tags: ReadonlyArray<string>;
  }>;
  readonly home: {
    readonly mode: "first-step" | "lead";
    readonly roleId: string;
    readonly source: "explicit" | "auto";
  };
  readonly status: "ok" | "warnings" | "invalid";
  readonly diagnosticCounts: {
    readonly errors: number;
    readonly warnings: number;
    readonly info: number;
  };
}

export interface ResolvedRoleToolbox {
  readonly items: ReadonlyArray<{
    readonly kind: "skill" | "mcp" | "tool";
    readonly name: string;
    readonly path: string;
    readonly source: "role" | "crew" | "home" | "repo";
    readonly grantedBy: ReadonlyArray<{
      readonly file: string;
      readonly path: ReadonlyArray<string | number>;
    }>;
  }>;
  readonly diagnostics: ReadonlyArray<CrewDiagnostic>;
}
