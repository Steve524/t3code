export { UsersRoundIcon as CrewSettingsIcon } from "lucide-react";

export const CREW_SETTINGS_PATH = "/settings/crews";
export const CREW_SETTINGS_LABELS = { [CREW_SETTINGS_PATH]: "Crews" };
export const CREW_SETTINGS_SEARCH_ITEMS = [
  {
    id: "crews",
    title: "Crews",
    to: CREW_SETTINGS_PATH,
    scope: "project-defaults",
    searchTerms: ["roles models instructions toolbox skills MCP tools overrides secrets crew-init"],
  },
] as const;
