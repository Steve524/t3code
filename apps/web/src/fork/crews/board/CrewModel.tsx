import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import type { CrewRunView } from "@t3tools/contracts/fork/crews/crewRun";
import { createModelSelection } from "@t3tools/shared/model";
import { ProviderInstanceIcon } from "../../../components/chat/ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../../components/ui/tooltip";
import { ProviderModelPicker } from "../../../components/chat/ProviderModelPicker";
import { TraitsPicker } from "../../../components/chat/TraitsPicker";
import { useEnvironmentSettings } from "../../../hooks/useSettings";
import { useServerConfigs } from "../../../state/entities";
import { EMPTY_SERVER_PROVIDERS } from "../../../state/server";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../../providerInstances";
import { getCustomModelOptionsByInstance } from "../../../modelSelection";
import { crewModelDisabledReason } from "../settings/crewsSettings.logic";
import type { CrewControl } from "./crewBoardState";

export function CrewModelLabel({
  environmentId,
  selection,
}: {
  environmentId: EnvironmentId;
  selection: ModelSelection;
}) {
  const providers = useServerConfigs().get(environmentId)?.providers ?? EMPTY_SERVER_PROVIDERS;
  const entry = deriveProviderInstanceEntries(providers).find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  const label =
    entry?.models.find((model) => model.slug === selection.model)?.name ?? selection.model;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex items-center gap-1 text-xs" />}>
        {entry && (
          <ProviderInstanceIcon
            driverKind={entry.driverKind}
            displayName={entry.displayName}
            accentColor={entry.accentColor}
            showBadge
            className="size-4"
            iconClassName="size-4"
          />
        )}
        {label} · {entry?.displayName ?? selection.instanceId}
      </TooltipTrigger>
      <TooltipPopup>
        {selection.instanceId} · {selection.model}
      </TooltipPopup>
    </Tooltip>
  );
}

export function CrewRoleModel({
  environmentId,
  view,
  roleId,
  control,
}: {
  environmentId: EnvironmentId;
  view: CrewRunView;
  roleId: string;
  control: CrewControl;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const providers = useServerConfigs().get(environmentId)?.providers ?? EMPTY_SERVER_PROVIDERS;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(providers),
      settings,
      view.projectId,
    ),
  );
  const role = view.roles.find((candidate) => candidate.id === roleId);
  if (!role) return null;
  const model = role.modelSelection;
  const options = getCustomModelOptionsByInstance(
    settings,
    providers,
    model.instanceId,
    model.model,
  );
  const entry = entries.find((candidate) => candidate.instanceId === model.instanceId);
  const disabledReason = (instanceId: ModelSelection["instanceId"], slug: string) =>
    crewModelDisabledReason({ instanceId, model: slug }, entries, [
      { label: "this environment", entries, options },
    ]);
  const setModel = (selection: ModelSelection) => {
    if (!disabledReason(selection.instanceId, selection.model))
      void control.send({ type: "setRoleModel", roleId, selection });
  };
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Change {role.name}'s model for future dispatches.
      </p>
      <div className="flex flex-wrap gap-1">
        <ProviderModelPicker
          environmentId={environmentId}
          activeInstanceId={model.instanceId}
          model={model.model}
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={options}
          disabled={control.disabled}
          triggerAriaLabel={`Change ${role.name} model`}
          getModelDisabledReason={disabledReason}
          onInstanceModelChange={(instanceId, slug) =>
            setModel(createModelSelection(instanceId, slug))
          }
        />
        {entry && (
          <TraitsPicker
            provider={entry.driverKind}
            models={entry.models}
            model={model.model}
            prompt=""
            onPromptChange={() => {}}
            modelOptions={model.options ?? []}
            allowPromptInjectedEffort={false}
            planModeEnabled={settings.planModeEnabled}
            disabled={control.disabled}
            onModelOptionsChange={(value) =>
              setModel(createModelSelection(model.instanceId, model.model, value))
            }
          />
        )}
      </div>
    </div>
  );
}
