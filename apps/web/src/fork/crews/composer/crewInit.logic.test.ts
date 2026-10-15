import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { useComposerDraftStore } from "../../../composerDraftStore";
import {
  CREW_INIT_UNREACHABLE,
  crewInitAvailability,
  crewInitBlockReason,
  crewInitDraftPrompt,
  crewInitSlashCommands,
  expandCrewInitCommand,
  parseCrewInitCommand,
} from "./crewInit.logic";
import { placeCrewInitPrompt } from "./openCrewInitDraft";

const codex = ProviderDriverKind.make("codex");
const unknownDriver = ProviderDriverKind.make("someNewDriver");
const crews = [
  { id: "feature-trio", name: "Feature trio", status: "warnings" as const },
  { id: "bugfix-duo", name: "Bugfix duo", status: "ok" as const },
];

describe("/crew-init in the composer", () => {
  it("sends the short instruction instead of the typed command", () => {
    const command = parseCrewInitCommand("/crew-init feature-trio");
    expect(command).toEqual({ crewIds: ["feature-trio"], note: "" });
    expect(expandCrewInitCommand(command!)).toBe(
      [
        "/crew-init feature-trio",
        "",
        'Run the T3 skill "crew-init". Load its instructions with the t3_skill_get tool',
        '(name: "crew-init") and follow them. Arguments: feature-trio',
      ].join("\n"),
    );
    expect(expandCrewInitCommand(parseCrewInitCommand("/crew-init")!)).toContain("Arguments: none");
  });

  it("keeps extra lines as a note and expands only once", () => {
    const command = parseCrewInitCommand("/crew-init a b\nuse pnpm test:unit\nskip storybook");
    expect(command).toEqual({ crewIds: ["a", "b"], note: "use pnpm test:unit\nskip storybook" });
    const expanded = expandCrewInitCommand(command!);
    expect(expanded.endsWith("\n\nuse pnpm test:unit\nskip storybook")).toBe(true);
    expect(parseCrewInitCommand(expanded)).toBeNull();
    expect(parseCrewInitCommand("/crew-initialize")).toBeNull();
    expect(parseCrewInitCommand("please /crew-init")).toBeNull();
  });

  it("AC 13 offers the command per provider and hides it in crew threads and without a project", () => {
    expect(crewInitAvailability({ driver: codex, hasProject: true, crewThread: false })).toEqual({
      visible: true,
      disabledReason: null,
    });
    expect(
      crewInitAvailability({ driver: unknownDriver, hasProject: true, crewThread: false }),
    ).toEqual({ visible: true, disabledReason: CREW_INIT_UNREACHABLE });
    expect(
      crewInitAvailability({ driver: codex, hasProject: true, crewThread: true }).visible,
    ).toBe(false);
    expect(
      crewInitAvailability({ driver: codex, hasProject: false, crewThread: false }).visible,
    ).toBe(false);
  });

  it("completes crew ids, and lists only the disabled reason when the provider can't reach T3 tools", () => {
    expect(
      crewInitSlashCommands({ driver: codex, hasProject: true, crewThread: false }, crews),
    ).toEqual([
      { name: "crew-init", description: "Set up this repo's .t3 toolbox for crews" },
      { name: "crew-init feature-trio", description: "Set up Feature trio (warnings here)" },
      { name: "crew-init bugfix-duo", description: "Set up Bugfix duo" },
    ]);
    expect(
      crewInitSlashCommands({ driver: unknownDriver, hasProject: true, crewThread: false }, crews),
    ).toEqual([{ name: "crew-init", description: CREW_INIT_UNREACHABLE }]);
    expect(
      crewInitSlashCommands({ driver: codex, hasProject: true, crewThread: true }, crews),
    ).toEqual([]);
  });

  it("blocks a typed command where it cannot run", () => {
    expect(crewInitBlockReason({ driver: codex, hasProject: true })).toBeNull();
    expect(crewInitBlockReason({ driver: codex, hasProject: false })).toMatch(/project/u);
    expect(crewInitBlockReason({ driver: unknownDriver, hasProject: true })).toBe(
      `${CREW_INIT_UNREACHABLE}.`,
    );
  });
});

describe("Set up with /crew-init", () => {
  const target = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("new-draft"));
  afterEach(() => useComposerDraftStore.getState().setPrompt(target, ""));

  it("AC 16 puts /crew-init <crew> in the new draft's composer", () => {
    expect(crewInitDraftPrompt("feature-trio")).toBe("/crew-init feature-trio");
    expect(crewInitDraftPrompt(null)).toBe("/crew-init");
    expect(placeCrewInitPrompt(target, crewInitDraftPrompt("feature-trio"))).toBe(true);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
      "/crew-init feature-trio",
    );
  });

  it("keeps text the user already typed in that draft", () => {
    useComposerDraftStore.getState().setPrompt(target, "half-written brief");
    expect(placeCrewInitPrompt(target, "/crew-init feature-trio")).toBe(false);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
      "half-written brief",
    );
  });
});
