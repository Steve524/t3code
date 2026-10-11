import { useAtomValue } from "@effect/atom-react";
import { buildRemoteOpenUrl, type EditorId, type EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type {
  CrewDiagnostic,
  CrewRole,
} from "../../../../../../packages/contracts/src/fork/crews/crewFile";
import { usePreferredEditor } from "../../../editorPreferences";
import {
  openRemoteEditorUrl,
  useRemoteCapableEditors,
  useRemoteOpenState,
} from "../../../remoteOpen";
import { shellEnvironment } from "../../../state/shell";
import { useAtomCommand } from "../../../state/use-atom-command";
import ChatMarkdown from "../../../components/ChatMarkdown";
import { useProjectFileQuery } from "../../../components/files/projectFilesQueryState";
import { Button, InlineButton } from "../../../components/ui/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "../../../components/ui/collapsible";
import { toastManager } from "../../../components/ui/toast";
import {
  crewPath,
  diagnosticLocation,
  instructionMarkdown,
  roleInstructions,
  safeInstructionPath,
} from "./crewsSettings.logic";

/** File previews share the catalog's change signal while mounted. */
export function useCrewFileRefresh(revision: unknown, refresh: () => void) {
  const previous = useRef(revision);
  useEffect(() => {
    if (previous.current === revision) return;
    previous.current = revision;
    refresh();
  }, [revision, refresh]);
}

export function useCrewEditor(environmentId: EnvironmentId, availableEditors: readonly EditorId[]) {
  const remote = useRemoteOpenState(environmentId);
  const remoteEditors = useRemoteCapableEditors();
  const [editor] = usePreferredEditor(
    remote.mode === "local-exec" ? availableEditors : remoteEditors,
  );
  const canExecute = useAtomValue(shellEnvironment.openInEditor.permissionAtom(environmentId));
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const canOpen =
    editor !== null &&
    remote.mode !== "remote-unavailable" &&
    (remote.mode === "remote-links" || canExecute);
  const open = async (path: string) => {
    if (!canOpen || !editor) return;
    if (remote.mode === "remote-links") {
      const url = buildRemoteOpenUrl({ editor, host: remote.host.host, absolutePath: path });
      if (url && (await openRemoteEditorUrl(url))) return;
      toastManager.add({ type: "error", title: "Could not open the remote editor" });
    } else {
      const result = await openInEditor({ environmentId, input: { cwd: path, editor } });
      if (result._tag === "Failure")
        toastManager.add({
          type: "error",
          title: "Could not open the editor",
          description: Cause.pretty(result.cause),
        });
    }
  };
  return { canOpen, open };
}

export type CrewEditor = ReturnType<typeof useCrewEditor>;

export function CrewDisclosure({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger render={<Button variant="ghost-muted" size="xs" />}>
        <ChevronDownIcon className={open ? "size-3.5" : "size-3.5 -rotate-90"} />
        {title}
      </CollapsibleTrigger>
      <CollapsiblePanel animate={false}>
        {open ? <div className="space-y-3 py-3">{children}</div> : null}
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function CrewDiagnostics({
  diagnostics,
  editor,
}: {
  diagnostics: readonly CrewDiagnostic[];
  editor: CrewEditor;
}) {
  if (diagnostics.length === 0) return null;
  return (
    <CrewDisclosure title={`Diagnostics (${diagnostics.length})`}>
      <ul className="space-y-2 text-sm">
        {diagnostics.map((diagnostic) => (
          <li
            key={`${diagnosticLocation(diagnostic)}:${diagnostic.severity}:${diagnostic.message}:${diagnostic.path.join(".")}`}
          >
            <span
              className={
                diagnostic.severity === "error"
                  ? "text-destructive-foreground"
                  : "text-muted-foreground"
              }
            >
              {diagnostic.severity}: {diagnostic.message}
            </span>
            <div className="break-all text-xs [--inline-button-white-space:normal]">
              <InlineButton
                disabled={!editor.canOpen}
                onClick={() => void editor.open(diagnosticLocation(diagnostic))}
              >
                {diagnosticLocation(diagnostic)}
              </InlineButton>
            </div>
          </li>
        ))}
      </ul>
    </CrewDisclosure>
  );
}

export function CrewInstructions({
  environmentId,
  directory,
  roleId,
  role,
  editor,
  revision,
}: {
  environmentId: EnvironmentId;
  directory: string;
  roleId: string;
  role: CrewRole;
  editor: CrewEditor;
  revision: unknown;
}) {
  const instructions = roleInstructions(roleId, role);
  const firstPath = safeInstructionPath(instructions.paths[0]);
  const first = useProjectFileQuery(environmentId, directory, firstPath, firstPath !== null);
  const useFallback = instructions.paths.length > 1 && first.error !== null && !first.isPending;
  const fallback = useProjectFileQuery(
    environmentId,
    directory,
    instructions.paths[1] ?? null,
    useFallback,
  );
  useCrewFileRefresh(revision, first.refresh);
  useCrewFileRefresh(revision, fallback.refresh);
  const file = useFallback ? fallback : first;
  const path =
    instructions.text !== null ? "crew.yaml" : useFallback ? instructions.paths[1] : firstPath;
  const text = instructions.text ?? file.data?.contents;
  if (instructions.paths.length > 0 && !firstPath)
    return (
      <p role="alert" className="text-sm text-destructive-foreground">
        The instructions path must stay inside the crew folder.
      </p>
    );
  return (
    <>
      {text !== undefined ? (
        <ChatMarkdown
          text={instructionMarkdown(text)}
          cwd={directory}
          environmentId={environmentId}
        />
      ) : (
        <p role={file.error ? "alert" : "status"} className="text-sm text-muted-foreground">
          {file.error ?? "Loading instructions…"}
        </p>
      )}
      {file.data?.truncated ? (
        <p className="text-sm text-warning">
          Instructions are truncated. Open the file to read the rest.
        </p>
      ) : null}
      <Button
        variant="outline"
        size="xs"
        disabled={!editor.canOpen || !path}
        onClick={() => path && void editor.open(crewPath(directory, path))}
      >
        Open in editor
      </Button>
    </>
  );
}
