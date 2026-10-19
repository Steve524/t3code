import {
  AuthSettingsWriteScope,
  AuthOrchestrationReadScope,
  ProjectId,
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
                  setToolboxMode: () =>
                    Effect.sync(() => {
                      writes.push("setMode");
                    }),
                }),
              ),
            ),
            RpcAuthorization.layer(
              operate
                ? [AuthOrchestrationReadScope, AuthSettingsWriteScope]
                : [AuthOrchestrationReadScope],
            ),
            rpcInstrumentationLayer,
          ),
        ),
      );
      expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
      expect(yield* client[FORK_CREWS_WS_METHODS.list]({})).toEqual([]);
      expect(yield* Stream.runCollect(client[FORK_CREWS_WS_METHODS.subscribe]({}))).toEqual([[]]);
      const write = client[FORK_CREWS_WS_METHODS.toolboxSetMode]({
        projectId: ProjectId.make("project"),
        mode: "override",
      });
      if (operate) {
        yield* write;
        expect(writes).toEqual(["setMode"]);
      } else {
        expect(yield* write.pipe(Effect.flip)).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
        });
        expect(writes).toEqual([]);
      }
    }).pipe(Effect.scoped),
  );
});
