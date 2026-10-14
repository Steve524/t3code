import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useClosedViewStore } from "../../../closedViewStore";
import { reopenClosedView } from "../../../reopenClosedView";
import {
  migratePersistedRightPanelState,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../../../rightPanelStore";
import { CREW_BOARD_SURFACE } from "./crewBoardSurface";
import { openCrewBoard } from "./openCrewBoard";

const environmentId = EnvironmentId.make("environment-a");
const homeThreadId = ThreadId.make("home");
const home = scopeThreadRef(environmentId, homeThreadId);
const role = scopeThreadRef(environmentId, ThreadId.make("role"));
const run = { runId: "run", homeThreadId };
const panel = (ref = home) =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);

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

describe("crew board panel", () => {
  it("opens beside the home thread, preserving its tabs and the role thread's panel", () => {
    const panels = useRightPanelStore.getState();
    panels.openFile(home, "src/app.ts");
    panels.setMaximized(home, true);
    panels.open(role, "diff");

    expect(openCrewBoard(environmentId, run)).toEqual({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: homeThreadId },
    });
    expect(panel()).toMatchObject({
      isOpen: true,
      activeSurfaceId: "crew-board",
      surfaces: [{ id: "file:src/app.ts" }, CREW_BOARD_SURFACE],
    });
    expect(panel().maximized).toBeUndefined();
    expect(panel(role).activeSurfaceId).toBe("diff");
    expect(panel(role).surfaces).toEqual([{ id: "diff", kind: "diff" }]);
  });

  it("reuses the board tab after reordering and switching tabs", () => {
    const panels = useRightPanelStore.getState();
    panels.open(home, "files");
    openCrewBoard(environmentId, run);
    panels.moveSurface(home, "crew-board", 0);
    panels.activateSurface(home, "files");
    const revision = panels.getUserActionRevision(home);

    openCrewBoard(environmentId, run);

    expect(panel().surfaces.map((surface) => surface.id)).toEqual(["crew-board", "files"]);
    expect(panel().activeSurfaceId).toBe("crew-board");
    expect(panels.getUserActionRevision(home)).toBe(revision + 1);
  });

  it("keeps identical home thread ids in different environments separate", () => {
    const remoteId = EnvironmentId.make("environment-remote");
    const remoteHome = scopeThreadRef(remoteId, homeThreadId);
    useRightPanelStore.getState().open(home, "diff");

    expect(openCrewBoard(remoteId, run).params.environmentId).toBe(remoteId);

    expect(panel(remoteHome).surfaces).toEqual([CREW_BOARD_SURFACE]);
    expect(panel().surfaces).toEqual([{ id: "diff", kind: "diff" }]);
  });

  it("falls back to the full page when the run has no home thread", () => {
    useRightPanelStore.getState().open(home, "diff");
    const before = useRightPanelStore.getState();

    expect(openCrewBoard(environmentId, { ...run, homeThreadId: null })).toEqual({
      to: "/crews/$environmentId/$runId",
      params: { environmentId, runId: run.runId },
    });
    expect(useRightPanelStore.getState()).toBe(before);
  });

  it("hides and reopens without losing the selected board or other tabs", () => {
    const panels = useRightPanelStore.getState();
    panels.open(home, "diff");
    openCrewBoard(environmentId, run);
    panels.toggle(home, "crew-board");

    expect(panel().isOpen).toBe(false);
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, home),
    ).toBeNull();
    panels.toggle(home, "crew-board");
    expect(panel().isOpen).toBe(true);
    expect(panel().surfaces.map((surface) => surface.id)).toEqual(["diff", "crew-board"]);
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, home)).toEqual(
      CREW_BOARD_SURFACE,
    );
  });

  it("preserves the board and active selection through panel migration and reload", async () => {
    const panels = useRightPanelStore.getState();
    panels.open(home, "diff");
    openCrewBoard(environmentId, run);
    const saved = JSON.parse(
      JSON.stringify({ byThreadKey: useRightPanelStore.getState().byThreadKey }),
    );
    const migrated = migratePersistedRightPanelState(saved);
    expect(migrated.byThreadKey[scopedThreadKey(home)]).toMatchObject(panel());

    const { storage, name, version } = useRightPanelStore.persist.getOptions();
    useRightPanelStore.setState({ byThreadKey: {} });
    await storage!.setItem(name!, { state: migrated, version: version ?? 0 });
    await useRightPanelStore.persist.rehydrate();
    expect(panel().activeSurfaceId).toBe("crew-board");
    expect(panel().surfaces.map((surface) => surface.id)).toEqual(["diff", "crew-board"]);
  });

  it("closes to the neighboring tab and restores from migrated closed-view history", async () => {
    const panels = useRightPanelStore.getState();
    panels.open(home, "diff");
    openCrewBoard(environmentId, run);
    panels.closeSurface(home, "crew-board");
    expect(panel().activeSurfaceId).toBe("diff");
    const entries = useClosedViewStore.getState().entries;
    expect(entries).toMatchObject([
      { kind: "panel-tab", threadRef: home, surface: CREW_BOARD_SURFACE },
    ]);

    const { storage, name } = useClosedViewStore.persist.getOptions();
    useClosedViewStore.setState({ entries: [] });
    await storage!.setItem(name!, { state: { entries }, version: 1 });
    await useClosedViewStore.persist.rehydrate();
    expect(useClosedViewStore.getState().entries).toEqual(entries);
    const openPreview = vi.fn<Parameters<typeof reopenClosedView>[1]["openPreview"]>();
    expect(
      await reopenClosedView(useClosedViewStore.getState().entries[0]!, {
        openPreview,
        workspaceAvailable: false,
      }),
    ).toBe(true);
    expect(openPreview).not.toHaveBeenCalled();
    expect(panel().activeSurfaceId).toBe("crew-board");
    expect(panel().surfaces.map((surface) => surface.id)).toEqual(["diff", "crew-board"]);
  });
});
