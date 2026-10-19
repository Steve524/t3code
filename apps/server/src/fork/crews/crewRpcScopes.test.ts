import { AuthOrchestrationReadScope, AuthSettingsWriteScope } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  FORK_CREWS_GUARDED_RPC_SCOPES,
  FORK_CREWS_READ_RPC_SCOPES,
} from "../../../../../packages/contracts/src/fork/crews/crewRpc.ts";
import { requiredScopeForRpcMethod } from "../../auth/RpcAuthorization.ts";

// The server refuses an RPC it has no scope for, so this also guards the upstream wiring.
describe("crews rpc authorization", () => {
  it.each(Object.keys(FORK_CREWS_READ_RPC_SCOPES))("lets a read-only session call %s", (method) => {
    expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
  });

  it.each(Object.entries(FORK_CREWS_GUARDED_RPC_SCOPES))(
    "requires its write scope for %s",
    (method, scope) => {
      expect(requiredScopeForRpcMethod(method)).toBe(scope);
    },
  );

  it("reserves crew mutations for settings writes", () => {
    expect(new Set(Object.values(FORK_CREWS_GUARDED_RPC_SCOPES))).toEqual(
      new Set([AuthSettingsWriteScope]),
    );
  });
});
