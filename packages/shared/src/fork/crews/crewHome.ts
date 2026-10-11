import type {
  CrewDiagnostic,
  CrewFile,
  CrewSummary,
} from "../../../../contracts/src/fork/crews/crewFile.ts";
import { crewDiagnostic, type CrewSource } from "./crewDiagnostics.ts";

export function detectCrewHome(crew: CrewFile, source: CrewSource = { file: "crew.yaml" }) {
  const diagnostic = crewDiagnostic(source);
  const diagnostics: CrewDiagnostic[] = [];
  let home: CrewSummary["home"] | null = null;
  const candidates = Object.keys(crew.roles).filter((id) =>
    ["lead", "orchestrator"].includes(id.toLowerCase()),
  );
  if (!crew.home && candidates.length > 1) {
    diagnostics.push(
      diagnostic("error", "Both lead and orchestrator roles are present. Set home explicitly.", [
        "home",
      ]),
    );
    return { home, diagnostics };
  }

  const roleId =
    crew.home?.mode === "lead" ? crew.home.role : !crew.home ? candidates[0] : undefined;
  const mode = roleId === undefined ? "first-step" : "lead";
  const origin = crew.home ? "explicit" : "auto";
  if (roleId !== undefined) {
    if (Object.hasOwn(crew.roles, roleId)) home = { mode, roleId, source: origin };
    else diagnostics.push(diagnostic("error", `Unknown home role "${roleId}".`, ["home", "role"]));
  } else {
    const start = Object.hasOwn(crew.flow.steps, crew.flow.start)
      ? crew.flow.steps[crew.flow.start]
      : undefined;
    if (start?.type === "task") home = { mode, roleId: start.role, source: origin };
    else
      diagnostics.push(
        diagnostic("error", "First-step home requires flow.start to name a task step.", [
          "flow",
          "start",
        ]),
      );
  }
  if (!crew.home)
    diagnostics.push(
      diagnostic(
        "info",
        `Home auto-detected as ${mode}${roleId ? ` with role "${roleId}"` : ""}.`,
        ["home"],
      ),
    );
  return { home, diagnostics };
}
