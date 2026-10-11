import type { CrewFile } from "../../../../contracts/src/fork/crews/crewFile.ts";
import { crewDiagnostic, decodeCrewValue, type CrewSource } from "./crewDiagnostics.ts";
import { CrewsToolboxFile } from "./crewFileSchema.ts";

export interface CrewsToolboxValidationContext {
  readonly crews: ReadonlyArray<Pick<CrewFile, "id" | "roles">>;
  readonly source?: CrewSource;
  readonly hasProjectCrewsDirectory?: boolean;
}

export function validateCrewsToolbox(input: unknown, context: CrewsToolboxValidationContext) {
  const diagnostic = crewDiagnostic(context.source ?? { file: ".t3/crews.yaml" });
  const decoded = decodeCrewValue(CrewsToolboxFile, input, diagnostic);
  const diagnostics = [...decoded.diagnostics];
  if (context.hasProjectCrewsDirectory)
    diagnostics.push(
      diagnostic(
        "info",
        "Project .t3/crews/ is ignored. Install crews in T3 home and put repo grants in .t3/crews.yaml.",
      ),
    );
  if (decoded.value) {
    const crews = new Map(context.crews.map((crew) => [crew.id, crew]));
    const tags = new Set(
      context.crews.flatMap((crew) => Object.values(crew.roles).flatMap((role) => role.tags ?? [])),
    );
    for (const [crewId, roles] of Object.entries(decoded.value.crews ?? {})) {
      if (crewId === "*") continue;
      const crew = crews.get(crewId);
      if (!crew)
        diagnostics.push(
          diagnostic("warning", `Crew "${crewId}" is not installed.`, ["crews", crewId]),
        );
      else
        for (const roleId of Object.keys(roles)) {
          if (roleId !== "*" && !Object.hasOwn(crew.roles, roleId))
            diagnostics.push(
              diagnostic("warning", `Unknown role "${roleId}" in crew "${crewId}".`, [
                "crews",
                crewId,
                roleId,
              ]),
            );
        }
    }
    for (const tag of Object.keys(decoded.value.tags ?? {}))
      if (!tags.has(tag))
        diagnostics.push(
          diagnostic("info", `No installed role carries tag "${tag}".`, ["tags", tag]),
        );
  }
  return { value: decoded.value, diagnostics };
}
