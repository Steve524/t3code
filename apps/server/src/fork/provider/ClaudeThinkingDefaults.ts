import type { ModelSelection, ProviderOptionDescriptor } from "@t3tools/contracts";
import { getModelSelectionBooleanOptionValue } from "@t3tools/shared/model";

/** Match the UI's Off default without disabling adaptive thinking on models without a toggle. */
export function resolveClaudeThinking(
  selection: ModelSelection | undefined,
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
) {
  const descriptor = descriptors.find(
    (option) => option.id === "thinking" && option.type === "boolean",
  );
  return descriptor?.type === "boolean"
    ? (getModelSelectionBooleanOptionValue(selection, "thinking") ??
        descriptor.currentValue ??
        false)
    : undefined;
}
