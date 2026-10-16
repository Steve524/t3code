import { useEffect, type ComponentProps } from "react";
import type { ModelSelection } from "@t3tools/contracts";

import type { ChatComposerProps } from "../../../components/chat/ChatComposer";
import { ProviderModelPicker as UpstreamProviderModelPicker } from "../../../components/chat/ProviderModelPicker";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../../components/ui/tooltip";
import { CrewComposerControl } from "./CrewComposerControl";
import { useCrewComposerState } from "./crewComposerState";
import { useCrewInitCommands } from "./useCrewInitCommands";

export function useCrewComposer(props: ChatComposerProps) {
  const state = useCrewComposerState(
    props.environmentId,
    props.activeProjectId,
    props.routeKind === "draft" ? props.draftId : null,
  );
  const selected = state.selection.crewId !== null;
  const crewInitCommands = useCrewInitCommands(
    props.environmentId,
    props.activeProjectId,
    selected,
  );
  const { multipleModelSelections, onMultipleModelSelectionsChange } = props;
  useEffect(() => {
    if (selected && multipleModelSelections !== null) onMultipleModelSelectionsChange(null);
  }, [selected, multipleModelSelections, onMultipleModelSelectionsChange]);
  const adjusted = selected
    ? {
        ...props,
        supportsMultipleModels: false,
        multipleModelSelections: null,
        isSendBusy: props.isSendBusy || state.selection.sending,
        sendDisabledReason: props.sendDisabledReason ?? state.error,
      }
    : props;
  const control = (fallback: ModelSelection, size: "sm" | "xs", hidden = false) => (
    <CrewComposerControl
      state={state}
      settings={props.settings}
      size={size}
      hidden={hidden}
      fallback={fallback}
    />
  );
  return {
    props: adjusted,
    selected,
    visible: state.visible,
    control,
    crewInitCommands,
  };
}

export function ProviderModelPicker({
  crewSelected,
  ...props
}: ComponentProps<typeof UpstreamProviderModelPicker> & { crewSelected?: boolean }) {
  if (!crewSelected) return <UpstreamProviderModelPicker {...props} />;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex min-w-0" />}>
        <UpstreamProviderModelPicker {...props} />
      </TooltipTrigger>
      <TooltipPopup>Fallback model for crew roles without a saved or run-only model.</TooltipPopup>
    </Tooltip>
  );
}
