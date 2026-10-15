import { RegistryContext } from "@effect/atom-react";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type EnvironmentId,
  type ProjectId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";
import { useNavigate } from "@tanstack/react-router";
import { useContext, useEffect, useRef, type RefObject } from "react";

import type { ChatComposerHandle } from "../../../components/chat/ChatComposer";
import { getComposerPromptLengthValidationMessage } from "../../../components/chat/composerSubmission";
import {
  useComposerDraftStore,
  type DraftId,
  type ComposerImageAttachment,
} from "../../../composerDraftStore";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachments,
  startAttachmentUpload,
} from "../../../lib/attachmentUploadQueue";
import {
  buildMessageContext,
  previewAnnotationContextReference,
} from "../../../lib/composerContextRecords";
import { ensureInlineContextReferences } from "../../../lib/composerContextReferences";
import { readProject } from "../../../state/entities";
import { environmentServerConfigsAtom } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { crewCommands, crewRuns, useCrewComposerState } from "./crewComposerState";
import { crewComposerSelectionStore, crewComposerTargetKey } from "./crewComposerSelectionStore";
import { mapCrewSendInput } from "./crewSend.logic";
import { crewInitBlockReason, expandCrewInitCommand, parseCrewInitCommand } from "./crewInit.logic";

type SendContext = ReturnType<ChatComposerHandle["getSendContext"]>;

export function useCrewSendInterceptor({
  environmentId,
  projectId,
  draftId,
  promptRef,
  composerRef,
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
  const activeTarget = useRef(state.target);
  useEffect(() => {
    activeTarget.current = state.target;
    return () => {
      activeTarget.current = null;
    };
  }, [state.target]);
  const registry = useContext(RegistryContext);
  const startRun = useAtomCommand(crewCommands.start, { reportFailure: false });
  const navigate = useNavigate();

  // Ordinary sends must not yield before their existing single-flight guard is set.
  const isSelected = () =>
    state.target !== null &&
    Boolean(
      crewComposerSelectionStore.getState().selections[crewComposerTargetKey(state.target)]?.crewId,
    );

  return {
    isSelected,
    /**
     * Swaps a typed `/crew-init` for its short instruction before an ordinary send. True when it
     * cannot run here: the reason shows on the thread and nothing is sent.
     */
    blocksCommand: (sendContext: SendContext, threadId: ThreadId) => {
      const command = parseCrewInitCommand(promptRef.current);
      if (command === null || isSelected()) return false;
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
    start: async (send: {
      prompt: string;
      sendContext: SendContext;
      runtimeMode: RuntimeMode;
      envMode: "local" | "worktree";
      baseRef: string | null;
      startFromOrigin: boolean;
      threadId: ThreadId;
      directAnnotation?:
        | {
            annotation: SendContext["previewAnnotations"][number];
            image: ComposerImageAttachment | null;
          }
        | undefined;
    }): Promise<boolean> => {
      const target = state.target;
      if (!target) return false;
      const store = crewComposerSelectionStore.getState();
      const selection = store.selections[crewComposerTargetKey(target)];
      if (!selection?.crewId) return false;
      if (selection.sending) return true;
      store.setSending(target, true);
      const draftBefore = useComposerDraftStore.getState().getComposerDraft(target.draftId);
      try {
        if (state.error) throw new Error(state.error);
        if (!state.data?.detail) throw new Error("Waiting for this crew's details.");
        const context = send.sendContext;
        const attachments = [...context.images, ...context.files];
        if (
          send.directAnnotation?.image &&
          !attachments.some((file) => file.id === send.directAnnotation?.image?.id)
        )
          attachments.push(send.directAnnotation.image);
        if (attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS)
          throw new Error(
            `A message can have at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
          );
        const prompt = send.directAnnotation
          ? ensureInlineContextReferences(send.prompt, [
              previewAnnotationContextReference(send.directAnnotation.annotation),
            ])
          : send.prompt;
        if (!prompt.trim() && attachments.length === 0)
          throw new Error("Enter a prompt before starting this crew.");
        const input = mapCrewSendInput({
          target,
          selection,
          detail: state.data.detail,
          prompt,
          attachments: [],
          envMode: send.envMode,
          baseRef: send.baseRef,
          startFromOrigin: send.startFromOrigin,
          runtimeMode: send.runtimeMode,
          modelSelection: context.selectedModelSelection,
        });
        if (attachments.length > 0) {
          if (
            registry.get(environmentServerConfigsAtom).get(target.environmentId)?.environment
              .capabilities.attachmentUploads !== true
          )
            throw new Error(
              "This server must support attachment uploads to start a crew with attachments.",
            );
          for (const image of attachments)
            startAttachmentUpload({
              environmentId: target.environmentId,
              image,
              draftTarget: target.draftId,
            });
          await awaitAttachmentUploads(attachments.map((file) => file.id));
        }
        const uploaded = getUploadedAttachments({
          environmentId: target.environmentId,
          images: attachments,
        });
        if (!uploaded) throw new Error("Retry or remove failed uploads before sending.");
        const annotations = [...context.previewAnnotations];
        if (
          send.directAnnotation &&
          !annotations.some((annotation) => annotation.id === send.directAnnotation?.annotation.id)
        )
          annotations.push(send.directAnnotation.annotation);
        const messageContext = buildMessageContext({
          terminalContexts: context.terminalContexts,
          reviewComments: context.reviewComments,
          threadContexts: context.threadContexts,
          previewAnnotations: annotations,
          attachments: attachments.map((attachment, index) => ({
            attachment,
            attachmentId: uploaded[index]!.id,
          })),
        });
        const brief = messageContext
          ? serializeLegacyContextMessage({ text: prompt, records: messageContext.records })
          : prompt;
        const promptError = getComposerPromptLengthValidationMessage(brief);
        if (promptError) throw new Error(promptError);
        setThreadError(send.threadId, null);
        const result = await startRun({
          environmentId: target.environmentId,
          input: { ...input, attachments: uploaded, inputs: { ...input.inputs, brief } },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        if (!result.value.homeThreadId)
          throw new Error(
            "The run started but its home thread is not ready. Send again to open the same run.",
          );
        registry.refresh(
          crewRuns.list({
            environmentId: target.environmentId,
            input: { projectId: target.projectId },
          }),
        );
        store.sent(target);
        const draftAfter = useComposerDraftStore.getState().getComposerDraft(target.draftId);
        // Upload stamping changes file objects; compare content identities before clearing the draft.
        const unchanged =
          draftAfter?.prompt === draftBefore?.prompt &&
          draftAfter?.images.map((file) => file.id).join() ===
            draftBefore?.images.map((file) => file.id).join() &&
          draftAfter?.files.map((file) => file.id).join() ===
            draftBefore?.files.map((file) => file.id).join() &&
          draftAfter?.terminalContexts === draftBefore?.terminalContexts &&
          draftAfter?.reviewComments === draftBefore?.reviewComments &&
          draftAfter?.previewAnnotations === draftBefore?.previewAnnotations &&
          draftAfter?.threadContexts === draftBefore?.threadContexts;
        const stillHere =
          activeTarget.current &&
          crewComposerTargetKey(activeTarget.current) === crewComposerTargetKey(target);
        if (unchanged) {
          releaseDraftAttachments(attachments);
          useComposerDraftStore.getState().clearComposerContent(target.draftId);
          if (stillHere) {
            promptRef.current = "";
            composerRef.current?.resetCursorState();
          }
        }
        // Promote any edits made during the send into the home thread's composer.
        // A later new draft then receives a fresh idempotency key.
        useComposerDraftStore.getState().markDraftThreadPromoting(target.draftId, {
          environmentId: target.environmentId,
          threadId: result.value.homeThreadId,
        });
        useComposerDraftStore.getState().finalizePromotedDraftThread(target.draftId);
        if (stillHere)
          await navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId: target.environmentId, threadId: result.value.homeThreadId },
          });
      } catch (error) {
        setThreadError(
          send.threadId,
          error instanceof Error ? error.message : "Could not start the crew run.",
        );
      } finally {
        crewComposerSelectionStore.getState().setSending(target, false);
      }
      return true;
    },
  };
}
