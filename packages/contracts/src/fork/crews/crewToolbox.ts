import * as Schema from "effect/Schema";

import type * as FileSchema from "../../../../shared/src/fork/crews/crewFileSchema.ts";

export type CrewsToolboxFile = typeof FileSchema.CrewsToolboxFile.Type;
export type CrewToolboxGrant = typeof FileSchema.CrewToolboxGrant.Type;

export const ToolboxMode = Schema.Literals(["extend", "override"]);
export type ToolboxMode = typeof ToolboxMode.Type;
