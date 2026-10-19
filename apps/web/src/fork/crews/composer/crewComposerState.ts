import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";
import { useStore } from "zustand";

import type { DraftId } from "../../../composerDraftStore";
import { crewCatalog } from "../settings/crewSettingsState";
import {
  crewComposerSelectionStore,
  crewComposerTargetKey,
  EMPTY_CREW_SELECTION,
} from "./crewComposerSelectionStore";
import { crewSelectionError } from "./crewSend.logic";

export function useCrewComposerState(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  draftId: DraftId | null,
) {
  const target = projectId && draftId ? { environmentId, projectId, draftId } : null;
  const key = target ? crewComposerTargetKey(target) : null;
  const selection = useStore(crewComposerSelectionStore, (state) =>
    key ? (state.selections[key] ?? EMPTY_CREW_SELECTION) : EMPTY_CREW_SELECTION,
  );
  useEffect(() => {
    if (target) crewComposerSelectionStore.getState().initialize(target);
  }, [target]);
  const data = useAtomValue(
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
        detailResult: detail,
        toolboxResult: toolbox,
        detail: detail ? Option.getOrNull(AsyncResult.value(detail)) : null,
        toolbox: toolbox ? Option.getOrNull(AsyncResult.value(toolbox)) : null,
        canStart: false,
      };
    }),
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
      : data?.list._tag === "Failure" ||
          data?.detailResult?._tag === "Failure" ||
          data?.toolboxResult?._tag === "Failure"
        ? "Could not load this crew. Check the environment connection and retry."
        : crewSelectionError(selection, data?.detail ?? null);
  return {
    target,
    selection,
    data,
    error,
    visible: target !== null && (data?.crews.length ?? 0) > 0,
  };
}

export type CrewComposerState = ReturnType<typeof useCrewComposerState>;
