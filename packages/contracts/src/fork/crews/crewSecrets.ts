import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** What `${secret:NAME}` names in an MCP server's `env`. It is also a store file name. */
export const CrewSecretName = Schema.String.check(Schema.isPattern(/^[\w-]+$/u));

/**
 * Crew secrets by name, in server settings. Values live in the server's secret store as
 * `crew-NAME`; the settings file and clients only see the redaction marker for a saved one.
 */
export const ForkCrewSecretsSetting = Schema.Record(CrewSecretName, Schema.String).pipe(
  Schema.withDecodingDefault(Effect.succeed({})),
);

/** Per entry: a value saves that secret, `null` removes it. Other saved secrets are kept. */
export const ForkCrewSecretsPatch = Schema.optionalKey(
  Schema.Record(CrewSecretName, Schema.NullOr(Schema.String)),
);
