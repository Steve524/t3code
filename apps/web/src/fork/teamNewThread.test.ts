import { describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => {
  let storedDraft: {
    readonly draftId: string;
    readonly environmentId: string;
    readonly promotedTo: null;
    readonly threadId: string;
  } | null = null;
  const draftStore = {
    getComposerDraft: vi.fn(() => ({})),
    getDraftSessionByLogicalProjectKey: vi.fn(() => storedDraft),
    getDraftSession: vi.fn(() => null),
    getDraftThread: vi.fn(() => null),
    applyStickyState: vi.fn(),
    setDraftThreadContext: vi.fn(),
    setLogicalProjectDraftThreadId: vi.fn(),
    setModelSelection: vi.fn(),
  };
  const router = {
    state: { location: { href: "/" }, matches: [{ params: {} }] },
    navigate: vi.fn(async () => {}),
  };
  return {
    draftStore,
    router,
    reset(draft: typeof storedDraft) {
      storedDraft = draft;
      draftStore.setLogicalProjectDraftThreadId.mockClear();
      draftStore.setDraftThreadContext.mockClear();
      router.state.location.href = "/";
    },
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () =>
    new Map([
      [
        "environment-ssh",
        {
          settings: {
            defaultThreadEnvMode: "local",
            newWorktreesStartFromOrigin: false,
            defaultModelSelection: null,
            defaultRuntimeMode: "full-access",
          },
        },
      ],
    ]),
}));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopedProjectKey: () => "remote-project",
  scopeProjectRef: (environmentId: string, projectId: string) => ({ environmentId, projectId }),
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("@t3tools/contracts", () => ({ DEFAULT_SERVER_SETTINGS: {} }));
vi.mock("@t3tools/shared/projectSettings", () => ({
  resolveProjectSettings: (settings: Record<string, unknown>) => ({
    settings,
    sources: { defaultThreadEnvMode: "environment" },
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => null,
  useRouter: () => testState.router,
}));
vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("../components/Sidebar.logic", () => ({ orderItemsByPreferredIds: () => [] }));
vi.mock("../composerDraftStore", () => ({
  composerDraftHasUserContent: () => false,
  markPromotedDraftThreadByRef: vi.fn(),
  useComposerDraftStore: Object.assign(() => null, { getState: () => testState.draftStore }),
}));
vi.mock("../lib/chatThreadActions", () => ({
  hasExplicitComposerModelSelection: () => false,
  resolveNewDraftStartFromOrigin: () => false,
  resolveNewThreadModelSelectionOverride: () => null,
}));
vi.mock("../lib/t3ProjectFileDefaults", () => ({
  readT3ProjectFile: () => Promise.resolve(null),
}));
vi.mock("../lib/utils", () => ({
  newDraftId: () => "draft-team",
  newThreadId: () => "thread-team",
}));
vi.mock("../logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: () => "remote-project",
  getProjectOrderKey: () => "remote-project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../state/entities", () => ({
  readProjects: () => [
    {
      id: "project-remote",
      environmentId: "environment-ssh",
      workspaceRoot: "/remote/project",
    },
  ],
  readThreadShell: () => null,
  useProjects: () => [],
  useThread: () => null,
}));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../threadRoutes", () => ({ resolveThreadRouteTarget: () => null }));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "remote-project",
  useUiStateStore: () => [],
}));
vi.mock("../hooks/useSettings", () => ({ useClientSettings: () => ({}) }));

import { useNewThreadHandler } from "../hooks/useHandleNewThread";

describe.each([
  ["new", null],
  [
    "reusable",
    {
      draftId: "draft-existing",
      environmentId: "environment-ssh",
      promotedTo: null,
      threadId: "thread-existing",
    },
  ],
] as const)("Team Workflow with a %s draft", (_, draft) => {
  it("seeds the requested workflow when opening a thread", async () => {
    testState.reset(draft);
    const projectRef = { environmentId: "environment-ssh", projectId: "project-remote" } as never;
    const opened = await useNewThreadHandler()(projectRef, { teamWorkflowId: "full-stack-team" });

    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      projectRef,
      opened!.draftId,
      expect.objectContaining({ teamWorkflowId: "full-stack-team" }),
    );
  });
});
