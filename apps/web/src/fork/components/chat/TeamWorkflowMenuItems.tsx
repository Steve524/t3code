import type { TeamWorkflow } from "@t3tools/contracts";
import {
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
} from "../../../components/ui/menu";

export function TeamWorkflowMenuItems(props: {
  teamWorkflows: readonly TeamWorkflow[];
  teamWorkflow?: TeamWorkflow | null | undefined;
  teamWorkflowReadOnly?: boolean | undefined;
  onTeamWorkflowChange?: ((workflowId: string | null) => void) | undefined;
  onOpenTeamPanel?: (() => void) | undefined;
}) {
  if (props.teamWorkflows.length === 0) return null;
  return (
    <>
      <MenuDivider />
      <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Team</div>
      {props.teamWorkflowReadOnly && props.teamWorkflow ? (
        <MenuItem onClick={props.onOpenTeamPanel}>{props.teamWorkflow.name}</MenuItem>
      ) : (
        <MenuRadioGroup
          value={props.teamWorkflow?.id ?? "none"}
          onValueChange={(value) => props.onTeamWorkflowChange?.(value === "none" ? null : value)}
        >
          <MenuRadioItem value="none">No team</MenuRadioItem>
          {props.teamWorkflows.map((workflow) => (
            <MenuRadioItem key={workflow.id} value={workflow.id}>
              {workflow.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      )}
    </>
  );
}
