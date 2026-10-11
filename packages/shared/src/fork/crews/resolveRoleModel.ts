import type { CrewFile } from "../../../../contracts/src/fork/crews/crewFile.ts";
import type {
  ResolvedRoleModel,
  ResolvedRoleRuntimeMode,
} from "../../../../contracts/src/fork/crews/crewModel.ts";
import type { ModelSelection } from "../../../../contracts/src/modelSelection.ts";
import type {
  ProviderDriverKind,
  ProviderInstanceId,
} from "../../../../contracts/src/providerInstance.ts";
import type { RuntimeMode } from "../../../../contracts/src/providerPolicy.ts";

/** A provider instance that can run a role right now. Callers pass them in model-picker order. */
export interface CrewUsableProvider {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly models: ReadonlyArray<string>;
}

export interface CrewRoleModelInput {
  readonly runOverride?: ModelSelection | null | undefined;
  readonly projectOverride?: ModelSelection | null | undefined;
  readonly environmentOverride?: ModelSelection | null | undefined;
  readonly composerSelection?: ModelSelection | null | undefined;
  readonly providers: ReadonlyArray<CrewUsableProvider>;
}

/** First usable wins: run, project, environment, crew hint, then the composer's selection. */
export function resolveRoleModel(
  crew: CrewFile,
  roleId: string,
  input: CrewRoleModelInput,
): ResolvedRoleModel {
  const warnings: string[] = [];
  // A provider that advertises no models accepts any, as delegated tasks do.
  const offers = (instanceId: string, model: string) =>
    input.providers.some(
      (provider) =>
        provider.instanceId === instanceId &&
        (provider.models.length === 0 || provider.models.includes(model)),
    );
  for (const [source, selection] of [
    ["run", input.runOverride],
    ["project", input.projectOverride],
    ["environment", input.environmentOverride],
  ] as const) {
    if (!selection) continue;
    if (offers(selection.instanceId, selection.model)) return { selection, source, warnings };
    warnings.push(
      `The ${source} override ${selection.instanceId}/${selection.model} is not available; falling back.`,
    );
  }

  const hint = Object.hasOwn(crew.roles, roleId) ? crew.roles[roleId]?.model : undefined;
  if (hint) {
    const provider =
      (hint.instance !== undefined && offers(hint.instance, hint.model)
        ? input.providers.find((candidate) => candidate.instanceId === hint.instance)
        : undefined) ??
      input.providers.find(
        (candidate) => candidate.driver === hint.driver && candidate.models.includes(hint.model),
      );
    if (provider)
      return {
        selection: {
          instanceId: provider.instanceId,
          model: hint.model,
          ...(hint.options === undefined ? {} : { options: hint.options }),
        },
        source: "crew-hint",
        warnings,
      };
    warnings.push(
      `No available provider offers the crew's model hint ${hint.driver}/${hint.model}; falling back.`,
    );
  }
  return { selection: input.composerSelection ?? null, source: "composer", warnings };
}

const RUNTIME_MODE_RANK: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

export interface CrewRoleRuntimeModeInput {
  readonly runOverride?: RuntimeMode | null | undefined;
  readonly projectOverride?: RuntimeMode | null | undefined;
  readonly environmentOverride?: RuntimeMode | null | undefined;
  /** The mode the run was started with. Without it nothing is clamped and inherit stays "inherit". */
  readonly startingRuntimeMode?: RuntimeMode | undefined;
}

/**
 * Same order as the model. A mode from the crew file is clamped to the run's starting mode; an
 * override is the user raising it on purpose and is kept.
 */
export function resolveRoleRuntimeMode(
  crew: CrewFile,
  roleId: string,
  input: CrewRoleRuntimeModeInput,
): ResolvedRoleRuntimeMode {
  for (const [source, runtimeMode] of [
    ["run", input.runOverride],
    ["project", input.projectOverride],
    ["environment", input.environmentOverride],
  ] as const) {
    if (runtimeMode) return { runtimeMode, source, clamped: false };
  }
  const start = input.startingRuntimeMode;
  const role = Object.hasOwn(crew.roles, roleId) ? crew.roles[roleId] : undefined;
  const hint = role?.runtimeMode ?? crew.defaults?.runtimeMode;
  if (hint === undefined || hint === "inherit")
    return { runtimeMode: start ?? "inherit", source: "inherit", clamped: false };
  const clamped = start !== undefined && RUNTIME_MODE_RANK[hint] > RUNTIME_MODE_RANK[start];
  return { runtimeMode: clamped ? start : hint, source: "crew-hint", clamped };
}
