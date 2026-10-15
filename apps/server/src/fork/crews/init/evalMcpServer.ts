// @effect-diagnostics nodeBuiltinImport:off - a stdio MCP server for skill evals, outside the server runtime.
/**
 * Serves the five `t3_*` tools over stdio as the `t3-code` MCP server, for `/crew-init` skill
 * evals with a provider CLI and no running T3 server:
 *
 *   node apps/server/src/fork/crews/init/evalMcpServer.ts <t3Home> <repoRoot>
 *
 * `<t3Home>` holds `crews/`; `<repoRoot>` is the project the calling thread belongs to. Loading
 * the server code takes several seconds, so give the client time and make it wait before the
 * first turn: for Codex, `-c mcp_servers.t3-code.required=true` and `startup_timeout_sec=60`.
 *
 * @module evalMcpServer
 */
import * as NodeReadline from "node:readline";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { makeStandaloneCrewInitTools, type CrewInitToolName } from "./standaloneTools.ts";

const Request = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
    method: Schema.String,
    params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
const decodeRequest = Schema.decodeUnknownOption(Request);
const encodeLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

class StdinFailed extends Schema.TaggedError<StdinFailed>()("StdinFailed", {
  cause: Schema.Defect(),
}) {}

const [home, repoRoot] = process.argv.slice(2);
const projectId = ProjectId.make("eval-project");
const threadId = ThreadId.make("eval-thread");

const program = Effect.gen(function* () {
  if (home === undefined || repoRoot === undefined) {
    return yield* Effect.die("Usage: evalMcpServer.ts <t3Home> <repoRoot>");
  }
  const tools = yield* makeStandaloneCrewInitTools({
    home,
    projects: { [projectId]: repoRoot },
    threads: new Map([[threadId, projectId]]),
  });
  const send = (message: object) =>
    Effect.sync(() => process.stdout.write(`${encodeLine({ jsonrpc: "2.0", ...message })}\n`));
  const answer = Effect.fn("evalMcpServer.answer")(function* (line: string) {
    const request = decodeRequest(line);
    // Notifications carry no id and get no reply.
    if (request._tag === "None" || request.value.id === undefined) return;
    const { id, method, params } = request.value;
    if (method === "initialize") {
      return yield* send({
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "t3-code", version: "eval" },
        },
      });
    }
    if (method === "ping") return yield* send({ id, result: {} });
    if (method === "tools/list") return yield* send({ id, result: { tools: tools.list } });
    const name = params?.name;
    if (method === "tools/call" && tools.list.some((tool) => tool.name === name)) {
      const { isFailure, result } = yield* tools.call(
        threadId,
        name as CrewInitToolName,
        params?.arguments ?? {},
      );
      return yield* send({
        id,
        result: { content: [{ type: "text", text: encodeLine(result) }], isError: isFailure },
      });
    }
    return yield* send({ id, error: { code: -32601, message: `Unsupported: ${method}` } });
  });
  yield* Stream.fromAsyncIterable(
    NodeReadline.createInterface({ input: process.stdin }),
    (cause) => new StdinFailed({ cause }),
  ).pipe(Stream.runForEach(answer));
});

// Stdout carries only protocol lines, so logs go nowhere.
NodeRuntime.runMain(
  program.pipe(Effect.scoped, Effect.provide([NodeServices.layer, Logger.layer([])])),
);
