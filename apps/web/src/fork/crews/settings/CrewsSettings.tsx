import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";

import type { CrewRoleOverrideSetInput } from "@t3tools/contracts/fork/crews/crewRpc";
import { useSettingsScope } from "../../../components/settings/SettingsScopeContext";
import type { ScopedSettingsTarget } from "../../../components/settings/scopedSettings";
import {
  SettingsPageContainer,
  SettingsSection,
} from "../../../components/settings/settingsLayout";
import { useEnvironments } from "../../../state/environments";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Radio, RadioGroup } from "../../../components/ui/radio-group";
import { toastManager } from "../../../components/ui/toast";
import { useProjectFileQuery } from "../../../components/files/projectFilesQueryState";
import { CrewRoleCard } from "./CrewRoleCard";
import {
  CrewDiagnostics,
  CrewDisclosure,
  useCrewEditor,
  useCrewFileRefresh,
  type CrewEditor,
} from "./CrewSettingsParts";
import { crewCatalog, useCrewSettingsState, type CrewSettingsSnapshot } from "./crewSettingsState";
import {
  CREWS_TOOLBOX_EXAMPLE,
  crewHomeLine,
  crewOverrideScope,
  crewPath,
  crewsDirectory,
  hasRepoToolbox,
  orderedCrewRoles,
  referencedCrewSecrets,
  showsRepoToolbox,
  toolboxGrantCount,
} from "./crewsSettings.logic";
import { CrewSecrets } from "./CrewSecrets";
import { useOpenCrewInitDraft } from "../composer/openCrewInitDraft";

function RepoToolbox({
  snapshots,
  snapshot,
  workspaceRoot,
  editor,
  pending,
  save,
  onSetUp,
}: {
  snapshots: readonly CrewSettingsSnapshot[];
  snapshot: CrewSettingsSnapshot;
  workspaceRoot: string;
  editor: CrewEditor;
  pending: boolean;
  save: (operation: () => Promise<readonly string[]>) => void;
  /** Opens a new draft in this project with `/crew-init` for the selected crew. */
  onSetUp: () => void;
}) {
  const setMode = useAtomCommand(crewCatalog.setToolboxMode, { reportFailure: false });
  const result = snapshot.toolbox;
  const toolbox = result && Option.getOrNull(AsyncResult.value(result));
  const file = useProjectFileQuery(snapshot.target.environmentId, workspaceRoot, ".t3/crews.yaml");
  useCrewFileRefresh(toolbox, file.refresh);
  const missing =
    !file.isPending &&
    file.data === null &&
    file.readError !== null &&
    Cause.pretty(Cause.fail(file.readError)).includes("ENOENT");
  const mixed = snapshots.some(
    (candidate) =>
      candidate.toolbox &&
      Option.getOrNull(AsyncResult.value(candidate.toolbox))?.mode !== toolbox?.mode,
  );
  const disabled =
    pending ||
    snapshots.some(
      (candidate) =>
        !candidate.canSetMode || candidate.toolbox?._tag !== "Success" || candidate.toolbox.waiting,
    );
  const directory = crewPath(workspaceRoot, ".t3");
  return (
    <SettingsSection title="Repo toolbox" id="crew-repo-toolbox" variant="plain">
      <div className="min-w-0 space-y-3 px-4 [overflow-wrap:anywhere]">
        <div className="flex flex-wrap gap-2">
          <Button size="xs" variant="outline" onClick={onSetUp}>
            Set up with /crew-init
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={!editor.canOpen}
            onClick={() => void editor.open(crewPath(directory, "crews.yaml"))}
          >
            {missing ? "Create crews.yaml" : "Open crews.yaml"}
          </Button>
        </div>
        <p className="break-all text-xs text-muted-foreground">{directory}</p>
        {snapshots.map((candidate) =>
          candidate.toolbox?._tag === "Failure" ? (
            <p
              key={`${candidate.target.environmentId}:${candidate.target.projectId}`}
              role="alert"
              className="text-sm text-destructive-foreground"
            >
              {candidate.target.label}: {Cause.pretty(candidate.toolbox.cause)}
            </p>
          ) : null,
        )}
        {toolbox ? (
          <>
            <RadioGroup
              aria-label="On a toolbox name clash"
              value={mixed ? null : toolbox.mode}
              disabled={disabled}
              onValueChange={(mode) => {
                if (mode !== "extend" && mode !== "override") return;
                save(async () => {
                  const failures: string[] = [];
                  for (const { target } of snapshots) {
                    if (target.projectId === null) continue;
                    const result = await setMode({
                      environmentId: target.environmentId,
                      input: { projectId: target.projectId, mode },
                    });
                    if (result._tag === "Failure")
                      failures.push(`${target.label}: ${Cause.pretty(result.cause)}`);
                  }
                  return failures;
                });
              }}
            >
              <label className="flex items-center gap-2 text-sm">
                <Radio value="extend" />
                T3 home wins (extend)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Radio value="override" />
                Repo wins (override)
              </label>
            </RadioGroup>
            {mixed ? (
              <p className="text-xs text-muted-foreground">Mixed across selected projects</p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Only changes which definition is used when both define the same name. Repo grants
              always add.
            </p>
            {hasRepoToolbox(toolbox) ? (
              <p className="text-sm text-muted-foreground">
                Grants {toolboxGrantCount(toolbox.grants)} · Definitions: {toolbox.skills.length}{" "}
                skills, {Object.keys(toolbox.mcp.servers).length} MCP servers,{" "}
                {Object.keys(toolbox.tools.tools).length} tools · {toolbox.diagnostics.length}{" "}
                diagnostics
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">No repo toolbox yet.</p>
            )}
            <CrewDiagnostics diagnostics={toolbox.diagnostics} editor={editor} />
          </>
        ) : result?._tag !== "Failure" ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading repo toolbox…
          </p>
        ) : null}
        {missing ? (
          <CrewDisclosure title="Example crews.yaml">
            <p className="text-xs text-muted-foreground">
              Paste this example into the new file in your editor, then save it.
            </p>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
              <code>{CREWS_TOOLBOX_EXAMPLE}</code>
            </pre>
          </CrewDisclosure>
        ) : null}
      </div>
    </SettingsSection>
  );
}

function ConnectedCrewsSettings({
  target,
  targets,
}: {
  target: ScopedSettingsTarget;
  targets: readonly ScopedSettingsTarget[];
}) {
  const { scope } = useSettingsScope();
  const { environments } = useEnvironments();
  const environment = environments.find(
    (environment) => environment.environmentId === target.environmentId,
  );
  const config = environment?.serverConfig;
  const list = useAtomValue(
    crewCatalog.crewsLive({
      environmentId: target.environmentId,
      input: target.projectId === null ? {} : { projectId: target.projectId },
    }),
  );
  const crews = Option.getOrNull(AsyncResult.value(list));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = crews?.find((crew) => crew.id === selectedId) ?? crews?.[0];
  const { snapshots, refresh } = useCrewSettingsState(targets, selected?.id ?? null);
  const snapshot = snapshots.find((snapshot) => snapshot.target === target) ?? snapshots[0];
  const detailResult = snapshot?.detail;
  const detail = detailResult && Option.getOrNull(AsyncResult.value(detailResult));
  const editor = useCrewEditor(target.environmentId, config?.availableEditors ?? []);
  const openCrewInit = useOpenCrewInitDraft();
  const toolbox = snapshot?.toolbox && Option.getOrNull(AsyncResult.value(snapshot.toolbox));
  const setOverride = useAtomCommand(crewCatalog.setRoleOverride, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const directory = config ? crewsDirectory(config.keybindingsConfigPath) : null;
  const projectScope = showsRepoToolbox(scope.kind);
  const workspaceRoot = scope.members.find(
    (member) => member.environmentId === target.environmentId && member.id === target.projectId,
  )?.workspaceRoot;
  const save = async (operation: () => Promise<readonly string[]>) => {
    if (saving.current) return;
    saving.current = true;
    setPending(true);
    setSaveError(null);
    try {
      const failures = await operation();
      if (failures.length > 0) setSaveError(failures.join("\n"));
      else toastManager.add({ type: "success", title: "Crew settings saved" });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
    refresh();
    saving.current = false;
    setPending(false);
  };
  const onSet = (
    roleId: string,
    patch: Pick<CrewRoleOverrideSetInput, "modelSelection" | "runtimeMode">,
  ) => {
    if (!selected || snapshots.some((snapshot) => !snapshot.canSet)) return;
    void save(async () => {
      const failures: string[] = [];
      for (const { target } of snapshots) {
        const result = await setOverride({
          environmentId: target.environmentId,
          input: { ...crewOverrideScope(target.projectId), crewId: selected.id, roleId, ...patch },
        });
        if (result._tag === "Failure")
          failures.push(`${target.label}: ${Cause.pretty(result.cause)}`);
      }
      return failures;
    });
  };
  return (
    <>
      <SettingsSection
        title="Crews"
        id="crews"
        variant="plain"
        headerAction={
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={!editor.canOpen || !(selected?.path ?? directory)}
              onClick={() => {
                const path = selected?.path ?? directory;
                if (path) void editor.open(path);
              }}
            >
              Open folder
            </Button>
            <Button size="xs" variant="ghost-muted" disabled={pending} onClick={refresh}>
              Reload
            </Button>
          </div>
        }
      >
        <div className="min-w-0 space-y-4 px-4 [overflow-wrap:anywhere]">
          {pending ? (
            <p role="status" className="text-xs text-muted-foreground">
              Saving crew settings…
            </p>
          ) : null}
          {targets.length > 1 ? (
            <p className="text-xs text-muted-foreground">
              Showing files and diagnostics from {target.label}. Changes apply to all{" "}
              {targets.length} selected targets.
            </p>
          ) : null}
          {snapshots
            .filter(
              (snapshot) =>
                snapshot.list._tag === "Failure" ||
                snapshot.detail?._tag === "Failure" ||
                snapshot.overrides._tag === "Failure",
            )
            .map((snapshot) => {
              const failed = [snapshot.list, snapshot.detail, snapshot.overrides].find(
                (result) => result?._tag === "Failure",
              );
              return (
                <p
                  key={`${snapshot.target.environmentId}:${snapshot.target.projectId}`}
                  role="alert"
                  className="text-sm text-destructive-foreground"
                >
                  {snapshot.target.label}:{" "}
                  {failed?._tag === "Failure"
                    ? Cause.pretty(failed.cause)
                    : "Could not load crew settings"}
                </p>
              );
            })}
          {saveError ? (
            <p role="alert" className="whitespace-pre-wrap text-sm text-destructive-foreground">
              Some settings were not saved. {saveError}
            </p>
          ) : null}
          {crews === null && list._tag !== "Failure" ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading crews…
            </p>
          ) : null}
          {crews?.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Install a crew at{" "}
              <code>
                {directory
                  ? crewPath(directory, "<id>/crew.yaml")
                  : "this environment's T3 home crews folder"}
              </code>
              .
            </p>
          ) : null}
          {selected ? (
            <>
              <Select
                value={selected.id}
                disabled={pending}
                onValueChange={(id) => setSelectedId(id)}
              >
                <SelectTrigger aria-label="Crew">
                  <SelectValue>{selected.name}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {crews?.map((crew) => (
                    <SelectItem key={crew.id} value={crew.id}>
                      {crew.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge
                  variant={
                    selected.status === "invalid"
                      ? "error"
                      : selected.status === "warnings"
                        ? "warning"
                        : "success"
                  }
                >
                  {selected.status}
                </Badge>
                <span>
                  {selected.roles.length} roles · {selected.diagnosticCounts.errors} errors ·{" "}
                  {selected.diagnosticCounts.warnings} warnings
                </span>
                <span className="break-all">{selected.path}</span>
              </div>
              {selected.description ? (
                <p className="text-sm text-muted-foreground">{selected.description}</p>
              ) : null}
              <p className="text-sm">{crewHomeLine(selected, detail?.definition ?? null)}</p>
              {!projectScope ? (
                <p className="text-xs text-muted-foreground">
                  Validation uses T3 home only. Pick a project to resolve repo skills and tools.
                </p>
              ) : null}
              {detail && snapshot ? (
                <>
                  {orderedCrewRoles(detail.summary).map((role) => (
                    <CrewRoleCard
                      key={`${detail.summary.id}:${role.id}`}
                      detail={detail}
                      roleId={role.id}
                      snapshot={snapshot}
                      snapshots={snapshots}
                      editor={editor}
                      pending={pending}
                      onSet={onSet}
                    />
                  ))}
                  <CrewDiagnostics diagnostics={detail.diagnostics} editor={editor} />
                </>
              ) : detailResult?._tag !== "Failure" ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Loading crew…
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </SettingsSection>
      {projectScope && workspaceRoot && snapshot ? (
        <RepoToolbox
          snapshots={snapshots}
          snapshot={snapshot}
          workspaceRoot={workspaceRoot}
          editor={editor}
          pending={pending}
          save={(operation) => void save(operation)}
          onSetUp={() => {
            if (snapshot.target.projectId === null) return;
            void openCrewInit(
              snapshot.target.environmentId,
              snapshot.target.projectId,
              selected?.id ?? null,
            );
          }}
        />
      ) : (
        <p className="px-4 text-sm text-muted-foreground">
          Pick a project to see its repo toolbox.
        </p>
      )}
      <CrewSecrets
        environmentId={target.environmentId}
        environmentLabel={environment?.label ?? "this environment"}
        referenced={toolbox ? referencedCrewSecrets(toolbox.mcp) : []}
      />
    </>
  );
}

export function CrewsSettings() {
  const { target, targets, scope } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {target ? (
        <ConnectedCrewsSettings
          key={targets.map((target) => `${target.environmentId}:${target.projectId}`).join("|")}
          target={target}
          targets={targets}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          {scope.kind === "unavailable" ? scope.message : "Connect a machine to view its crews."}
        </p>
      )}
    </SettingsPageContainer>
  );
}
