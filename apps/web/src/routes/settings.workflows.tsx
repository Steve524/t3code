import { createFileRoute } from "@tanstack/react-router";

// FORK: File-router shim for Team Workflow settings.
import { WorkflowsSettingsPanel } from "../fork/components/settings/WorkflowsSettings";

export const Route = createFileRoute("/settings/workflows")({
  component: WorkflowsSettingsPanel,
});
