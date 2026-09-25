import type { ProviderDriverKind } from "@t3tools/contracts";

export function planLoopSlashCommandItems(
  protocolId: string | undefined,
  provider: ProviderDriverKind,
) {
  if (protocolId !== "t3-plan-loop") return [];
  return [
    {
      id: "fork:t3-plan-loop",
      type: "provider-slash-command" as const,
      provider,
      command: {
        name: "t3-plan-loop",
        description: "Start or resume research and plan review",
      },
      label: "/t3-plan-loop",
      description: "Start or resume research and plan review",
    },
  ];
}
