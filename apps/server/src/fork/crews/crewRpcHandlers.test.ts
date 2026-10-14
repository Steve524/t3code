import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ProjectId,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcTest from "effect/rpc/RpcTest";

import { FORK_CREWS_WS_METHODS } from "../../../../../packages/contracts/src/fork/crews/crewRpc.ts";
import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";
import { rpcInstrumentationLayer } from "../../observability/RpcInstrumentation.ts";
import * as CrewCatalog from "./CrewCatalog.ts";
import * as CrewRunService from "./CrewRunService.ts";
import * as CrewRpc from "./crewRpcHandlers.ts";

const upstream = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (
      tag,
    ): tag is Exclude<RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"], typeof WS_METHODS.serverProbe> =>
      tag !== WS_METHODS.serverProbe,
  ),
);

describe("separate crew handler layer", () => {
  it("rejoins the complete contract without duplicate handlers", () => {
    const ordinary = WsRpcGroup.omit(...CrewRpc.methods);
    expect([...ordinary.requests.keys()].some((tag) => tag.startsWith("forkCrews."))).toBe(false);
    expect(new Set(ordinary.merge(CrewRpc.group).requests.keys())).toEqual(
      new Set(WsRpcGroup.requests.keys()),
    );
  });

  it.effect.each([false, true])("preserves reads, streams and write authorization: %s", (operate) =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const client = yield* RpcTest.makeClient(upstream.merge(CrewRpc.group)).pipe(
        Effect.provide(
          Layer.mergeAll(
            upstream.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
            CrewRpc.layer.pipe(
              Layer.provide(
                Layer.mock(CrewCatalog.CrewCatalog)({
                  list: () => Effect.succeed([]),
                  subscribe: () => Stream.make([]),
                }),
              ),
              Layer.provide(
                Layer.mock(CrewRunService.CrewRunService)({
                  start: () =>
                    Effect.sync(() => {
                      writes.push("start");
                      return { runId: "run", homeThreadId: ThreadId.make("home") };
                    }),
                  pause: () =>
                    Effect.sync(() => {
                      writes.push("pause");
                    }),
                  subscribeByThread: () => Stream.make(null),
                }),
              ),
            ),
            RpcAuthorization.layer(
              operate
                ? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]
                : [AuthOrchestrationReadScope],
            ),
            rpcInstrumentationLayer,
          ),
        ),
      );
      expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
      expect(yield* client[FORK_CREWS_WS_METHODS.list]({})).toEqual([]);
      expect(yield* Stream.runCollect(client[FORK_CREWS_WS_METHODS.subscribe]({}))).toEqual([[]]);
      expect(
        yield* Stream.runCollect(
          client[FORK_CREWS_WS_METHODS.runsSubscribe]({ threadId: ThreadId.make("ordinary") }),
        ),
      ).toEqual([null]);
      const start = client[FORK_CREWS_WS_METHODS.runsStart]({
        projectId: ProjectId.make("project"),
        crewId: "trio",
        inputs: { brief: "Implement it" },
        attachments: [],
        workspace: { mode: "current-checkout" },
        runtimeMode: "full-access",
        clientRequestId: "draft",
      });
      const pause = client[FORK_CREWS_WS_METHODS.runsControl]({
        runId: "run",
        action: { type: "pause" },
      });
      if (operate) {
        expect(yield* start).toEqual({ runId: "run", homeThreadId: "home" });
        yield* pause;
        expect(writes).toEqual(["start", "pause"]);
      } else {
        expect(yield* start.pipe(Effect.flip)).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
        });
        expect(yield* pause.pipe(Effect.flip)).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
        });
        expect(writes).toEqual([]);
      }
    }).pipe(Effect.scoped),
  );
});
