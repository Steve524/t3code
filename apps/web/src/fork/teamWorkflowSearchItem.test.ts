import { expect, it } from "vite-plus/test";

import { searchSettings } from "../components/settings/settingsSearch";

it("finds Team Workflow settings", () => {
  expect(searchSettings("workflow preset")[0]).toMatchObject({
    id: "team-workflows",
    to: "/settings/workflows",
    scope: "environment",
  });
});
