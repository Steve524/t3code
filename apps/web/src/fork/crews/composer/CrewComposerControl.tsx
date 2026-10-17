import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { ModelSelection, UnifiedSettings } from "@t3tools/contracts";
import type { CrewSummary } from "@t3tools/contracts/fork/crews/crewFile";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { ArrowUpRightIcon, UsersIcon } from "lucide-react";
import { useContext, useId } from "react";

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
import { useEnvironmentProviders } from "../../../state/environments";
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
  hasRepoToolbox,
  orderedCrewRoles,
} from "../settings/crewsSettings.logic";
import { crewCatalog } from "../settings/crewSettingsState";
import { crewComposerSelectionStore, type CrewComposerTarget } from "./crewComposerSelectionStore";
import type { CrewComposerState } from "./crewComposerState";
import { useOpenCrewInitDraft } from "./openCrewInitDraft";

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
    <SelectItem value={crew.id} disabled>
      <span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">
        {crew.name} · {reason}
      </span>
    </SelectItem>
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
  const providersByEnvironment = useEnvironmentProviders();
  const navigate = useNavigate();
  const { target, data, selection } = state;
  if (!target || !data?.detail) return null;
  const detail = data.detail;
  const providers = providersByEnvironment.get(target.environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(providers),
      settings,
      target.projectId,
    ),
  );
  const pending = selection.sending || !data.canStart;
  return (
    <div className="min-w-0 space-y-3 [overflow-wrap:anywhere]">
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
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="min-w-0">{role.name}</span>
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
                  disabled={pending || disabledReason(model.instanceId, model.model) !== null}
                  onModelOptionsChange={(options) =>
                    setModel(createModelSelection(model.instanceId, model.model, options))
                  }
                />
              ) : null}
              {override ? (
                <Button
                  size="xs"
                  variant="ghost-muted"
                  aria-label={`Reset ${role.name} model for this run`}
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
  const openCrewInit = useOpenCrewInitDraft();
  const registry = useContext(RegistryContext);
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
  const hasToolbox = toolbox && hasRepoToolbox(toolbox);
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
  const loadFailed =
    data.list._tag === "Failure" ||
    data.detailResult?._tag === "Failure" ||
    data.toolboxResult?._tag === "Failure";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <ComposerControl
            size={size}
            disabled={selection.sending}
            aria-label={`Crew: ${selected?.name ?? "No crew"}`}
            className="min-w-0 max-w-48"
          />
        }
      >
        <ComposerControlIcon icon={UsersIcon} size={size} />
        <span className="min-w-0 truncate" data-composer-control-label>
          {selected?.name ?? "No crew"}
        </span>
        <ComposerControlChevron size={size} />
      </PopoverTrigger>
      <PopoverPopup align="start" width="md" aria-label="Crew options" {...floating}>
        <div className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
          <div className="space-y-1.5 text-sm">
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
          </div>
          <CrewRoles state={state} settings={settings} fallback={fallback} />
          {hasToolbox ? (
            <Button variant="ghost-muted" size="sm-multiline" onClick={() => openSettings(true)}>
              Repo toolbox · {toolbox.mode} · +{repoItems.size} ·{" "}
              {toolbox.diagnostics.filter((entry) => entry.severity === "warning").length} warnings
            </Button>
          ) : null}
          {selected?.status === "warnings" ? (
            <Button
              variant="ghost-muted"
              size="sm"
              disabled={selection.sending}
              onClick={() => {
                // The command runs in an ordinary thread, so this draft stops being a crew send.
                crewComposerSelectionStore.getState().select(target, null);
                setOpen(false);
                void openCrewInit(target.environmentId, target.projectId, selected.id);
              }}
            >
              Fix with /crew-init
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
                    {name} <span className="text-xs text-muted-foreground">Required</span>
                  </label>
                  {field.type === "boolean" ? (
                    <Select
                      value={typeof value === "boolean" ? String(value) : null}
                      disabled={pending}
                      onValueChange={(value) => {
                        if (value !== null) setValue(value === "true");
                      }}
                    >
                      <SelectTrigger
                        id={`${inputId}-${name}`}
                        size="sm"
                        aria-label={name}
                        aria-required="true"
                        aria-describedby={
                          field.description ? `${inputId}-${name}-description` : undefined
                        }
                      >
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
                      <SelectTrigger
                        id={`${inputId}-${name}`}
                        size="sm"
                        aria-label={name}
                        aria-required="true"
                        aria-describedby={
                          field.description ? `${inputId}-${name}-description` : undefined
                        }
                      >
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
                      required
                      aria-describedby={
                        field.description ? `${inputId}-${name}-description` : undefined
                      }
                      onChange={(event) => setValue(event.target.value)}
                    />
                  )}
                  {field.description ? (
                    <p
                      id={`${inputId}-${name}-description`}
                      className="text-xs text-muted-foreground"
                    >
                      {field.description}
                    </p>
                  ) : null}
                </div>
              );
            })}
          {state.error || loadFailed ? (
            <p role={loadFailed ? "alert" : "status"} className="text-xs text-warning-foreground">
              {state.error ?? "Could not load crews. Check the environment connection and retry."}
            </p>
          ) : null}
          {loadFailed ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const input = { projectId: target.projectId };
                registry.refresh(
                  crewCatalog.crewsLive({ environmentId: target.environmentId, input }),
                );
                if (selection.crewId)
                  registry.refresh(
                    crewCatalog.detail({
                      environmentId: target.environmentId,
                      input: { ...input, crewId: selection.crewId },
                    }),
                  );
                registry.refresh(
                  crewCatalog.toolbox({ environmentId: target.environmentId, input }),
                );
              }}
            >
              Retry loading crew
            </Button>
          ) : null}
          <Button variant="ghost-muted" size="sm" onClick={() => openSettings()}>
            Crew settings <ArrowUpRightIcon aria-hidden="true" />
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
