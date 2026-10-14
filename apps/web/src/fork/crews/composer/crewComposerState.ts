import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createCrewCommands } from "@t3tools/client-runtime/fork/crews/commands";
import { createCrewRunAtoms } from "@t3tools/client-runtime/fork/crews/runs";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useMemo } from "react";
import { useStore } from "zustand";

import type { DraftId } from "../../../composerDraftStore";
import { connectionAtomRuntime } from "../../../connection/runtime";
import { crewCatalog } from "../settings/crewSettingsState";
import {
  crewComposerSelectionStore,
  crewComposerTargetKey,
  EMPTY_CREW_SELECTION,
} from "./crewComposerSelectionStore";
import { crewSelectionError } from "./crewSend.logic";

export const crewCommands = createCrewCommands(connectionAtomRuntime);
export const crewRuns = createCrewRunAtoms(connectionAtomRuntime);

export function useCrewComposerState(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  draftId: DraftId | null,
) {
  const target = useMemo(
    () => (projectId && draftId ? { environmentId, projectId, draftId } : null),
    [environmentId, projectId, draftId],
  );
  const key = target ? crewComposerTargetKey(target) : null;
  const selection = useStore(crewComposerSelectionStore, (state) =>
    key ? (state.selections[key] ?? EMPTY_CREW_SELECTION) : EMPTY_CREW_SELECTION,
  );
  useEffect(() => {
    if (target) crewComposerSelectionStore.getState().initialize(target);
  }, [target]);
  const data = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) => {
          if (!target) return null;
          const input = { projectId: target.projectId };
          const list = get(crewCatalog.crewsLive({ environmentId, input }));
          const crews = Option.getOrNull(AsyncResult.value(list)) ?? [];
          const installed =
            selection.crewId !== null && crews.some((crew) => crew.id === selection.crewId);
          const detail = installed
            ? get(
                crewCatalog.detail({
                  environmentId,
                  input: { ...input, crewId: selection.crewId! },
                }),
              )
            : null;
          const toolbox = installed ? get(crewCatalog.toolbox({ environmentId, input })) : null;
          return {
            list,
            crews,
            detail: detail ? Option.getOrNull(AsyncResult.value(detail)) : null,
            toolbox: toolbox ? Option.getOrNull(AsyncResult.value(toolbox)) : null,
            canStart: get(crewCommands.start.permissionAtom(environmentId)),
          };
        }),
      [target, environmentId, selection.crewId],
    ),
  );
  useEffect(() => {
    if (
      target &&
      selection.crewId &&
      data?.list._tag === "Success" &&
      !data.list.waiting &&
      !data.crews.some((crew) => crew.id === selection.crewId)
    ) {
      crewComposerSelectionStore.getState().select(target, null);
    }
  }, [target, selection.crewId, data]);
  const error =
    selection.crewId === null
      ? null
      : !data?.canStart
        ? "This connection cannot start crew runs."
        : crewSelectionError(selection, data.detail);
  return {
    target,
    selection,
    data,
    error,
    visible: target !== null && (data?.crews.length ?? 0) > 0,
  };
}

export type CrewComposerState = ReturnType<typeof useCrewComposerState>;
