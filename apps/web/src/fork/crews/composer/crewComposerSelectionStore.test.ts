import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { DraftId } from "../../../composerDraftStore";
import {
  createCrewComposerSelectionStore,
  crewComposerTargetKey,
  EMPTY_CREW_SELECTION,
} from "./crewComposerSelectionStore";

const target = {
  environmentId: EnvironmentId.make("one"),
  projectId: ProjectId.make("project"),
  draftId: "draft-a" as DraftId,
};
const model = { instanceId: ProviderInstanceId.make("codex-b"), model: "model", options: [] };

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe("crew composer selection", () => {
  it("keeps a selected crew in its draft without blocking the next draft", () => {
    const storage = memoryStorage();
    const store = createCrewComposerSelectionStore(() => storage);
    const actions = store.getState();
    actions.initialize(target);
    actions.select(target, "trio");
    actions.setInput(target, "language", "TypeScript");
    actions.setRoleModel(target, "worker", model);
    const next = { ...target, draftId: "draft-b" as DraftId };
    actions.initialize(next);
    expect(store.getState().selections[crewComposerTargetKey(next)]).toEqual(EMPTY_CREW_SELECTION);
    expect(
      store.getState().selections[crewComposerTargetKey(target)]?.roleModelOverrides.worker,
    ).toEqual(model);
    expect([...storage.values.values()]).toEqual(["trio"]);
  });

  it("ignores a saved crew after reloading while crew starts are disabled", () => {
    const storage = memoryStorage();
    createCrewComposerSelectionStore(() => storage)
      .getState()
      .select(target, "trio");
    const store = createCrewComposerSelectionStore(() => storage);
    const elsewhere = [
      { ...target, projectId: ProjectId.make("another") },
      { ...target, environmentId: EnvironmentId.make("two") },
    ];
    store.getState().initialize(target);
    for (const other of elsewhere) {
      store.getState().initialize(other);
      expect(store.getState().selections[crewComposerTargetKey(other)]?.crewId).toBeNull();
    }
    expect(store.getState().selections[crewComposerTargetKey(target)]?.crewId).toBeNull();
    expect([...storage.values.values()]).toEqual(["trio"]);
  });

  it("clears run-only values when switching crews or choosing No crew", () => {
    const storage = memoryStorage();
    const store = createCrewComposerSelectionStore(() => storage);
    const actions = store.getState();
    actions.select(target, "trio");
    actions.setRoleModel(target, "worker", model);
    actions.setInput(target, "flag", false);
    actions.select(target, "duo");
    expect(store.getState().selections[crewComposerTargetKey(target)]).toEqual({
      ...EMPTY_CREW_SELECTION,
      crewId: "duo",
    });
    actions.select(target, null);
    expect(storage.values.size).toBe(0);
    expect(store.getState().selections[crewComposerTargetKey(target)]).toEqual(
      EMPTY_CREW_SELECTION,
    );
  });

  it("keeps a send's selection fixed, then clears its overrides without forgetting the last crew", () => {
    const storage = memoryStorage();
    const store = createCrewComposerSelectionStore(() => storage);
    const actions = store.getState();
    actions.select(target, "trio");
    actions.setRoleModel(target, "worker", model);
    actions.setSending(target, true);
    actions.select(target, null);
    actions.setInput(target, "language", "ignored");
    actions.setRoleModel(target, "worker", null);
    expect(store.getState().selections[crewComposerTargetKey(target)]).toEqual({
      ...EMPTY_CREW_SELECTION,
      crewId: "trio",
      sending: true,
      roleModelOverrides: { worker: model },
    });
    actions.sent(target);
    expect(store.getState().selections[crewComposerTargetKey(target)]).toEqual(
      EMPTY_CREW_SELECTION,
    );
    expect([...storage.values.values()]).toEqual(["trio"]);
  });

  it("keeps drafts usable when getting localStorage itself throws", () => {
    const store = createCrewComposerSelectionStore(() => {
      throw new Error("Denied");
    });
    const actions = store.getState();
    expect(() => actions.initialize(target)).not.toThrow();
    expect(() => actions.select(target, "trio")).not.toThrow();
    expect(store.getState().selections[crewComposerTargetKey(target)]?.crewId).toBe("trio");
    expect(() => actions.select(target, null)).not.toThrow();
  });

  it("does not overwrite an existing draft when initialized again", () => {
    const store = createCrewComposerSelectionStore(memoryStorage);
    const actions = store.getState();
    actions.select(target, "trio");
    actions.setRoleModel(target, "worker", model);
    actions.initialize(target);
    expect(
      store.getState().selections[crewComposerTargetKey(target)]?.roleModelOverrides.worker,
    ).toEqual(model);
    actions.setRoleModel(target, "worker", null);
    expect(store.getState().selections[crewComposerTargetKey(target)]?.roleModelOverrides).toEqual(
      {},
    );
  });
});
