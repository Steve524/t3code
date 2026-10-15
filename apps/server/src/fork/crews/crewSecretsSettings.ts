/**
 * Crew secrets in server settings. `mapSettingsSecrets` visits them through
 * `mapForkCrewSecrets`, so upstream's settings pipeline stores each value in the
 * secret store, removes it when its entry goes, and redacts it for clients.
 *
 * Kept free of heavy imports: server settings load it.
 *
 * @module crewSecretsSettings
 */
import type { ServerSettings } from "@t3tools/contracts";

import type { SettingsSecret } from "../../settingsSecrets.ts";

/** The store name of a crew secret, apart from the server's own secrets. */
export const crewSecretName = (name: string) => `crew-${name}`;

/** `forkCrewSecrets` with each entry mapped as a sensitive settings field. */
export const mapForkCrewSecrets = (
  settings: ServerSettings,
  redactedMarker: string,
  map: (secret: SettingsSecret) => Pick<SettingsSecret, "value" | "redacted">,
): Pick<ServerSettings, "forkCrewSecrets"> => ({
  forkCrewSecrets: Object.fromEntries(
    Object.entries(settings.forkCrewSecrets).map(([name, value]) => {
      const result = map({
        secretName: crewSecretName(name),
        kind: "field",
        value,
        redacted: value === redactedMarker,
        sensitive: true,
      });
      return [name, result.redacted ? redactedMarker : result.value];
    }),
  ),
});
