import type { EnvironmentId, ModelSelection, ProjectId } from "@t3tools/contracts";
import { createStore } from "zustand/vanilla";

import type { DraftId } from "../../../composerDraftStore";

export interface CrewComposerTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly draftId: DraftId;
}

export interface CrewComposerSelection {
  readonly crewId: string | null;
  readonly inputs: Readonly<Record<string, string | boolean>>;
  readonly roleModelOverrides: Readonly<Record<string, ModelSelection>>;
  readonly sending: boolean;
}

export const EMPTY_CREW_SELECTION: CrewComposerSelection = {
  crewId: null,
  inputs: {},
  roleModelOverrides: {},
  sending: false,
};

export function crewComposerTargetKey(target: CrewComposerTarget) {
  return JSON.stringify([target.environmentId, target.projectId, target.draftId]);
}

function lastCrewKey(target: CrewComposerTarget) {
  return `t3code:crews:last:${JSON.stringify([target.environmentId, target.projectId])}`;
}

export function createCrewComposerSelectionStore(
  storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem"> = () => localStorage,
) {
  return createStore<{
    selections: Readonly<Record<string, CrewComposerSelection>>;
    initialize: (target: CrewComposerTarget) => void;
    select: (target: CrewComposerTarget, crewId: string | null) => void;
    setInput: (target: CrewComposerTarget, name: string, value: string | boolean) => void;
    setRoleModel: (
      target: CrewComposerTarget,
      roleId: string,
      model: ModelSelection | null,
    ) => void;
    setSending: (target: CrewComposerTarget, sending: boolean) => void;
    sent: (target: CrewComposerTarget) => void;
  }>((set, get) => {
    const update = (
      target: CrewComposerTarget,
      change: (selection: CrewComposerSelection) => CrewComposerSelection,
    ) => {
      const key = crewComposerTargetKey(target);
      set((state) => ({
        selections: {
          ...state.selections,
          [key]: change(state.selections[key] ?? EMPTY_CREW_SELECTION),
        },
      }));
    };
    return {
      selections: {},
      initialize: (target) => {
        if (get().selections[crewComposerTargetKey(target)]) return;
        // New drafts must allow ordinary sends while crew starts are disabled.
        update(target, () => EMPTY_CREW_SELECTION);
      },
      select: (target, crewId) => {
        const previous = get().selections[crewComposerTargetKey(target)];
        if (previous?.sending || previous?.crewId === crewId) return;
        update(target, () => ({ ...EMPTY_CREW_SELECTION, crewId }));
        try {
          if (crewId === null) storage().removeItem(lastCrewKey(target));
          else storage().setItem(lastCrewKey(target), crewId);
        } catch {
          /* Keep the draft usable when storage is unavailable. */
        }
      },
      setInput: (target, name, value) =>
        update(target, (selection) =>
          selection.sending
            ? selection
            : { ...selection, inputs: { ...selection.inputs, [name]: value } },
        ),
      setRoleModel: (target, roleId, model) =>
        update(target, (selection) => {
          if (selection.sending) return selection;
          const roleModelOverrides = { ...selection.roleModelOverrides };
          if (model === null) delete roleModelOverrides[roleId];
          else roleModelOverrides[roleId] = model;
          return { ...selection, roleModelOverrides };
        }),
      setSending: (target, sending) => update(target, (selection) => ({ ...selection, sending })),
      sent: (target) => update(target, () => EMPTY_CREW_SELECTION),
    };
  });
}

export const crewComposerSelectionStore = createCrewComposerSelectionStore();
