import { WorkflowIcon } from "lucide-react";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../components/CommandPalette.logic";
import type { ChatThreadActionContext } from "../lib/chatThreadActions";
import { startOrchestratorThreadFromContext } from "./startOrchestratorThreadFromContext";

export function teamWorkflowCommandPaletteAction(input: {
  activeProjectTitle: string;
  context: ChatThreadActionContext;
  workflowId: string;
}): CommandPaletteActionItem {
  return {
    kind: "action",
    value: "action:new-orchestrator-thread",
    searchTerms: ["new orchestrator thread", "team", "workflow", "delegate"],
    title: (
      <>
        New orchestrator thread in <span className="font-semibold">{input.activeProjectTitle}</span>
      </>
    ),
    icon: <WorkflowIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "chat.newOrchestrator",
    run: async () => {
      await startOrchestratorThreadFromContext(input.context, input.workflowId);
    },
  };
}
