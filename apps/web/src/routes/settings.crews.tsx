// FORK: crews settings route.
import { createFileRoute } from "@tanstack/react-router";
import { CrewsSettings } from "../fork/crews/settings/CrewsSettings";

export const Route = createFileRoute("/settings/crews")({ component: CrewsSettings });
