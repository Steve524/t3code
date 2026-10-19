import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export interface CrewMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

/** `${secret:NAME}` in an env value. The name is also a store file name, so it stays plain. */
const SECRET_REFERENCE = /\$\{secret:([\w-]+)\}/gu;

const secretNames = (value: string) =>
  [...value.matchAll(SECRET_REFERENCE)].flatMap((match) => (match[1] ? [match[1]] : []));

/**
 * The server's env with every secret read through `read`, or the name of the first secret
 * that is not set. Values are read when a server starts, never stored with the run.
 */
export const resolveCrewMcpEnv = Effect.fnUntraced(function* <E, R>(
  server: CrewMcpServer,
  read: (name: string) => Effect.Effect<Option.Option<string>, E, R>,
) {
  const env: Array<{ name: string; value: string; secret: boolean }> = [];
  for (const [name, value] of Object.entries(server.env)) {
    const secrets = new Map<string, string>();
    for (const secretName of secretNames(value)) {
      const secret = yield* read(secretName);
      if (Option.isNone(secret)) return { missing: secretName } as const;
      secrets.set(secretName, secret.value);
    }
    env.push({
      name,
      // A function replacement, so `$&` in a secret is not read as a pattern.
      value: value.replace(
        SECRET_REFERENCE,
        (match, secretName: string) => secrets.get(secretName) ?? match,
      ),
      secret: secrets.size > 0,
    });
  }
  return { env } as const;
});
