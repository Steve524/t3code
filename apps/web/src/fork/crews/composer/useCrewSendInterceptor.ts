import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { RefObject } from "react";

import type { ChatComposerHandle } from "../../../components/chat/ChatComposer";
import type { DraftId } from "../../../composerDraftStore";
import { readProject } from "../../../state/entities";
import { useCrewComposerState } from "./crewComposerState";
import { crewComposerSelectionStore, crewComposerTargetKey } from "./crewComposerSelectionStore";
import { CREW_START_DISABLED_REASON } from "./crewSend.logic";
import { crewInitBlockReason, expandCrewInitCommand, parseCrewInitCommand } from "./crewInit.logic";

type SendContext = ReturnType<ChatComposerHandle["getSendContext"]>;

export function useCrewSendInterceptor({
  environmentId,
  projectId,
  draftId,
  promptRef,
  setThreadError,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  draftId: DraftId | null;
  promptRef: RefObject<string>;
  composerRef: RefObject<ChatComposerHandle | null>;
  setThreadError: (threadId: ThreadId, message: string | null) => void;
}) {
  const state = useCrewComposerState(environmentId, projectId, draftId);
  return {
    blocksCommand: (sendContext: SendContext, threadId: ThreadId) => {
      const selection = state.target
        ? crewComposerSelectionStore.getState().selections[crewComposerTargetKey(state.target)]
        : null;
      if (selection?.crewId) {
        setThreadError(threadId, CREW_START_DISABLED_REASON);
        return true;
      }
      const command = parseCrewInitCommand(promptRef.current);
      if (command === null) return false;
      const project = projectId ? readProject(scopeProjectRef(environmentId, projectId)) : null;
      const reason = crewInitBlockReason({
        driver: sendContext.selectedProvider,
        hasProject: project !== null && project.isScratch !== true,
      });
      if (reason !== null) {
        setThreadError(threadId, reason);
        return true;
      }
      promptRef.current = expandCrewInitCommand(command);
      return false;
    },
  };
}
