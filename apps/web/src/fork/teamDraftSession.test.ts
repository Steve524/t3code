import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";

it("stores and clears the selected Team Workflow with a draft session", () => {
  const store = useComposerDraftStore.getState();
  const draftId = DraftId.make("team-workflow-test-draft");
  store.setProjectDraftThreadId(
    scopeProjectRef(
      EnvironmentId.make("team-workflow-test-environment"),
      ProjectId.make("team-workflow-test-project"),
    ),
    draftId,
    { threadId: ThreadId.make("team-workflow-test-thread"), teamWorkflowId: "full-stack-team" },
  );

  expect(store.getDraftThread(draftId)?.teamWorkflowId).toBe("full-stack-team");
  store.setDraftThreadContext(draftId, { teamWorkflowId: null });
  expect(store.getDraftThread(draftId)?.teamWorkflowId).toBeNull();
});
