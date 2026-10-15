import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ProviderDriverKind } from "@t3tools/contracts";
import type { CrewSummary } from "@t3tools/contracts/fork/crews/crewFile";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback } from "react";

import type { ComposerCommandItem } from "../../../components/chat/ComposerCommandMenu";
import { useProject } from "../../../state/entities";
import { crewCatalog } from "../settings/crewSettingsState";
import { crewInitSlashCommands } from "./crewInit.logic";

const noCrews = Atom.make(null);
const NO_CREWS: ReadonlyArray<CrewSummary> = [];

/**
 * `/crew-init` entries for the composer's slash menu, given the provider that will run the turn.
 * Reads the project's live crew list, the same subscription a new draft's crew selector uses.
 */
export function useCrewInitCommands(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  crewThread: boolean,
) {
  const project = useProject(projectId ? scopeProjectRef(environmentId, projectId) : null);
  const hasProject = project !== null && project.isScratch !== true;
  const list = useAtomValue(
    hasProject && !crewThread && projectId
      ? crewCatalog.crewsLive({ environmentId, input: { projectId } })
      : noCrews,
  );
  // A stable empty list keeps the callback, and the composer's menu memo, from changing each render.
  const crews = (list && Option.getOrNull(AsyncResult.value(list))) ?? NO_CREWS;
  return useCallback(
    (
      driver: ProviderDriverKind,
    ): Array<Extract<ComposerCommandItem, { type: "provider-slash-command" }>> =>
      crewInitSlashCommands({ driver, hasProject, crewThread }, crews).map((command) => ({
        id: `fork:${command.name}`,
        type: "provider-slash-command",
        provider: driver,
        command,
        label: `/${command.name}`,
        description: command.description,
      })),
    [hasProject, crewThread, crews],
  );
}
