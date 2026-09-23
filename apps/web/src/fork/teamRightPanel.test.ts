import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { selectActiveRightPanelSurface, useRightPanelStore } from "../rightPanelStore";

it("opens a singleton Team Workflow panel", () => {
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
  useRightPanelStore.getState().open(ref, "team");
  expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref)).toEqual({
    id: "team",
    kind: "team",
  });
});
