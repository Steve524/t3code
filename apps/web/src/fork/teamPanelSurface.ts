import { Users } from "lucide-react";

export function teamPanelSurfaceAction(
  available: boolean | undefined,
  onClick: (() => void) | undefined,
  disabledReason: string,
  badgeCount = 0,
) {
  return available && onClick
    ? [
        {
          label: "Team",
          icon: Users,
          shortcut: "W",
          available: true,
          disabledReason,
          onClick,
          badgeCount,
        },
      ]
    : [];
}
