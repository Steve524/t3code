import { describe, expect, it } from "vite-plus/test";

import { AuthSettingsWriteScope } from "../../auth.ts";
import { clientRpcRequiredScopes } from "../../clientRpcPermissions.ts";
import { WsRpcGroup } from "../../rpc.ts";
import {
  FORK_CREWS_GUARDED_RPC_SCOPES,
  FORK_CREWS_READ_RPC_SCOPES,
  FORK_CREWS_RPC_AGGREGATES,
  FORK_CREWS_WS_METHODS,
} from "./crewRpc.ts";

const methods = Object.values(FORK_CREWS_WS_METHODS);

// These guard the upstream wiring: an upstream merge that drops a `FORK:` line fails here.
describe("crews rpc wiring", () => {
  it("serves every crews method from the WebSocket group", () => {
    for (const method of methods) expect(WsRpcGroup.requests.has(method)).toBe(true);
  });

  it("gives every method exactly one scope and a span label", () => {
    const scoped = [
      ...Object.keys(FORK_CREWS_GUARDED_RPC_SCOPES),
      ...Object.keys(FORK_CREWS_READ_RPC_SCOPES),
    ];
    expect(scoped.toSorted()).toEqual(methods.toSorted());
    expect(Object.keys(FORK_CREWS_RPC_AGGREGATES).toSorted()).toEqual(methods.toSorted());
  });

  it.each([
    FORK_CREWS_WS_METHODS.toolboxSetMode,
    FORK_CREWS_WS_METHODS.roleOverridesSet,
    FORK_CREWS_WS_METHODS.roleOverridesReset,
  ])("has the client check settings:write before sending %s", (method) => {
    expect(clientRpcRequiredScopes(method, undefined)).toEqual([AuthSettingsWriteScope]);
  });

  it("removes the old run RPCs", () => {
    expect([...WsRpcGroup.requests.keys()].some((tag) => tag.startsWith("forkCrews.runs."))).toBe(
      false,
    );
  });

  it.each(Object.keys(FORK_CREWS_READ_RPC_SCOPES))("leaves the read %s unguarded", (method) => {
    expect(clientRpcRequiredScopes(method, undefined)).toEqual([]);
  });
});
