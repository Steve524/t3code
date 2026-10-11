import * as Schema from "effect/Schema";

import { CrewFile } from "./crewFileSchema.ts";
import type { CrewValidationContext } from "./validateCrew.ts";

export const worker = { name: "Worker", instructions: "Do the assigned work." };
export const task = { type: "task" as const, role: "worker", task: "Work on {{inputs.brief}}." };
export const end = { type: "end" as const };
export const example = {
  version: 1,
  id: "example",
  name: "Example",
  inputs: { brief: { type: "text" } },
  roles: { worker },
  flow: { start: "work", steps: { work: { ...task, next: "done" }, done: end } },
};
export const decodeCrew = Schema.decodeUnknownSync(CrewFile);
export const validationContext: CrewValidationContext = {
  directoryName: "example",
  crewDirectory: "/crews/example",
  files: {},
};
export const definition = (name: string, path: string, realPath = path) => ({
  name,
  path,
  realPath,
});

export function withSteps(steps: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { ...example, flow: { start: "work", steps }, ...extra };
}
