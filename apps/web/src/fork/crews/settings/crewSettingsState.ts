import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import { useContext, useMemo } from "react";

import { createCrewCatalogAtoms } from "../../../../../../packages/client-runtime/src/fork/crews/catalog";
import { connectionAtomRuntime } from "../../../connection/runtime";
import type { ScopedSettingsTarget } from "../../../components/settings/scopedSettings";
import { crewOverrideScope } from "./crewsSettings.logic";

export const crewCatalog = createCrewCatalogAtoms(connectionAtomRuntime);

export function useCrewSettingsState(
  targets: readonly ScopedSettingsTarget[],
  crewId: string | null,
) {
  const registry = useContext(RegistryContext);
  const snapshots = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          targets.map((target) => {
            const { environmentId, projectId } = target;
            const input = projectId === null ? {} : { projectId };
            const list = get(crewCatalog.crewsLive({ environmentId, input }));
            const installed =
              crewId !== null &&
              Option.getOrNull(AsyncResult.value(list))?.some((crew) => crew.id === crewId);
            return {
              target,
              list,
              detail: installed
                ? get(crewCatalog.detail({ environmentId, input: { ...input, crewId } }))
                : null,
              overrides: get(
                crewCatalog.overrides({ environmentId, input: crewOverrideScope(projectId) }),
              ),
              toolbox:
                projectId === null
                  ? null
                  : get(crewCatalog.toolbox({ environmentId, input: { projectId } })),
              canSet: get(crewCatalog.setRoleOverride.permissionAtom(environmentId)),
              canSetMode: get(crewCatalog.setToolboxMode.permissionAtom(environmentId)),
            };
          }),
        ),
      [targets, crewId],
    ),
  );
  const refresh = () => {
    for (const { environmentId, projectId } of targets) {
      const input = projectId === null ? {} : { projectId };
      registry.refresh(crewCatalog.crewsLive({ environmentId, input }));
      registry.refresh(
        crewCatalog.overrides({ environmentId, input: crewOverrideScope(projectId) }),
      );
      if (crewId)
        registry.refresh(crewCatalog.detail({ environmentId, input: { ...input, crewId } }));
      if (projectId) registry.refresh(crewCatalog.toolbox({ environmentId, input: { projectId } }));
    }
  };
  return { snapshots, refresh };
}

export type CrewSettingsSnapshot = ReturnType<typeof useCrewSettingsState>["snapshots"][number];
