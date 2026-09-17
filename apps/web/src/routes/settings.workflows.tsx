import { createFileRoute } from "@tanstack/react-router";

import { WorkflowsSettingsPanel } from "../components/settings/WorkflowsSettings";

export const Route = createFileRoute("/settings/workflows")({
  component: WorkflowsSettingsPanel,
});
