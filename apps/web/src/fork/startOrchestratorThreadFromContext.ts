import {
  resolveThreadActionProjectRef,
  type ChatThreadActionContext,
} from "../lib/chatThreadActions";

export async function startOrchestratorThreadFromContext(
  context: ChatThreadActionContext,
  teamWorkflowId: string,
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) return false;
  await context.handleNewThread(projectRef, { teamWorkflowId });
  return true;
}
