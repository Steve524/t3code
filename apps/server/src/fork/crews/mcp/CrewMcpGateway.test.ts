import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import type { CrewMcpCallResult } from "../../../../../../packages/contracts/src/fork/crews/crewRun.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as CrewMcpGateway from "./CrewMcpGateway.ts";

const echo = `${import.meta.dirname}/../__fixtures__/mcp-echo/server.mjs`;
const SECRET = "s3cret-value";

const target = (name: string, env: Record<string, string> = {}) => ({
  runId: "crew-run:gateway",
  cwd: import.meta.dirname,
  server: { name, source: "home" as const, command: process.execPath, args: [echo, name], env },
});

const textOf = (result: CrewMcpCallResult) => {
  const [first] = result.content;
  return typeof first === "object" && first !== null && "text" in first ? String(first.text) : "";
};

const layer = CrewMcpGateway.layer.pipe(
  Layer.provide(
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: (name) =>
        Effect.succeed(
          name === CrewMcpGateway.crewSecretName("FIGMA_TOKEN")
            ? Option.some(new TextEncoder().encode(SECRET))
            : Option.none(),
        ),
    }),
  ),
  Layer.provide(NodeServices.layer),
);

describe("CrewMcpGateway", () => {
  it.live("lists and calls a server's tools, with its secrets in the environment only", () =>
    Effect.gen(function* () {
      const gateway = yield* CrewMcpGateway.CrewMcpGateway;
      const figma = target("figma", { FIGMA_AUTH: "Bearer ${secret:FIGMA_TOKEN}", PLAIN: "x" });
      const listed = yield* gateway.listTools(figma);
      expect(listed).toMatchObject({ server: "figma" });
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "echo",
        "env",
        "argv",
        "pid",
        "crash",
      ]);
      expect(textOf(yield* gateway.callTool(figma, "echo", { text: "hi" }))).toBe("figma: hi");
      expect(textOf(yield* gateway.callTool(figma, "env", { name: "FIGMA_AUTH" }))).toBe(
        `Bearer ${SECRET}`,
      );
      expect(textOf(yield* gateway.callTool(figma, "env", { name: "PLAIN" }))).toBe("x");
      expect(textOf(yield* gateway.callTool(figma, "argv", {}))).not.toContain(SECRET);

      // One process per run and server name.
      const pid = textOf(yield* gateway.callTool(figma, "pid", {}));
      expect(textOf(yield* gateway.callTool(figma, "pid", {}))).toBe(pid);
      const otherRun = { ...figma, runId: "crew-run:other" };
      expect(textOf(yield* gateway.callTool(otherRun, "pid", {}))).not.toBe(pid);
    }).pipe(Effect.provide(layer)),
  );

  it.live("names a secret that is not set", () =>
    Effect.gen(function* () {
      const gateway = yield* CrewMcpGateway.CrewMcpGateway;
      const failure = yield* gateway
        .listTools(target("vault", { TOKEN: "${secret:MISSING}" }))
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ code: "unavailable" });
      expect(failure.message).toContain("needs the secret MISSING");
    }).pipe(Effect.provide(layer)),
  );

  it.live("fails the call a server dies in, and starts it again for the next", () =>
    Effect.gen(function* () {
      const gateway = yield* CrewMcpGateway.CrewMcpGateway;
      const storybook = target("storybook");
      const failure = yield* gateway.callTool(storybook, "crash", {}).pipe(Effect.flip);
      expect(failure.message).toContain('MCP server "storybook" exited with code 3.');
      expect(failure.message).toContain("crashing on purpose");
      expect(textOf(yield* gateway.callTool(storybook, "echo", { text: "again" }))).toBe(
        "storybook: again",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("stops a server that sat idle and starts it again when it is used", () =>
    Effect.gen(function* () {
      const gateway = yield* CrewMcpGateway.CrewMcpGateway;
      const idle = target("idle");
      const pid = textOf(yield* gateway.callTool(idle, "pid", {}));
      yield* TestClock.adjust(Duration.minutes(11));
      expect(textOf(yield* gateway.callTool(idle, "pid", {}))).not.toBe(pid);
    }).pipe(Effect.provide(layer)),
  );
});
