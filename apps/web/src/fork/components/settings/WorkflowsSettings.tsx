import {
  type ModelSelection,
  type RuntimeMode,
  type UnifiedSettings,
  type TeamRole,
  type TeamWorkflow,
  EditableArtifactDirectory,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  BUILT_IN_TEAM_WORKFLOW,
  BUILT_IN_TEAM_WORKFLOWS,
  DEFAULT_PLANS_DIR,
  DEFAULT_RESEARCH_DIR,
  isReadOnlyTeamRoleKind,
  resolveTeamWorkflows,
  teamReadOnlyLaunch,
} from "@t3tools/shared/team";
import { ChevronDownIcon, InfoIcon, RotateCcwIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useId, useState } from "react";

import { getCustomModelOptionsByInstance } from "../../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../../providerInstances";
import { EMPTY_SERVER_PROVIDERS } from "../../../state/server";
import { ProviderModelPicker } from "../../../components/chat/ProviderModelPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../../../components/chat/runtimeModeConfig";
import { TraitsPicker } from "../../../components/chat/TraitsPicker";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "../../../components/ui/collapsible";
import {
  NumberField,
  NumberFieldGroup,
  NumberFieldInput,
} from "../../../components/ui/number-field";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Switch } from "../../../components/ui/switch";
import { Textarea } from "../../../components/ui/textarea";
import { searchableSetting } from "../../../components/settings/settingsSearch";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../../../components/settings/settingsLayout";
import { SettingsScopeNotice } from "../../../components/settings/SettingsScopeNotice";
import { useSettingsScope } from "../../../components/settings/SettingsScopeContext";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "../../../components/settings/useScopedSettings";

const isArtifactDirectory = Schema.is(EditableArtifactDirectory);
const INHERIT_RUNTIME_MODE = "same-as-orchestrator";

function isRuntimeMode(value: string): value is RuntimeMode {
  return runtimeModeOptions.some((mode) => mode === value);
}

function upsertWorkflow(
  workflows: ReadonlyArray<TeamWorkflow>,
  nextWorkflow: TeamWorkflow,
): TeamWorkflow[] {
  return workflows.some(({ id }) => id === nextWorkflow.id)
    ? workflows.map((workflow) => (workflow.id === nextWorkflow.id ? nextWorkflow : workflow))
    : [...workflows, nextWorkflow];
}

export function shouldSuggestIndependentQa(
  workflow: TeamWorkflow,
  providerKey: (selection: ModelSelection | null) => string,
): boolean {
  const qa = workflow.roles.find((role) => role.id === "qa" && role.enabled);
  const implementers = workflow.roles.filter((role) => role.kind === "implementer" && role.enabled);
  if (!qa || implementers.length === 0) return false;

  const counts = new Map<string, number>();
  for (const role of implementers) {
    const key = providerKey(role.modelSelection);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length > 1 && ranked[0]![1] === ranked[1]![1]) return false;
  return providerKey(qa.modelSelection) === ranked[0]![0];
}

/** Read-only roles show how their provider keeps them read-only instead of a permissions picker. */
export function readOnlyPermissionLabel(
  provider: Pick<ProviderInstanceEntry, "driverKind" | "displayName"> | undefined,
): string {
  if (provider === undefined) return "Read-only: enforced on Claude, isolated worktree elsewhere";
  return teamReadOnlyLaunch(provider.driverKind) !== null
    ? "Read-only (enforced)"
    : `Read-only not enforced on ${provider.displayName} (isolated worktree)`;
}

function RoleModelControls({
  role,
  settings,
  providers,
  entries,
  onChange,
}: {
  role: TeamRole;
  settings: UnifiedSettings;
  providers: typeof EMPTY_SERVER_PROVIDERS;
  entries: ReturnType<typeof sortProviderInstanceEntries>;
  onChange: (modelSelection: ModelSelection | null) => void;
}) {
  const selection = resolveDefaultProviderModelSelection(providers, role.modelSelection);
  const activeEntry = entries.find((entry) => entry.instanceId === selection?.instanceId);
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );

  if (!selection || !activeEntry) {
    return <span className="text-xs text-muted-foreground">No providers available</span>;
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <ProviderModelPicker
        activeInstanceId={selection.instanceId}
        model={selection.model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={modelOptions}
        triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
        {...(role.modelSelection === null ? { triggerLabel: "Same as host" } : {})}
        triggerAriaLabel={`${role.label} model`}
        onInstanceModelChange={(instanceId, model) =>
          onChange(createModelSelection(instanceId, model))
        }
      />
      {role.modelSelection !== null ? (
        <>
          <TraitsPicker
            provider={activeEntry.driverKind}
            instanceId={activeEntry.instanceId}
            models={activeEntry.models}
            model={selection.model}
            prompt=""
            onPromptChange={() => {}}
            modelOptions={selection.options ?? []}
            allowPromptInjectedEffort={false}
            planModeEnabled={settings.planModeEnabled}
            triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
            onModelOptionsChange={(options) =>
              onChange(createModelSelection(selection.instanceId, selection.model, options))
            }
          />
          <Button size="xs" variant="ghost-muted" onClick={() => onChange(null)}>
            Same as host
          </Button>
        </>
      ) : null}
    </div>
  );
}

function RoleRow({
  role,
  workflow,
  providers,
  entries,
  settings,
  onChange,
  showQaHint,
}: {
  role: TeamRole;
  workflow: TeamWorkflow;
  providers: typeof EMPTY_SERVER_PROVIDERS;
  entries: ReturnType<typeof sortProviderInstanceEntries>;
  settings: UnifiedSettings;
  onChange: (workflow: TeamWorkflow) => void;
  showQaHint: boolean;
}) {
  const builtInRole = BUILT_IN_TEAM_WORKFLOWS.find(({ id }) => id === workflow.id)?.roles.find(
    ({ id }) => id === role.id,
  );
  const updateRole = (patch: Partial<TeamRole>) =>
    onChange({
      ...workflow,
      roles: workflow.roles.map((candidate) =>
        candidate.id === role.id ? { ...candidate, ...patch } : candidate,
      ),
    });

  return (
    <SettingsRow
      title={role.label}
      description={role.summary}
      control={
        <Switch
          checked={role.enabled}
          aria-label={`${role.enabled ? "Disable" : "Enable"} ${role.label}`}
          onCheckedChange={(enabled) => updateRole({ enabled })}
        />
      }
    >
      <div className="grid gap-3 py-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Model</p>
          <RoleModelControls
            role={role}
            settings={settings}
            providers={providers}
            entries={entries}
            onChange={(modelSelection) => updateRole({ modelSelection })}
          />
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Permissions</p>
          {isReadOnlyTeamRoleKind(role.kind) ? (
            <p className="text-sm">
              {readOnlyPermissionLabel(
                role.modelSelection === null
                  ? undefined
                  : entries.find(
                      ({ instanceId }) => instanceId === role.modelSelection?.instanceId,
                    ),
              )}
            </p>
          ) : (
            <Select
              value={role.runtimeMode ?? INHERIT_RUNTIME_MODE}
              onValueChange={(value) => {
                if (value === INHERIT_RUNTIME_MODE) updateRole({ runtimeMode: null });
                else if (value && isRuntimeMode(value)) updateRole({ runtimeMode: value });
              }}
            >
              <SelectTrigger size="sm" aria-label={`${role.label} permissions`}>
                <SelectValue>
                  {role.runtimeMode === null
                    ? "Same as orchestrator"
                    : runtimeModeConfig[role.runtimeMode].label}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="start">
                <SelectItem value={INHERIT_RUNTIME_MODE}>Same as orchestrator</SelectItem>
                {runtimeModeOptions.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {runtimeModeConfig[mode].label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
        </div>
      </div>
      {showQaHint ? (
        <div className="mb-2 flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
          QA uses the same provider as most implementers. Choose another provider for a more
          independent review.
        </div>
      ) : null}
      <Collapsible>
        <CollapsibleTrigger className="flex w-full items-center gap-1.5 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground">
          <ChevronDownIcon className="size-3.5" />
          Instructions
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="space-y-2 pb-3">
            <Textarea
              key={role.instructions}
              size="sm"
              defaultValue={role.instructions}
              placeholder="Use the built-in instructions"
              aria-label={`${role.label} instructions`}
              onBlur={(event) => {
                if (event.currentTarget.value !== role.instructions)
                  updateRole({ instructions: event.currentTarget.value });
              }}
            />
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={role.instructions === (builtInRole?.instructions ?? "")}
              onClick={() => updateRole({ instructions: builtInRole?.instructions ?? "" })}
            >
              Reset to default
            </Button>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </SettingsRow>
  );
}

function ArtifactFolderInput({
  label,
  value,
  onSave,
}: {
  label: string;
  value: string;
  onSave: (value: string) => void;
}) {
  const [invalid, setInvalid] = useState(() => !isArtifactDirectory(value));
  const errorId = useId();
  return (
    <div className="w-64">
      <Input
        aria-label={label}
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
        defaultValue={value}
        onChange={() => setInvalid(false)}
        onBlur={(event) => {
          const next = event.currentTarget.value.trim();
          if (!isArtifactDirectory(next)) {
            setInvalid(true);
            return;
          }
          setInvalid(false);
          if (next !== value) onSave(next);
        }}
      />
      {invalid ? (
        <p id={errorId} role="alert" className="mt-1 text-xs text-destructive">
          Use a relative folder below the checkout root, without &quot;..&quot;, drive letters,
          control characters, or names ending in a dot or space.
        </p>
      ) : null}
    </div>
  );
}

export function WorkflowsSettingsPanel() {
  const { scope, environment } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const [workflowId, setWorkflowId] = useState(BUILT_IN_TEAM_WORKFLOW.id);

  if (scope.kind !== "environment") {
    return (
      <SettingsScopeNotice target="environment">
        Workflow presets belong to one environment. Choose an environment to continue.
      </SettingsScopeNotice>
    );
  }

  const workflows = resolveTeamWorkflows(settings.teamWorkflows);
  const workflow = workflows.find(({ id }) => id === workflowId) ?? BUILT_IN_TEAM_WORKFLOW;
  const builtIn = BUILT_IN_TEAM_WORKFLOWS.find(({ id }) => id === workflow.id);
  const providers = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const saveWorkflow = (nextWorkflow: TeamWorkflow) =>
    updateSettings({ teamWorkflows: upsertWorkflow(settings.teamWorkflows, nextWorkflow) });
  const providerKey = (selection: ModelSelection | null): string => {
    if (selection === null) return "same-as-host";
    return (
      entries.find(({ instanceId }) => instanceId === selection.instanceId)?.driverKind ??
      selection.instanceId
    );
  };
  const showQaHint = shouldSuggestIndependentQa(workflow, providerKey);

  return (
    <SettingsPageContainer key={workflow.id} width="wide">
      <SettingsSection
        {...searchableSetting("team-workflows")}
        title="Presets"
        headerAction={
          builtIn ? (
            <Button size="xs" variant="ghost-muted" onClick={() => saveWorkflow(builtIn)}>
              <RotateCcwIcon />
              Restore built-in preset
            </Button>
          ) : null
        }
      >
        <SettingsRow
          title="Workflow preset"
          description={
            workflow.type === "plan"
              ? "Research and independent plan review. Stops at an approved plan."
              : "Parallel implementation and independent review."
          }
          control={
            <Select
              value={workflow.id}
              onValueChange={(value) => {
                if (value) setWorkflowId(value);
              }}
            >
              <SelectTrigger aria-label="Workflow preset">
                <SelectValue>{workflow.name}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {workflows.map((preset) => (
                  <SelectItem key={preset.id} value={preset.id}>
                    {preset.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection title="Roles">
        {workflow.roles.map((role) => (
          <RoleRow
            key={role.id}
            role={role}
            workflow={workflow}
            providers={providers}
            entries={entries}
            settings={settings}
            onChange={saveWorkflow}
            showQaHint={role.id === "qa" && showQaHint}
          />
        ))}
      </SettingsSection>

      {workflow.type === "plan" ? (
        <SettingsSection title="Artifact folders">
          {(
            [
              ["plansDir", "Plans folder", DEFAULT_PLANS_DIR],
              ["researchDir", "Research folder", DEFAULT_RESEARCH_DIR],
            ] as const
          ).map(([field, label, fallback]) => (
            <SettingsRow
              key={field}
              title={label}
              description="Relative to the project's checkout. Applies to new threads."
              control={
                <ArtifactFolderInput
                  key={workflow[field] ?? fallback}
                  label={label}
                  value={workflow[field] ?? fallback}
                  onSave={(value) => saveWorkflow({ ...workflow, [field]: value })}
                />
              }
            />
          ))}
        </SettingsSection>
      ) : null}

      <SettingsSection title="Limits">
        {(
          [
            ["maxParallelWorkers", "Max parallel workers", "Workers that may run at once."],
            ["maxReviewRounds", "Max review rounds", "Review passes before the team stops."],
            [
              "maxAutoReports",
              "Max automatic updates",
              "Team updates before user input is required.",
            ],
          ] as const
        ).map(([key, title, description]) => (
          <SettingsRow
            key={key}
            title={title}
            description={description}
            control={
              <NumberField
                value={workflow[key]}
                min={1}
                step={1}
                size="sm"
                className="w-24"
                onValueCommitted={(value) => {
                  if (typeof value === "number" && Number.isInteger(value) && value > 0)
                    saveWorkflow({ ...workflow, [key]: value });
                }}
              >
                <NumberFieldGroup>
                  <NumberFieldInput aria-label={title} />
                </NumberFieldGroup>
              </NumberField>
            }
          />
        ))}
      </SettingsSection>

      <SettingsSection title="Orchestrator">
        <SettingsRow
          title="Extra instructions"
          description="Added after the built-in orchestrator instructions."
          resetAction={
            workflow.orchestratorInstructions ? (
              <SettingResetButton
                label="orchestrator instructions"
                onClick={() => saveWorkflow({ ...workflow, orchestratorInstructions: "" })}
              />
            ) : null
          }
        >
          <div className="py-3">
            <Textarea
              key={workflow.orchestratorInstructions}
              defaultValue={workflow.orchestratorInstructions}
              placeholder="Optional instructions for the orchestrator"
              aria-label="Extra orchestrator instructions"
              onBlur={(event) => {
                if (event.currentTarget.value !== workflow.orchestratorInstructions)
                  saveWorkflow({
                    ...workflow,
                    orchestratorInstructions: event.currentTarget.value,
                  });
              }}
            />
          </div>
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
