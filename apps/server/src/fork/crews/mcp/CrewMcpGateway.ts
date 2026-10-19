/**
 * CrewMcpGateway - reaches the stdio MCP servers in a run's frozen toolbox on a role's behalf,
 * through `crew_mcp_list_tools` and `crew_mcp_call`. Every provider can use it, and it is the
 * only way to a server a provider cannot start itself.
 *
 * One process per run and server name, started on first use with its `${secret:NAME}` values
 * read then, and stopped once it has been idle for `CrewMcpIdleTimeout`. It speaks
 * newline-delimited JSON-RPC: `initialize`, `tools/list` and `tools/call`.
 *
 * @module CrewMcpGateway
 */
// Requests go out as JSON text; what comes back is decoded by a schema.
// @effect-diagnostics preferSchemaOverJson:off
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  CrewMcpCallResult,
  CrewMcpFailure,
  CrewMcpToolList,
} from "../../../../../../packages/contracts/src/fork/crews/crewMcp.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import { crewSecretName } from "../crewSecretsSettings.ts";
import { resolveCrewMcpEnv, type CrewMcpServer } from "./crewMcpEnv.ts";

/** How long a server may sit unused before its process is stopped. Tests shorten it. */
export const CrewMcpIdleTimeout = Context.Reference<Duration.Duration>(
  "t3/fork/crews/CrewMcpIdleTimeout",
  { defaultValue: () => Duration.minutes(10) },
);

const INITIALIZE_TIMEOUT = Duration.seconds(30);
const CALL_TIMEOUT = Duration.minutes(10);
const MCP_PROTOCOL_VERSION = "2025-06-18";

export { crewSecretName };

/** Reads a crew secret as text. A store that cannot be read counts as the secret not being set. */
export const readCrewSecret =
  (secrets: ServerSecretStore.ServerSecretStore["Service"]) => (name: string) =>
    secrets.get(crewSecretName(name)).pipe(
      Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

/** A server of a run, and the checkout its process starts in. */
export interface CrewMcpTarget {
  readonly runId: string;
  readonly cwd: string;
  readonly server: CrewMcpServer;
}

export class CrewMcpGateway extends Context.Service<
  CrewMcpGateway,
  {
    readonly listTools: (target: CrewMcpTarget) => Effect.Effect<CrewMcpToolList, CrewMcpFailure>;
    readonly callTool: (
      target: CrewMcpTarget,
      tool: string,
      args: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<CrewMcpCallResult, CrewMcpFailure>;
  }
>()("t3/fork/crews/mcp/CrewMcpGateway") {}

const RpcMessage = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
    method: Schema.optionalKey(Schema.String),
    result: Schema.optionalKey(Schema.Unknown),
    error: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) })),
  }),
);
const decodeMessage = Schema.decodeUnknownOption(RpcMessage);
const decodeToolPage = Schema.decodeUnknownEffect(
  Schema.Struct({ tools: CrewMcpToolList.fields.tools }),
);
const decodeCallResult = Schema.decodeUnknownEffect(CrewMcpCallResult);

const unavailable = (message: string) => new CrewMcpFailure({ code: "unavailable", message });
const encoder = new TextEncoder();

type Request = (method: string, params: unknown) => Effect.Effect<unknown, CrewMcpFailure>;

interface Session {
  /** Runs `effect` as one use of the server, which keeps it from going idle meanwhile. */
  readonly use: <A>(
    effect: (request: Request) => Effect.Effect<A, CrewMcpFailure>,
  ) => Effect.Effect<A, CrewMcpFailure>;
}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const readSecret = readCrewSecret(yield* ServerSecretStore.ServerSecretStore);
  const agentScope = yield* AgentScope;
  const hostEnvironment = yield* HostProcess.Environment;
  const idleTimeout = yield* CrewMcpIdleTimeout;
  const layerScope = yield* Effect.scope;
  // Keyed by run and server name: the toolbox mode is per project, so a name means one
  // definition for every role of a run.
  const sessions = new Map<string, Deferred.Deferred<Session, CrewMcpFailure>>();

  const start = Effect.fn("CrewMcpGateway.start")(function* (
    target: CrewMcpTarget,
    forget: () => void,
  ) {
    const { name } = target.server;
    const resolved = yield* resolveCrewMcpEnv(target.server, readSecret);
    if ("missing" in resolved) {
      return yield* unavailable(
        `MCP server "${name}" needs the secret ${resolved.missing}, which is not set in T3 Code.`,
      );
    }
    const env = Object.fromEntries(resolved.env.map((entry) => [entry.name, entry.value]));
    const scope = yield* Scope.fork(layerScope);
    const pending = new Map<number, Deferred.Deferred<unknown, CrewMcpFailure>>();
    let nextId = 1;
    let stopped: string | null = null;
    let inFlight = 0;
    let idle: Fiber.Fiber<void> | undefined;
    let stderrTail = "";

    /** The process is gone: every waiting request fails, and the next use starts a new one. */
    const stop = (reason: string) =>
      Effect.suspend(() => {
        if (stopped !== null) return Effect.void;
        stopped = reason;
        forget();
        for (const deferred of pending.values()) {
          Deferred.doneUnsafe(deferred, Exit.fail(unavailable(reason)));
        }
        pending.clear();
        // Forked: the reader that notices the exit runs in the scope it closes.
        return Effect.asVoid(Effect.forkIn(Scope.close(scope, Exit.void), layerScope));
      });

    return yield* Effect.gen(function* () {
      const command = yield* agentScope.wrap({
        command: target.server.command,
        args: target.server.args,
        name: "crew-mcp",
        env: { ...hostEnvironment, ...env },
      });
      const spawn = yield* resolveSpawnCommand(command.command, command.args, {
        env,
        extendEnv: true,
      });
      const outgoing = yield* Queue.unbounded<Uint8Array>();
      const send = (message: unknown) =>
        Queue.offer(outgoing, encoder.encode(`${JSON.stringify(message)}\n`)).pipe(Effect.asVoid);
      // Secrets reach the process through its environment only, never its arguments.
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawn.command, spawn.args, {
            cwd: target.cwd,
            env,
            extendEnv: true,
            shell: spawn.shell,
            stdin: Stream.fromQueue(outgoing),
            stdout: "pipe",
            stderr: "pipe",
            forceKillAfter: "2 seconds",
          }),
        )
        .pipe(
          Scope.provide(scope),
          Effect.mapError((cause) =>
            unavailable(`MCP server "${name}" could not be started: ${cause.message}`),
          ),
        );
      const stderr = yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((text) =>
          Effect.sync(() => {
            stderrTail = (stderrTail + text).slice(-2048);
          }),
        ),
        Effect.ignore,
        Effect.forkIn(scope),
      );
      const receive = (line: string): Effect.Effect<void> => {
        const message = Option.getOrUndefined(decodeMessage(line));
        if (message === undefined) return Effect.void;
        // A request from the server: answer pings, refuse the rest (sampling, roots).
        if (message.method !== undefined) {
          if (message.id === undefined || message.id === null) return Effect.void;
          return send(
            message.method === "ping"
              ? { jsonrpc: "2.0", id: message.id, result: {} }
              : {
                  jsonrpc: "2.0",
                  id: message.id,
                  error: { code: -32601, message: "Method not found" },
                },
          );
        }
        const deferred = typeof message.id === "number" ? pending.get(message.id) : undefined;
        if (deferred === undefined || typeof message.id !== "number") return Effect.void;
        pending.delete(message.id);
        return Deferred.done(
          deferred,
          message.error === undefined
            ? Exit.succeed(message.result)
            : Exit.fail(
                unavailable(
                  `MCP server "${name}" refused the request: ${message.error.message ?? "no reason given"}`,
                ),
              ),
        ).pipe(Effect.asVoid);
      };
      yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach(receive),
        Effect.ignore,
        // What it printed before it went is part of why.
        Effect.andThen(Fiber.await(stderr)),
        Effect.andThen(Effect.option(child.exitCode)),
        Effect.flatMap((code) =>
          stop(
            `MCP server "${name}" exited${Option.isSome(code) ? ` with code ${code.value}` : ""}.${stderrTail.trim().length === 0 ? "" : ` It printed: ${stderrTail.trim()}`}`,
          ),
        ),
        Effect.forkIn(scope),
      );

      const request = (method: string, params: unknown, timeout = CALL_TIMEOUT) =>
        Effect.suspend(() => {
          if (stopped !== null) return Effect.fail(unavailable(stopped));
          const id = nextId++;
          const deferred = Deferred.makeUnsafe<unknown, CrewMcpFailure>();
          pending.set(id, deferred);
          return send({ jsonrpc: "2.0", id, method, params }).pipe(
            Effect.andThen(Deferred.await(deferred)),
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () =>
                Effect.fail(
                  unavailable(
                    `MCP server "${name}" did not answer ${method} within ${Duration.format(timeout)}.`,
                  ),
                ),
            }),
            Effect.ensuring(Effect.sync(() => pending.delete(id))),
          );
        });

      yield* request(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "t3-code-crew", version: "1.0.0" },
        },
        INITIALIZE_TIMEOUT,
      );
      yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });

      const session: Session = {
        use: (effect) =>
          Effect.suspend(() => {
            inFlight += 1;
            const timer = idle;
            idle = undefined;
            return (timer === undefined ? Effect.void : Fiber.interrupt(timer)).pipe(
              Effect.andThen(effect((method, params) => request(method, params))),
              Effect.ensuring(
                Effect.suspend(() => {
                  inFlight -= 1;
                  if (inFlight > 0 || stopped !== null) return Effect.void;
                  return Effect.sleep(idleTimeout).pipe(
                    Effect.andThen(
                      Effect.suspend(() =>
                        inFlight > 0 ? Effect.void : stop(`MCP server "${name}" was idle.`),
                      ),
                    ),
                    Effect.forkIn(layerScope),
                    Effect.tap((fiber) =>
                      Effect.sync(() => {
                        idle = fiber;
                      }),
                    ),
                    Effect.asVoid,
                  );
                }),
              ),
            );
          }),
      };
      return session;
    }).pipe(Effect.onError(() => stop(`MCP server "${name}" did not start.`)));
  });

  /** The run's running server, started on first use. A start that fails is retried next time. */
  const sessionFor = (target: CrewMcpTarget) =>
    Effect.suspend(() => {
      const key = `${target.runId}\u0000${target.server.name}`;
      const existing = sessions.get(key);
      if (existing !== undefined) return Deferred.await(existing);
      const slot = Deferred.makeUnsafe<Session, CrewMcpFailure>();
      sessions.set(key, slot);
      const forget = () => {
        if (sessions.get(key) === slot) sessions.delete(key);
      };
      // Started apart from the caller, so a caller that gives up leaves no half-made slot.
      return start(target, forget).pipe(
        Effect.onExit((exit) => Deferred.done(slot, exit)),
        Effect.forkIn(layerScope),
        Effect.andThen(Deferred.await(slot)),
      );
    });

  const use = <A>(
    target: CrewMcpTarget,
    effect: (request: Request) => Effect.Effect<A, CrewMcpFailure>,
  ) => Effect.flatMap(sessionFor(target), (session) => session.use(effect));
  const invalid = (target: CrewMcpTarget, method: string) => () =>
    unavailable(
      `MCP server "${target.server.name}" answered ${method} with something MCP does not allow.`,
    );

  return CrewMcpGateway.of({
    // shortcut: reads the first page of `tools/list` only; follow `nextCursor` when a server pages its tools.
    listTools: (target) =>
      use(target, (request) =>
        request("tools/list", {}).pipe(
          Effect.flatMap((page) =>
            decodeToolPage(page).pipe(Effect.mapError(invalid(target, "tools/list"))),
          ),
          Effect.map(({ tools }) => ({ server: target.server.name, tools })),
        ),
      ),
    callTool: (target, tool, args) =>
      use(target, (request) =>
        request("tools/call", { name: tool, arguments: args }).pipe(
          Effect.flatMap((result) =>
            decodeCallResult(result).pipe(Effect.mapError(invalid(target, "tools/call"))),
          ),
        ),
      ),
  });
});

export const layer = Layer.effect(CrewMcpGateway, make);
