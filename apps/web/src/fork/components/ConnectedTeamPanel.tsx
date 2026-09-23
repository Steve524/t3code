import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { newMessageId } from "../../lib/utils";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { toastManager } from "../../components/ui/toast";
import { TeamPanel } from "./TeamPanel";

export function ConnectedTeamPanel({ orchestratorRef }: { orchestratorRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession, { reportFailure: false });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });

  const openWorker = (worker: EnvironmentThreadShell) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(worker.environmentId, worker.id)),
    });
  };
  const stopWorker = async (worker: EnvironmentThreadShell) => {
    const result = await stopThreadSession({
      environmentId: worker.environmentId,
      input: { threadId: worker.id },
    });
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Could not stop worker",
      description: error instanceof Error ? error.message : "An unexpected error occurred.",
    });
  };
  const messageWorker = async (worker: EnvironmentThreadShell, text: string) => {
    const result = await startThreadTurn({
      environmentId: worker.environmentId,
      input: {
        threadId: worker.id,
        message: { messageId: newMessageId(), role: "user", text, attachments: [] },
        runtimeMode: worker.runtimeMode,
        interactionMode: worker.interactionMode,
      },
    });
    if (result._tag !== "Failure") return true;
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not message worker",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    }
    return false;
  };

  return (
    <TeamPanel
      orchestratorRef={orchestratorRef}
      onOpenWorker={openWorker}
      onStopWorker={stopWorker}
      onMessageWorker={messageWorker}
    />
  );
}
