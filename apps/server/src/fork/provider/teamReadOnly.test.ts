import { describe, expect, it } from "vite-plus/test";

import { isolatedReadOnlyTask, readOnlyApprovalDecision, withPlanText } from "./teamReadOnly.ts";

describe("readOnlyApprovalDecision", () => {
  it("accepts tools that only read the disk or the web", () => {
    for (const detail of [
      'Read: {"file_path":"C:\\\\outside\\\\notes.md"}',
      'Glob: {"pattern":"**/*.md"}',
      'Grep: {"pattern":"TODO"}',
      'WebSearch: {"query":"node:test docs"}',
      'WebFetch: {"url":"https://nodejs.org/api/test.html"}',
    ]) {
      expect(readOnlyApprovalDecision(detail)).toBe("accept");
    }
  });

  it("declines writes, shell commands and anything it doesn't recognise", () => {
    for (const detail of [
      'Write: {"file_path":"probe-edit.txt","content":"edit"}',
      'Edit: {"file_path":"src/cli.js"}',
      "Bash: node -e \"require('fs').writeFileSync('probe-shell.txt','shell')\"",
      'NotebookEdit: {"notebook_path":"a.ipynb"}',
      'mcp__t3-code__preview_click: {"locator":"text=Send"}',
      "C:\\repo\\screenshot.png",
      "Create probe-subagent.txt",
      "ReadWrite: {}",
      "",
      undefined,
      42,
    ]) {
      expect(readOnlyApprovalDecision(detail)).toBe("decline");
    }
  });
});

describe("isolated read-only task text", () => {
  it("says what the worker can't see and appends the plan", () => {
    const task = withPlanText(isolatedReadOnlyTask("Review the plan.", "feature/plan"), {
      path: "docs/plans/p.md",
      text: "# Plan",
    });
    expect(
      task.startsWith("Review the plan.\n\n---\nYou run in an isolated worktree of `feature/plan`"),
    ).toBe(true);
    expect(task).toContain("uncommitted files aren't here");
    expect(task.endsWith("The file isn't in your worktree, so review this text:\n\n# Plan")).toBe(
      true,
    );
  });
});
