import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import type { ChatThreadActionContext } from "../lib/chatThreadActions";
import { startOrchestratorThreadFromContext } from "./startOrchestratorThreadFromContext";

it("starts a Team Workflow draft in the active project", async () => {
  const environmentId = EnvironmentId.make("environment-1");
  const projectId = ProjectId.make("project-1");
  const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});
  const didStart = await startOrchestratorThreadFromContext(
    {
      activeDraftThread: null,
      activeThread: { environmentId, projectId },
      defaultProjectRef: null,
      handleNewThread,
    },
    "full-stack-team",
  );

  expect(didStart).toBe(true);
  expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(environmentId, projectId), {
    teamWorkflowId: "full-stack-team",
  });
});
