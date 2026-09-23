import type { TeamWorkflow } from "@t3tools/contracts";
import { WorkflowIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../../components/ui/tooltip";
import { Select, SelectItem, SelectPopup, SelectValue } from "../../../components/ui/select";
import {
  ComposerControl,
  ComposerControlIcon,
  ComposerSelectControl,
  type ComposerControlSize,
} from "../../../components/chat/ComposerControl";
import { composerFloatingLayerProps } from "../../../components/chat/composerEventScope";
import { useComposerMenuState } from "../../../components/chat/useComposerMenuState";

const NO_WORKFLOW = "none";

export function WorkflowPicker(props: {
  workflows: readonly TeamWorkflow[];
  workflow: TeamWorkflow | null;
  readOnly: boolean;
  size?: ComposerControlSize;
  hidden?: boolean;
  onWorkflowChange: (workflowId: string | null) => void;
  onOpenTeamPanel: () => void;
}) {
  const size = props.size ?? "sm";
  const [open, setOpen] = useComposerMenuState(props.hidden);

  if (props.readOnly && props.workflow) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              type="button"
              size={size}
              className="shrink-0 whitespace-nowrap"
              aria-label={`Open team panel for ${props.workflow.name}`}
              onClick={props.onOpenTeamPanel}
            />
          }
        >
          <ComposerControlIcon icon={WorkflowIcon} size={size} />
          <span className="max-w-36 truncate">{props.workflow.name}</span>
        </TooltipTrigger>
        <TooltipPopup side="top">Open team panel</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <Select
        open={open}
        onOpenChange={setOpen}
        value={props.workflow?.id ?? NO_WORKFLOW}
        onValueChange={(value) => props.onWorkflowChange(value === NO_WORKFLOW ? null : value!)}
      >
        <TooltipTrigger
          render={
            <ComposerSelectControl
              size={size}
              className="max-w-44 shrink-0 font-medium"
              aria-label="Team workflow"
            />
          }
        >
          <ComposerControlIcon icon={WorkflowIcon} size={size} />
          <SelectValue>{props.workflow?.name ?? "No team"}</SelectValue>
        </TooltipTrigger>
        <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
          <SelectItem value={NO_WORKFLOW}>No team</SelectItem>
          {props.workflows.map((workflow) => (
            <SelectItem key={workflow.id} value={workflow.id}>
              {workflow.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <TooltipPopup side="top">Choose a team workflow</TooltipPopup>
    </Tooltip>
  );
}
