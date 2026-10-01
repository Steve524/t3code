import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "../baseSchemas.ts";

// String form preserves Windows file IDs that cannot fit in a JavaScript number.
export const agentSessionFileIdFields = {
  windowsFileId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
};
