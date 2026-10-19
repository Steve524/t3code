import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { toastManager } from "../../../components/ui/toast";
import { type ComposerThreadTarget, useComposerDraftStore } from "../../../composerDraftStore";
import { useNewThreadHandler } from "../../../hooks/useHandleNewThread";
import { crewInitDraftPrompt } from "./crewInit.logic";

/** Puts `prompt` in a composer, ready to send. Text already typed there is kept: returns false. */
export function placeCrewInitPrompt(target: ComposerThreadTarget, prompt: string): boolean {
  const store = useComposerDraftStore.getState();
  const existing = store.getComposerDraft(target)?.prompt ?? "";
  if (existing.trim() !== "" && existing !== prompt) return false;
  store.setPrompt(target, prompt);
  return true;
}

/** Opens a new thread draft in the project with `/crew-init [crew]` in its composer. */
export function useOpenCrewInitDraft() {
  const openDraft = useNewThreadHandler();
  return async (environmentId: EnvironmentId, projectId: ProjectId, crewId: string | null) => {
    const opened = await openDraft(scopeProjectRef(environmentId, projectId)).catch(() => null);
    if (opened === null) {
      toastManager.add({ type: "error", title: "Could not open a new thread" });
      return;
    }
    const prompt = crewInitDraftPrompt(crewId);
    if (!placeCrewInitPrompt(opened.draftId, prompt)) {
      toastManager.add({
        type: "info",
        title: "This project already has a draft",
        description: `Its text was kept. Send ${prompt} to set up the repo toolbox.`,
      });
    }
  };
}
