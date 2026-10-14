import type { ScopedThreadRef } from "@t3tools/contracts";
import type { RightPanelSurface } from "../../../rightPanelStore";
import { CrewBoard } from "./CrewBoard";

export function CrewBoardPanel({
  surface,
  threadRef,
}: {
  surface: RightPanelSurface | null;
  threadRef: ScopedThreadRef;
}) {
  if (surface?.kind !== "crew-board") return null;
  return (
    <CrewBoard
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      environmentId={threadRef.environmentId}
      threadId={threadRef.threadId}
    />
  );
}
