import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { resolveCrewMcpEnv } from "./crewMcpEnv.ts";

it.effect("resolves multiple references literally and preserves plain environment values", () =>
  Effect.gen(function* () {
    const resolved = yield* resolveCrewMcpEnv(
      {
        name: "example",
        command: "unused",
        args: [],
        env: { AUTH: "${secret:TOKEN}/${secret:TOKEN}", PLAIN: "$PATH" },
      },
      () => Effect.succeedSome("$&-secret"),
    );
    expect(resolved).toEqual({
      env: [
        { name: "AUTH", value: "$&-secret/$&-secret", secret: true },
        { name: "PLAIN", value: "$PATH", secret: false },
      ],
    });
  }),
);

it.effect("returns the missing secret without a partially resolved environment", () =>
  Effect.gen(function* () {
    const resolved = yield* resolveCrewMcpEnv(
      { name: "example", command: "unused", args: [], env: { TOKEN: "${secret:MISSING}" } },
      () => Effect.succeedNone,
    );
    expect(resolved).toEqual({ missing: "MISSING" });
  }),
);
