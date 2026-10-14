// FORK: crews runs list and board route outlet.
import { createFileRoute } from "@tanstack/react-router";
import { CrewsPage } from "../fork/crews/board/CrewsPage";
export const Route = createFileRoute("/_chat/crews")({ component: CrewsPage });
