import { createFileRoute } from "@tanstack/react-router";

import { WorkflowsSettingsPanel } from "../fork/components/settings/WorkflowsSettings";

export const Route = createFileRoute("/settings/workflows")({
  component: WorkflowsSettingsPanel,
});
