import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createJSONStorage } from "zustand/middleware";
import { useClosedViewStore } from "../../closedViewStore";
import { createMemoryStorage } from "../../lib/storage";
import { reopenClosedView } from "../../reopenClosedView";
import {
  migratePersistedRightPanelState,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../../rightPanelStore";

const environmentId = EnvironmentId.make("environment-a");
const homeThreadId = ThreadId.make("home");
const home = scopeThreadRef(environmentId, homeThreadId);
const key = scopedThreadKey(home);
const crew = { id: "crew-board", kind: "crew-board" };
const diff = { id: "diff", kind: "diff" };
const file = {
  id: "file:src/app.ts",
  kind: "file",
  relativePath: "src/app.ts",
  revealLine: 7,
  revealRequestId: 1,
};

beforeEach(() => {
  useClosedViewStore.setState({ entries: [] });
  useRightPanelStore.setState({
    byThreadKey: {},
    pendingMaximizeThreadKey: null,
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
});

describe("retired crew tabs", () => {
  it.each([true, false])(
    "removes a crew-only panel without reopening it, previously open: %s",
    (isOpen) => {
      const migrated = migratePersistedRightPanelState({
        byThreadKey: { [key]: { isOpen, activeSurfaceId: crew.id, surfaces: [crew] } },
      });
      expect(migrated.byThreadKey[key]).toEqual({
        isOpen: false,
        activeSurfaceId: null,
        surfaces: [],
      });
    },
  );

  it.each([crew.id, diff.id])(
    "preserves other tabs, their order, and a usable selection when %s was active",
    (activeSurfaceId) => {
      const migrated = migratePersistedRightPanelState({
        byThreadKey: {
          [key]: { isOpen: true, maximized: true, activeSurfaceId, surfaces: [file, crew, diff] },
        },
      });
      expect(migrated.byThreadKey[key]).toEqual({
        isOpen: true,
        maximized: true,
        activeSurfaceId: activeSurfaceId === crew.id ? file.id : diff.id,
        surfaces: [file, diff],
      });
    },
  );

  it("runs the cleanup when loading the last shipped panel version and persists it", async () => {
    const options = useRightPanelStore.persist.getOptions();
    const storage = createMemoryStorage();
    useRightPanelStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
    try {
      storage.setItem(
        options.name!,
        JSON.stringify({
          version: 14,
          state: {
            byThreadKey: {
              [key]: { isOpen: true, activeSurfaceId: crew.id, surfaces: [diff, crew] },
            },
            threadPanelVisibilityByThreadKey: { [key]: { inlineOpen: false, popoverOpen: false } },
          },
        }),
      );
      await useRightPanelStore.persist.rehydrate();
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, home),
      ).toMatchObject({
        isOpen: true,
        activeSurfaceId: diff.id,
        surfaces: [diff],
      });
      expect(useRightPanelStore.getState().threadPanelVisibilityByThreadKey[key]?.inlineOpen).toBe(
        false,
      );
      expect(storage.getItem(options.name!)).not.toContain("crew-board");
      await useRightPanelStore.persist.rehydrate();
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, home).surfaces,
      ).toEqual([diff]);
    } finally {
      useRightPanelStore.persist.setOptions({ storage: options.storage });
    }
  });

  it("removes saved crew history on upgrade while preserving and reopening other tabs", async () => {
    const options = useClosedViewStore.persist.getOptions();
    const storage = createMemoryStorage();
    const surviving = { id: "closed-diff", kind: "panel-tab", threadRef: home, surface: diff };
    useClosedViewStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
    try {
      storage.setItem(
        options.name!,
        JSON.stringify({
          version: 2,
          state: {
            entries: [
              { id: "closed-crew", kind: "panel-tab", threadRef: home, surface: crew },
              surviving,
            ],
          },
        }),
      );
      await useClosedViewStore.persist.rehydrate();
      expect(useClosedViewStore.getState().entries).toEqual([surviving]);
      expect(storage.getItem(options.name!)).not.toContain("crew-board");
      expect(
        await reopenClosedView(useClosedViewStore.getState().entries[0]!, {
          openPreview: vi.fn(),
          workspaceAvailable: false,
        }),
      ).toBe(true);
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, home)
          .activeSurfaceId,
      ).toBe("diff");
    } finally {
      useClosedViewStore.persist.setOptions({ storage: options.storage });
    }
  });
});
