import type { ModelSelection, RuntimeMode } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import type {
  CrewDetail,
  CrewRoleOverrideSetInput,
} from "../../../../../../packages/contracts/src/fork/crews/crewRpc";
import { getCustomModelOptionsByInstance } from "../../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../../providerInstances";
import { useEnvironments } from "../../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../../state/server";
import { useScopedSettings } from "../../../components/settings/useScopedSettings";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../../../components/settings/settingsLayout";
import { ProviderModelPicker } from "../../../components/chat/ProviderModelPicker";
import { TraitsPicker } from "../../../components/chat/TraitsPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../../../components/chat/runtimeModeConfig";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../../components/ui/tooltip";
import { toastManager } from "../../../components/ui/toast";
import { CrewDisclosure, CrewInstructions, type CrewEditor } from "./CrewSettingsParts";
import type { CrewSettingsSnapshot } from "./crewSettingsState";
import {
  crewModelDisabledReason,
  crewModelsMixed,
  crewModelSource,
  crewToolboxChips,
} from "./crewsSettings.logic";

type OverridePatch = Pick<CrewRoleOverrideSetInput, "modelSelection" | "runtimeMode">;

export function CrewRoleCard({
  detail,
  roleId,
  snapshot,
  snapshots,
  editor,
  pending,
  onSet,
}: {
  detail: CrewDetail;
  roleId: string;
  snapshot: CrewSettingsSnapshot;
  snapshots: readonly CrewSettingsSnapshot[];
  editor: CrewEditor;
  pending: boolean;
  onSet: (roleId: string, patch: OverridePatch) => void;
}) {
  const { environments } = useEnvironments();
  const settings = useScopedSettings();
  const navigate = useNavigate();
  const role = detail.definition?.roles[roleId];
  const resolved = detail.roles.find((role) => role.id === roleId);
  const { target } = snapshot;
  const environment = environments.find(
    (environment) => environment.environmentId === target.environmentId,
  );
  const providers = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const selection =
    resolved?.model.selection ??
    resolveDefaultProviderModelSelection(providers, settings.defaultModelSelection) ??
    NO_PROVIDER_MODEL_SELECTION;
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection.instanceId,
    selection.model,
  );
  const activeEntry = entries.find((entry) => entry.instanceId === selection.instanceId);
  const roleStates = snapshots.map((snapshot) => {
    const detail = snapshot.detail && Option.getOrNull(AsyncResult.value(snapshot.detail));
    return detail?.roles.find((role) => role.id === roleId);
  });
  const ready =
    roleStates.every((role) => role !== undefined) &&
    snapshots.every(
      (snapshot) =>
        snapshot.detail?._tag === "Success" &&
        !snapshot.detail.waiting &&
        snapshot.overrides._tag === "Success" &&
        !snapshot.overrides.waiting &&
        snapshot.list._tag === "Success",
    );
  const disabled = pending || !ready || snapshots.some((snapshot) => !snapshot.canSet);
  const mixed = crewModelsMixed(roleStates.flatMap((role) => (role ? [role.model] : [])));
  const runtimeMixed = roleStates.some(
    (role) =>
      role?.runtimeMode.runtimeMode !== resolved?.runtimeMode.runtimeMode ||
      role?.runtimeMode.source !== resolved?.runtimeMode.source,
  );
  const overrides = snapshots
    .flatMap((snapshot) => Option.getOrNull(AsyncResult.value(snapshot.overrides)) ?? [])
    .filter((override) => override.crewId === detail.summary.id && override.roleId === roleId);
  const providerTargets = snapshots.map(({ target }) => {
    const providers =
      environments.find((environment) => environment.environmentId === target.environmentId)
        ?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
    return {
      label: target.label,
      entries: applyProviderInstanceSettings(
        deriveProviderInstanceEntries(providers),
        target.settings,
      ),
      options: getCustomModelOptionsByInstance({ ...settings, ...target.settings }, providers),
    };
  });
  const disabledReason = (instanceId: ModelSelection["instanceId"], model: string) =>
    crewModelDisabledReason({ instanceId, model }, entries, providerTargets);
  const setModel = (modelSelection: ModelSelection) => {
    const reason = disabledReason(modelSelection.instanceId, modelSelection.model);
    if (reason) {
      toastManager.add({ type: "error", title: "Crew model not saved", description: reason });
      return;
    }
    onSet(roleId, { modelSelection });
  };
  const openProviders = (instanceId?: ModelSelection["instanceId"]) =>
    void navigate({
      to: "/settings/providers",
      search: {
        machine: target.environmentId,
        environmentId: target.environmentId,
        ...(instanceId ? { instanceId } : {}),
      },
    });
  if (!role || !resolved) return null;
  const unavailable =
    resolved.model.warnings.length > 0 ||
    disabledReason(selection.instanceId, selection.model) !== null;
  const source = mixed
    ? "Mixed"
    : crewModelSource(resolved.model.source, target.projectId !== null);
  const modelLabel =
    modelOptions.get(selection.instanceId)?.find((option) => option.slug === selection.model)
      ?.name ?? selection.model;
  const chips = crewToolboxChips(resolved.toolbox, target.projectId !== null);
  return (
    <section className="space-y-3 rounded-lg border border-border p-4" aria-label={role.name}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium">
            {role.name}
            {detail.summary.home?.mode === "lead" && detail.summary.home.roleId === roleId ? (
              <Badge variant="info">Lead</Badge>
            ) : null}
          </h3>
          {role.description ? (
            <p className="text-sm text-muted-foreground">{role.description}</p>
          ) : null}
        </div>
        <span className="text-xs text-muted-foreground">{role.tags?.join(" · ")}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm">Model</span>
        <ProviderModelPicker
          activeInstanceId={selection.instanceId}
          model={selection.model}
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={modelOptions}
          disabled={disabled}
          triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
          triggerAriaLabel={`${role.name} model`}
          {...(mixed
            ? { triggerLabel: "Mixed" }
            : resolved.model.selection === null
              ? { triggerLabel: "Composer model" }
              : resolved.model.source === "crew-hint" && !unavailable
                ? { triggerLabel: `Crew default (${modelLabel})` }
                : {})}
          getModelDisabledReason={disabledReason}
          onOpenProviderSetup={openProviders}
          onInstanceModelChange={(instanceId, model) =>
            setModel(createModelSelection(instanceId, model))
          }
        />
        {activeEntry && !mixed && resolved.model.selection !== null ? (
          <TraitsPicker
            provider={activeEntry.driverKind}
            models={activeEntry.models}
            model={selection.model}
            prompt=""
            onPromptChange={() => {}}
            modelOptions={selection.options ?? []}
            allowPromptInjectedEffort={false}
            planModeEnabled={settings.planModeEnabled}
            triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
            disabled={disabled || unavailable}
            onModelOptionsChange={(options) =>
              setModel(createModelSelection(selection.instanceId, selection.model, options))
            }
          />
        ) : null}
        <span className="text-xs text-muted-foreground">{source}</span>
        {overrides.some((override) => override.modelSelection !== null) ? (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={disabled}
            onClick={() => onSet(roleId, { modelSelection: null })}
            aria-label={`Reset ${role.name} model`}
          >
            Reset
          </Button>
        ) : null}
      </div>
      {unavailable ? (
        <div className="space-y-1 text-xs text-warning">
          {resolved.model.warnings.length === 0 ? (
            <p>{disabledReason(selection.instanceId, selection.model)}</p>
          ) : null}
          {resolved.model.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          <Button size="xs" variant="outline" onClick={() => openProviders(selection.instanceId)}>
            Open provider settings
          </Button>
        </div>
      ) : null}
      {!ready ? (
        <p className="text-xs text-muted-foreground">
          This role must be loaded on every selected machine before bulk editing.
        </p>
      ) : null}
      <CrewDisclosure title="Instructions">
        <CrewInstructions
          environmentId={target.environmentId}
          directory={detail.summary.path}
          roleId={roleId}
          role={role}
          editor={editor}
          revision={detail}
        />
      </CrewDisclosure>
      <CrewDisclosure title="Advanced">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">Permissions</span>
          <Select
            value={runtimeMixed ? null : resolved.runtimeMode.runtimeMode}
            disabled={disabled}
            onValueChange={(value) => {
              if (value === "inherit") onSet(roleId, { runtimeMode: null });
              else if (runtimeModeOptions.includes(value as RuntimeMode))
                onSet(roleId, { runtimeMode: value as RuntimeMode });
            }}
          >
            <SelectTrigger size="sm" aria-label={`${role.name} permissions`}>
              <SelectValue>
                {runtimeMixed
                  ? "Mixed"
                  : resolved.runtimeMode.runtimeMode === "inherit"
                    ? "Inherit from run"
                    : runtimeModeConfig[resolved.runtimeMode.runtimeMode].label}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="inherit">Inherit</SelectItem>
              {runtimeModeOptions.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {runtimeModeConfig[mode].label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <span className="text-xs text-muted-foreground">
            {runtimeMixed
              ? "Mixed"
              : resolved.runtimeMode.source === "inherit"
                ? "Run permissions"
                : crewModelSource(resolved.runtimeMode.source, target.projectId !== null)}
          </span>
          {overrides.some((override) => override.runtimeMode !== null) ? (
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={disabled}
              onClick={() => onSet(roleId, { runtimeMode: null })}
              aria-label={`Reset ${role.name} permissions`}
            >
              Reset
            </Button>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          Owned paths: {role.owns?.join(", ") || "None specified"}
        </p>
        {(
          [
            ["skill", "Skills"],
            ["mcp", "MCP servers"],
            ["tool", "Tools"],
          ] as const
        ).map(([kind, label]) => (
          <div key={kind} className="space-y-1">
            <h4 className="text-xs text-muted-foreground">{label}</h4>
            <div className="flex flex-wrap gap-1.5">
              {chips
                .filter((chip) => chip.kind === kind)
                .map((chip) => (
                  <Tooltip key={chip.key}>
                    <TooltipTrigger
                      render={
                        <Badge variant={chip.warning ? "warning" : "secondary"} tabIndex={0} />
                      }
                    >
                      {chip.label}
                    </TooltipTrigger>
                    <TooltipPopup>{chip.tooltip}</TooltipPopup>
                  </Tooltip>
                ))}
              {!chips.some((chip) => chip.kind === kind) ? (
                <span className="text-xs text-muted-foreground">None</span>
              ) : null}
            </div>
          </div>
        ))}
      </CrewDisclosure>
    </section>
  );
}
