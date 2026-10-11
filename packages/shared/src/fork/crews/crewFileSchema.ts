import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PositiveInt } from "../../../../contracts/src/baseSchemas.ts";
import { ProviderOptionSelections } from "../../../../contracts/src/model.ts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
} from "../../../../contracts/src/providerInstance.ts";

export const CrewSlug = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]*$/u),
  Schema.isMaxLength(64),
);
const Text = Schema.String.check(Schema.isMinLength(1));
const Names = Schema.Array(Text);
const Slugs = Schema.Array(CrewSlug);
const PositiveNumber = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(1));

export const CrewRuntimeMode = Schema.Literals([
  "inherit",
  "approval-required",
  "auto-accept-edits",
  "full-access",
]);
export const CrewInteractionMode = Schema.Literals(["inherit", "plan", "default"]);
const Isolation = Schema.Literals(["shared", "worktree", "read-only"]);
const OnNoReport = Schema.Literals(["retry-then-ask", "ask", "done"]);

export const CrewModelHint = Schema.Struct({
  driver: ProviderDriverKind,
  model: Text,
  instance: Schema.optionalKey(ProviderInstanceId),
  options: Schema.optionalKey(ProviderOptionSelections),
});

export const CrewToolboxGrant = Schema.Struct({
  skills: Schema.optionalKey(Names),
  mcp: Schema.optionalKey(Names),
  tools: Schema.optionalKey(Names),
});

export const CrewRole = Schema.Struct({
  name: Text,
  description: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(Slugs),
  instructions: Schema.optionalKey(Text),
  persona: Schema.optionalKey(
    Schema.Struct({
      identity: Schema.optionalKey(Schema.String),
      communicationStyle: Schema.optionalKey(Schema.String),
      principles: Schema.optionalKey(Names),
      facts: Schema.optionalKey(Names),
    }),
  ),
  model: Schema.optionalKey(CrewModelHint),
  pool: Schema.optionalKey(Schema.Array(ProviderInstanceId)),
  runtimeMode: Schema.optionalKey(CrewRuntimeMode),
  interactionMode: Schema.optionalKey(CrewInteractionMode),
  ...CrewToolboxGrant.fields,
  owns: Schema.optionalKey(Names),
  maxConcurrent: Schema.optionalKey(PositiveInt),
});

// Provider-specific frontmatter tools are accepted but never become crew grants.
export const CrewRoleFrontmatter = Schema.Struct({
  name: Schema.optionalKey(Text),
  description: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.Union([Text, CrewModelHint])),
  tools: Schema.optionalKey(Schema.Union([Schema.String, Names])),
});

export const CrewRoute = Schema.Union([
  CrewSlug,
  Schema.Struct({
    to: CrewSlug,
    max: PositiveInt,
    else: CrewSlug,
    resetOn: Schema.optionalKey(Slugs),
    label: Schema.optionalKey(Text),
  }),
]);
const Outcomes = Schema.Record(CrewSlug, CrewRoute);
const StepFields = {
  next: Schema.optionalKey(CrewRoute),
  outcomes: Schema.optionalKey(Outcomes),
  column: Schema.optionalKey(CrewSlug),
  timeoutMinutes: Schema.optionalKey(PositiveNumber),
  runtimeMode: Schema.optionalKey(CrewRuntimeMode),
  interactionMode: Schema.optionalKey(CrewInteractionMode),
  isolation: Schema.optionalKey(Isolation),
  maxParallel: Schema.optionalKey(PositiveInt),
  autoCommit: Schema.optionalKey(Schema.Boolean),
  onNoReport: Schema.optionalKey(OnNoReport),
};
const TaskFields = {
  role: CrewSlug,
  task: Text,
  produces: Schema.optionalKey(Slugs),
  consumes: Schema.optionalKey(Slugs),
  continue: Schema.optionalKey(Schema.Literals(["fresh", "same-thread"])),
  owns: Schema.optionalKey(Schema.Union([Text, Names])),
};

export const CrewStep = Schema.Union([
  Schema.Struct({
    ...StepFields,
    type: Schema.Literal("task").pipe(Schema.withDecodingDefaultKey(Effect.succeed("task"))),
    ...TaskFields,
  }),
  Schema.Struct({
    ...StepFields,
    type: Schema.Literal("parallel"),
    branches: Slugs.check(Schema.isMinLength(1)),
    join: Schema.optionalKey(Schema.Literals(["all", "any"])),
    owns: Schema.optionalKey(Names),
  }),
  Schema.Struct({
    ...StepFields,
    type: Schema.Literal("fanout"),
    ...TaskFields,
    over: Text,
    join: Schema.optionalKey(Schema.Literals(["all", "any"])),
  }),
  Schema.Struct({
    ...StepFields,
    type: Schema.Literal("merge"),
    onConflict: Schema.optionalKey(
      Schema.Union([Schema.Literal("gate"), Schema.Struct({ role: CrewSlug })]),
    ),
    checkOwnership: Schema.optionalKey(Schema.Literals(["warn", "block"])),
  }),
  Schema.Struct({ ...StepFields, type: Schema.Literal("script"), run: Text }),
  Schema.Struct({ ...StepFields, type: Schema.Literal("script"), tool: Text }),
  Schema.Struct({
    ...StepFields,
    type: Schema.Literal("gate"),
    prompt: Text,
    outcomes: Outcomes.check(Schema.isMinProperties(1)),
    by: Schema.optionalKey(Schema.Literals(["user", "lead"])),
  }),
  Schema.Struct({
    ...StepFields,
    type: Schema.Literal("end"),
    status: Schema.optionalKey(Schema.Literals(["completed", "failed"])),
  }),
]);

export type CrewArtifactShape =
  | "string"
  | "number"
  | "boolean"
  | "string[]"
  | { readonly type: "list"; readonly item: CrewArtifactShape }
  | { readonly [key: string]: CrewArtifactShape };

export const CrewArtifactShape: Schema.Codec<CrewArtifactShape> = Schema.suspend(() =>
  Schema.Union([
    Schema.Literals(["string", "number", "boolean", "string[]"]),
    Schema.Struct({ type: Schema.Literal("list"), item: CrewArtifactShape }),
    Schema.Record(Text, CrewArtifactShape),
  ]),
).annotate({ identifier: "CrewArtifactShape" });

export const CrewArtifact = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["text", "markdown"]) }),
  Schema.Struct({ type: Schema.Literal("object"), schema: Schema.Record(Text, CrewArtifactShape) }),
  Schema.Struct({ type: Schema.Literal("list"), item: CrewArtifactShape }),
]);

const InputFields = {
  required: Schema.optionalKey(Schema.Boolean),
  description: Schema.optionalKey(Schema.String),
};
export const CrewInput = Schema.Union([
  Schema.Struct({
    ...InputFields,
    type: Schema.Literals(["text", "string"]),
    default: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    ...InputFields,
    type: Schema.Literal("boolean"),
    default: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    ...InputFields,
    type: Schema.Literal("enum"),
    values: Names.check(Schema.isMinLength(1)),
    default: Schema.optionalKey(Text),
  }),
]);

export const CrewHome = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("first-step") }),
  Schema.Struct({
    mode: Schema.Literal("lead"),
    role: CrewSlug,
    canEdit: Schema.optionalKey(Schema.Boolean),
    updates: Schema.optionalKey(Schema.Literals(["milestones", "decisions"])),
    decisionTimeoutMinutes: Schema.optionalKey(PositiveNumber),
  }),
]);

export const CrewFile = Schema.Struct({
  version: Schema.Literal(1),
  id: CrewSlug,
  name: Text,
  description: Schema.optionalKey(Schema.String),
  home: Schema.optionalKey(CrewHome),
  inputs: Schema.optionalKey(Schema.Record(CrewSlug, CrewInput)),
  defaults: Schema.optionalKey(
    Schema.Struct({
      runtimeMode: Schema.optionalKey(CrewRuntimeMode),
      interactionMode: Schema.optionalKey(CrewInteractionMode),
      isolation: Schema.optionalKey(Isolation),
      maxParallel: Schema.optionalKey(PositiveInt),
      autoCommit: Schema.optionalKey(Schema.Boolean),
      onNoReport: Schema.optionalKey(OnNoReport),
    }),
  ),
  limits: Schema.optionalKey(
    Schema.Struct({
      maxCards: Schema.optionalKey(PositiveInt),
      maxHours: Schema.optionalKey(PositiveNumber),
      maxFanoutItems: Schema.optionalKey(PositiveInt),
    }),
  ),
  roles: Schema.Record(CrewSlug, CrewRole).check(Schema.isMinProperties(1)),
  artifacts: Schema.optionalKey(Schema.Record(CrewSlug, CrewArtifact)),
  flow: Schema.Struct({
    start: CrewSlug,
    steps: Schema.Record(CrewSlug, CrewStep).check(Schema.isMinProperties(1)),
  }),
  board: Schema.optionalKey(
    Schema.Struct({
      columns: Schema.Array(Schema.Struct({ id: CrewSlug, label: Text, steps: Slugs })),
    }),
  ),
  ...CrewToolboxGrant.fields,
});

export const CrewMcpFile = Schema.Struct({
  servers: Schema.Record(
    Text,
    Schema.Struct({
      command: Text,
      args: Schema.optionalKey(Schema.Array(Schema.String)),
      env: Schema.optionalKey(Schema.Record(Text, Schema.String)),
    }),
  ),
});

export const CrewToolsFile = Schema.Struct({
  tools: Schema.Record(
    Text,
    Schema.Struct({
      description: Schema.optionalKey(Schema.String),
      run: Text,
      timeoutSeconds: Schema.optionalKey(PositiveNumber),
    }),
  ),
});

const RoleGrants = Schema.StructWithRest(
  Schema.Struct({ "*": Schema.optionalKey(CrewToolboxGrant) }),
  [Schema.Record(CrewSlug, CrewToolboxGrant)],
);
export const CrewsToolboxFile = Schema.Struct({
  version: Schema.Literal(1),
  tags: Schema.optionalKey(Schema.Record(CrewSlug, CrewToolboxGrant)),
  crews: Schema.optionalKey(
    Schema.StructWithRest(
      Schema.Struct({
        "*": Schema.optionalKey(Schema.Struct({ "*": Schema.optionalKey(CrewToolboxGrant) })),
      }),
      [Schema.Record(CrewSlug, RoleGrants)],
    ),
  ),
});

export const CREW_FILE_SCHEMA_URL =
  "https://raw.githubusercontent.com/Steve524/t3code/main/docs/fork/schema/crew.json";
export const CREWS_TOOLBOX_SCHEMA_URL =
  "https://raw.githubusercontent.com/Steve524/t3code/main/docs/fork/schema/crews-toolbox.json";

function buildJsonSchema(schema: Schema.Top, id: string): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" });
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    ...document.schema,
    ...(Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {}),
  };
}

export function buildCrewFileJsonSchema(): Record<string, unknown> {
  return buildJsonSchema(CrewFile, CREW_FILE_SCHEMA_URL);
}

export function buildCrewsToolboxJsonSchema(): Record<string, unknown> {
  return buildJsonSchema(CrewsToolboxFile, CREWS_TOOLBOX_SCHEMA_URL);
}
