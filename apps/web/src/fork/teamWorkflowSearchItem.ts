export const TEAM_WORKFLOW_SEARCH_ITEM = {
  id: "team-workflows",
  title: "Team workflows",
  to: "/settings/workflows",
  scope: "environment",
  environmentOnly: true,
  searchTerms: [
    "orchestrator preset roles workers provider model effort permissions review parallel automatic updates",
  ],
} as const;
