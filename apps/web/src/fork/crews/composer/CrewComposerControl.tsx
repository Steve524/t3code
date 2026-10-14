import { useAtomValue } from "@effect/atom-react";
import type { ModelSelection, UnifiedSettings } from "@t3tools/contracts";
import type { CrewSummary } from "@t3tools/contracts/fork/crews/crewFile";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { UsersIcon } from "lucide-react";
import { useId } from "react";

import {
  ComposerControl,
  ComposerControlIcon,
  ComposerControlChevron,
  type ComposerControlSize,
} from "../../../components/chat/ComposerControl";
import { useComposerMenuProps } from "../../../components/chat/composerEventScope";
import { ProviderModelPicker } from "../../../components/chat/ProviderModelPicker";
import { TraitsPicker } from "../../../components/chat/TraitsPicker";
import { useComposerMenuState } from "../../../components/chat/useComposerMenuState";
import { useSettingsProjectGroups } from "../../../components/settings/useSettingsProjectGroups";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../../../components/ui/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../../components/ui/tooltip";
import { useEnvironments } from "../../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../../state/server";
import { getCustomModelOptionsByInstance } from "../../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
  sortProviderInstanceEntries,
} from "../../../providerInstances";
import {
  crewHomeLine,
  crewModelDisabledReason,
  crewModelSource,
  orderedCrewRoles,
} from "../settings/crewsSettings.logic";
import { crewCatalog } from "../settings/crewSettingsState";
import { crewComposerSelectionStore, type CrewComposerTarget } from "./crewComposerSelectionStore";
import type { CrewComposerState } from "./crewComposerState";

function InvalidCrewOption({ crew, target }: { crew: CrewSummary; target: CrewComposerTarget }) {
  const result = useAtomValue(
    crewCatalog.detail({
      environmentId: target.environmentId,
      input: { projectId: target.projectId, crewId: crew.id },
    }),
  );
  const detail = Option.getOrNull(AsyncResult.value(result));
  const reason =
    detail?.diagnostics.find((diagnostic) => diagnostic.severity === "error")?.message ??
    "This crew has errors in this project.";
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="block" />}>
        <SelectItem value={crew.id} disabled>
          {crew.name} · {reason}
        </SelectItem>
      </TooltipTrigger>
      <TooltipPopup>{reason}</TooltipPopup>
    </Tooltip>
  );
}

function CrewRoles({
  state,
  settings,
  fallback,
}: {
  state: CrewComposerState;
  settings: UnifiedSettings;
  fallback: ModelSelection;
}) {
  const { environments } = useEnvironments();
  const navigate = useNavigate();
  const { target, data, selection } = state;
  if (!target || !data?.detail) return null;
  const detail = data.detail;
  const providers =
    environments.find((environment) => environment.environmentId === target.environmentId)
      ?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(providers),
      settings,
      target.projectId,
    ),
  );
  const pending = selection.sending || !data.canStart;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {crewHomeLine(detail.summary, detail.definition)}
      </p>
      {orderedCrewRoles(detail.summary).map((role) => {
        const resolved = detail.roles.find((candidate) => candidate.id === role.id);
        if (!resolved) return null;
        const override = selection.roleModelOverrides[role.id];
        const model = override ?? resolved.model.selection ?? fallback;
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
        const setModel = (value: ModelSelection) => {
          if (!disabledReason(value.instanceId, value.model))
            crewComposerSelectionStore.getState().setRoleModel(target, role.id, value);
        };
        return (
          <div key={role.id} className="space-y-1">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span>{role.name}</span>
              <span className="text-xs text-muted-foreground">
                {override ? "This run" : crewModelSource(resolved.model.source, true)}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <ProviderModelPicker
                environmentId={target.environmentId}
                activeInstanceId={model.instanceId}
                model={model.model}
                lockedProvider={null}
                instanceEntries={entries}
                modelOptionsByInstance={options}
                disabled={pending}
                triggerAriaLabel={`Change ${role.name} for this run`}
                getModelDisabledReason={disabledReason}
                onInstanceModelChange={(instanceId, slug) =>
                  setModel(createModelSelection(instanceId, slug))
                }
                onOpenProviderSetup={(instanceId) => {
                  void navigate({
                    to: "/settings/providers",
                    search: { machine: target.environmentId, instanceId },
                  });
                }}
              />
              {entry ? (
                <TraitsPicker
                  provider={entry.driverKind}
                  models={entry.models}
                  model={model.model}
                  prompt=""
                  onPromptChange={() => {}}
                  modelOptions={model.options ?? []}
                  allowPromptInjectedEffort={false}
                  planModeEnabled={settings.planModeEnabled}
                  disabled={pending}
                  onModelOptionsChange={(options) =>
                    setModel(createModelSelection(model.instanceId, model.model, options))
                  }
                />
              ) : null}
              {override ? (
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={pending}
                  onClick={() =>
                    crewComposerSelectionStore.getState().setRoleModel(target, role.id, null)
                  }
                >
                  Reset
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">Model changes here apply to this run only.</p>
    </div>
  );
}

export function CrewComposerControl({
  state,
  settings,
  fallback = NO_PROVIDER_MODEL_SELECTION,
  size = "sm",
  hidden = false,
}: {
  state: CrewComposerState;
  settings: UnifiedSettings;
  fallback?: ModelSelection;
  size?: ComposerControlSize;
  hidden?: boolean;
}) {
  const [open, setOpen] = useComposerMenuState(hidden);
  const inputId = useId();
  const groups = useSettingsProjectGroups();
  const navigate = useNavigate();
  const floating = useComposerMenuProps();
  const { target, selection, data } = state;
  if (!state.visible || !target || !data) return null;
  const selected = data.crews.find((crew) => crew.id === selection.crewId);
  const detail = data.detail;
  const toolbox = data.toolbox;
  const repoItems = new Set(
    detail?.roles.flatMap((role) =>
      role.toolbox.items
        .filter((item) => item.source === "repo")
        .map((item) => `${item.kind}:${item.name}`),
    ) ?? [],
  );
  const hasToolbox =
    toolbox &&
    (toolbox.grants !== null ||
      toolbox.skills.length > 0 ||
      Object.keys(toolbox.mcp.servers).length > 0 ||
      Object.keys(toolbox.tools.tools).length > 0 ||
      toolbox.diagnostics.length > 0);
  const group = groups.find((group) =>
    group.memberProjects.some(
      (member) => member.environmentId === target.environmentId && member.id === target.projectId,
    ),
  );
  const member = group?.memberProjects.find(
    (member) => member.environmentId === target.environmentId && member.id === target.projectId,
  );
  const openSettings = (toolbox = false) => {
    void navigate({
      to: "/settings/crews",
      search: {
        machine: target.environmentId,
        project: group?.projectKey,
        checkout: member?.physicalProjectKey,
      },
      ...(toolbox ? { hash: "crew-repo-toolbox" } : {}),
    });
  };
  const pending = selection.sending || !data.canStart;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<ComposerControl size={size} disabled={selection.sending} aria-label="Crew" />}
      >
        <ComposerControlIcon icon={UsersIcon} size={size} />
        <span data-composer-control-label>{selected?.name ?? "No crew"}</span>
        <ComposerControlChevron size={size} />
      </PopoverTrigger>
      <PopoverPopup align="start" {...floating}>
        <div className="w-80 max-w-[calc(100vw-3rem)] space-y-4">
          <label className="flex items-center justify-between gap-3 text-sm">
            Crew
            <Select
              value={selection.crewId ?? ""}
              disabled={selection.sending}
              onValueChange={(value) =>
                crewComposerSelectionStore.getState().select(target, value || null)
              }
            >
              <SelectTrigger size="sm" aria-label="Choose crew">
                <SelectValue>{selected?.name ?? "No crew"}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="">No crew</SelectItem>
                {data.crews.map((crew) =>
                  crew.status === "invalid" ? (
                    <InvalidCrewOption key={crew.id} crew={crew} target={target} />
                  ) : (
                    <SelectItem key={crew.id} value={crew.id}>
                      {crew.name}
                    </SelectItem>
                  ),
                )}
              </SelectPopup>
            </Select>
          </label>
          <CrewRoles state={state} settings={settings} fallback={fallback} />
          {hasToolbox ? (
            <Button variant="ghost-muted" size="sm" onClick={() => openSettings(true)}>
              Repo toolbox · {toolbox.mode} · +{repoItems.size} ·{" "}
              {toolbox.diagnostics.filter((entry) => entry.severity === "warning").length} warnings
            </Button>
          ) : null}
          {Object.entries(detail?.definition?.inputs ?? {})
            .filter(([name, field]) => name !== "brief" && field.required)
            .map(([name, field]) => {
              const value = selection.inputs[name] ?? field.default;
              const setValue = (value: string | boolean) =>
                crewComposerSelectionStore.getState().setInput(target, name, value);
              return (
                <div key={name} className="space-y-1">
                  <label className="text-sm" htmlFor={`${inputId}-${name}`}>
                    {name}
                  </label>
                  {field.type === "boolean" ? (
                    <Select
                      value={typeof value === "boolean" ? String(value) : null}
                      disabled={pending}
                      onValueChange={(value) => {
                        if (value !== null) setValue(value === "true");
                      }}
                    >
                      <SelectTrigger id={`${inputId}-${name}`} size="sm" aria-label={name}>
                        <SelectValue placeholder="Choose a value" />
                      </SelectTrigger>
                      <SelectPopup>
                        <SelectItem value="true">Yes</SelectItem>
                        <SelectItem value="false">No</SelectItem>
                      </SelectPopup>
                    </Select>
                  ) : field.type === "enum" ? (
                    <Select
                      value={typeof value === "string" ? value : null}
                      disabled={pending}
                      onValueChange={(value) => {
                        if (value !== null) setValue(value);
                      }}
                    >
                      <SelectTrigger id={`${inputId}-${name}`} size="sm" aria-label={name}>
                        <SelectValue placeholder="Choose a value" />
                      </SelectTrigger>
                      <SelectPopup>
                        {field.values.map((value) => (
                          <SelectItem value={value} key={value}>
                            {value}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  ) : (
                    <Input
                      id={`${inputId}-${name}`}
                      value={typeof value === "string" ? value : ""}
                      disabled={pending}
                      onChange={(event) => setValue(event.target.value)}
                    />
                  )}
                  {field.description ? (
                    <p className="text-xs text-muted-foreground">{field.description}</p>
                  ) : null}
                </div>
              );
            })}
          {state.error ? (
            <p role="status" className="text-xs text-warning">
              {state.error}
            </p>
          ) : null}
          <Button variant="ghost-muted" size="sm" onClick={() => openSettings()}>
            Crew settings ↗
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
