import { useAtomValue } from "@effect/atom-react";
import { crewRunActivity } from "@t3tools/client-runtime/fork/crews/runs";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { UsersIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../../components/ui/tooltip";
import { Button } from "../../../components/ui/button";
import { useMemo } from "react";
import type { ComposerBannerStackItem } from "../../../components/chat/ComposerBannerStack";
import type { CommandPaletteActionItem } from "../../../components/CommandPalette.logic";
import {
  ComposerControl,
  ComposerControlIcon,
  type ComposerControlSize,
} from "../../../components/chat/ComposerControl";
import { crewThreadIndexAtom, useCrewLive } from "./crewBoardState";
import { CrewBannerGates } from "./CrewControls";
import { openCrewBoard } from "./openCrewBoard";

export function useCrewBanner(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
): ComposerBannerStackItem[] {
  const navigate = useNavigate();
  const { view } = useCrewLive(environmentId, threadId ? { threadId } : null);
  return useMemo(() => {
    if (!view) return [];
    const activity = crewRunActivity(view);
    const deciding = view.cards.filter((card) => card.lane === "waiting_lead").length;
    return [
      {
        id: `crew:${view.runId}`,
        variant: activity.needsYou ? "warning" : "info",
        priority: activity.needsYou ? "urgent" : "notice",
        icon: <UsersIcon />,
        title: `Crew · ${view.crewName} · ${activity.working} working · ${activity.needsYou} needs you`,
        description: deciding
          ? `${view.roles.find((role) => role.id === view.leadRoleId)?.name ?? "Lead"} is deciding (${deciding})`
          : view.status,
        actions: (
          <Button
            size="xs"
            variant="outline"
            onClick={() => void navigate(openCrewBoard(environmentId, view))}
          >
            Open board
          </Button>
        ),
        children: <CrewBannerGates environmentId={environmentId} view={view} />,
      },
    ];
  }, [environmentId, navigate, view]);
}

export function CrewSidebarBadge({ thread }: { thread: { environmentId: string; id: string } }) {
  const entry = useAtomValue(crewThreadIndexAtom).get(`${thread.environmentId}:${thread.id}`);
  if (!entry?.home) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground" />
        }
      >
        <UsersIcon aria-hidden="true" className="size-3" />
        <span className="sr-only">Crew: {entry.run.crewName}</span>
      </TooltipTrigger>
      <TooltipPopup>Crew: {entry.run.crewName}</TooltipPopup>
    </Tooltip>
  );
}

export function useCrewPaletteItems(
  thread: { environmentId: EnvironmentId; id: ThreadId } | null | undefined,
) {
  const navigate = useNavigate();
  const { view } = useCrewLive(
    thread?.environmentId ?? null,
    thread ? { threadId: thread.id } : null,
  );
  const items: CommandPaletteActionItem[] = [
    {
      kind: "action",
      value: "crew:settings",
      title: "Crew settings",
      searchTerms: ["crews", "roles", "models"],
      icon: <UsersIcon />,
      run: async () => {
        await navigate({ to: "/settings/crews" });
      },
    },
    {
      kind: "action",
      value: "crew:runs",
      title: "Crew runs",
      searchTerms: ["crews", "board"],
      icon: <UsersIcon />,
      run: async () => {
        await navigate({ to: "/crews" });
      },
    },
  ];
  if (thread && view)
    items.push({
      kind: "action",
      value: "crew:board",
      title: "Open crew board",
      searchTerms: ["crew", view.crewName],
      icon: <UsersIcon />,
      run: async () => {
        await navigate(openCrewBoard(thread.environmentId, view));
      },
    });
  return items;
}

export function CrewThreadComposerControl({
  environmentId,
  threadId,
  size,
  hidden,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  size: ComposerControlSize;
  hidden: boolean;
}) {
  const { view } = useCrewLive(environmentId, { threadId });
  const navigate = useNavigate();
  if (!view) return null;
  const activity = crewRunActivity(view);
  return (
    <ComposerControl
      size={size}
      aria-label={`Open ${view.crewName} board`}
      aria-hidden={hidden || undefined}
      tabIndex={hidden ? -1 : undefined}
      onClick={() => void navigate(openCrewBoard(environmentId, view))}
    >
      <ComposerControlIcon icon={UsersIcon} size={size} />
      <span className="min-w-0 max-w-64 truncate">
        {view.crewName} · {activity.working} working · {activity.needsYou} needs you
      </span>
    </ComposerControl>
  );
}
