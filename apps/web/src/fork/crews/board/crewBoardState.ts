import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { crewThreadIndex, isCrewCardThread } from "@t3tools/client-runtime/fork/crews/runs";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { CrewRunControlInput } from "@t3tools/contracts/fork/crews/crewRun";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { useNowMinute } from "../../../hooks/useNowMinute";
import { useThreadShells } from "../../../state/entities";
import { environmentProjects } from "../../../state/projects";
import { useAtomCommand } from "../../../state/use-atom-command";
import { crewCommands, crewRuns } from "../composer/crewComposerState";

const preferenceKey = "t3:crews:show-role-threads";
function readPreference() {
  try {
    return localStorage.getItem(preferenceKey) === "true";
  } catch {
    return false;
  }
}
export const useCrewPreferences = create<{
  showRoleThreads: boolean;
  setShowRoleThreads: (show: boolean) => void;
}>((set) => ({
  showRoleThreads: readPreference(),
  setShowRoleThreads: (showRoleThreads) => {
    try {
      localStorage.setItem(preferenceKey, String(showRoleThreads));
    } catch {
      /* Storage may be disabled. */
    }
    set({ showRoleThreads });
  },
}));

export const crewProjectRunsAtom = Atom.make((get) =>
  get(environmentProjects.projectsAtom).map((project) => {
    const result = get(
      crewRuns.list({ environmentId: project.environmentId, input: { projectId: project.id } }),
    );
    return {
      project,
      result,
      environmentId: project.environmentId,
      runs: Option.getOrNull(AsyncResult.value(result)) ?? [],
    };
  }),
);
export const crewThreadIndexAtom = Atom.map(crewProjectRunsAtom, crewThreadIndex);
const emptyLive = Atom.make(null);
export function useCrewLive(
  environmentId: EnvironmentId | null,
  input: { runId: string } | { threadId: ThreadId } | null,
) {
  const result = useAtomValue(
    environmentId && input ? crewRuns.live({ environmentId, input }) : emptyLive,
  );
  return { result, view: result ? Option.getOrNull(AsyncResult.value(result)) : null };
}

/** The sidebar owns list refreshes, not one subscription per role thread. */
export function useCrewSidebar() {
  const registry = useContext(RegistryContext);
  const groups = useAtomValue(crewProjectRunsAtom);
  const index = useAtomValue(crewThreadIndexAtom);
  const show = useCrewPreferences((state) => state.showRoleThreads);
  const threads = useThreadShells();
  const topology = threads.map((thread) => `${thread.environmentId}:${thread.id}`).join("|");
  const minute = useNowMinute();
  const targets = groups.map(({ project }) => `${project.environmentId}:${project.id}`).join("|");
  useEffect(() => {
    for (const { project } of registry.get(crewProjectRunsAtom))
      registry.refresh(
        crewRuns.list({ environmentId: project.environmentId, input: { projectId: project.id } }),
      );
    // The thread/project topology and coarse tick trigger list refreshes without
    // depending on the refreshed list itself, which would create a refresh loop.
    // eslint-disable-next-line react/exhaustive-effect-dependencies
  }, [registry, topology, targets, minute]);
  return useMemo(
    () => (thread: { environmentId: string; id?: string }) => isCrewCardThread(thread, index, show),
    [index, show],
  );
}

export function useCrewControl(environmentId: EnvironmentId, runId: string) {
  const permission = useAtomValue(crewCommands.control.permissionAtom(environmentId));
  const control = useAtomCommand(crewCommands.control);
  const registry = useContext(RegistryContext);
  const locked = useRef(false);
  const [pending, setPending] = useState(false);
  const send = async (action: CrewRunControlInput["action"]) => {
    if (!permission || locked.current) return;
    locked.current = true;
    setPending(true);
    try {
      await control({ environmentId, input: { runId, action } });
      for (const { project } of registry.get(crewProjectRunsAtom))
        if (project.environmentId === environmentId)
          registry.refresh(crewRuns.list({ environmentId, input: { projectId: project.id } }));
    } finally {
      locked.current = false;
      setPending(false);
    }
  };
  return { send, disabled: !permission || pending };
}
export type CrewControl = ReturnType<typeof useCrewControl>;
