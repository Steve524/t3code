// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { resolveAttachmentPathById } from "../../../attachmentStore.ts";
import { writeTeamArtifact } from "./artifacts.ts";

describe("team artifact export", () => {
  it("preserves content, custom paths with spaces, and colliding filenames", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "team-artifact-test-"));
    try {
      const input = {
        environmentId: "environment-a",
        threadId: "thread-a",
        projectRoot: root,
        title: "Research notes",
        kind: "research" as const,
        destination: { kind: "custom" as const, directory: "notes with spaces" },
        content: `## Key Takeaways\n\n${"source".repeat(2_000)}\n`,
        attachmentsDir: NodePath.join(root, "attachments"),
        date: "2026-09-25T10:00:00.000Z",
      };
      const first = await writeTeamArtifact(input);
      const second = await writeTeamArtifact(input);
      expect(first.path).not.toBe(second.path);
      expect(NodePath.dirname(first.path)).toBe(NodePath.join(root, "notes with spaces"));
      expect(await NodeFSP.readFile(first.path, "utf8")).toBe(input.content);
      expect(await NodeFSP.readFile(second.path, "utf8")).toBe(input.content);
      expect(
        await NodeFSP.readFile(
          NodePath.join(input.attachmentsDir, `${first.attachment.attachmentId}.md`),
          "utf8",
        ),
      ).toBe(input.content);
      expect(
        resolveAttachmentPathById({
          attachmentsDir: input.attachmentsDir,
          attachmentId: first.attachment.attachmentId,
        }),
      ).toBe(NodePath.join(input.attachmentsDir, `${first.attachment.attachmentId}.md`));
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("uses the project research filename only for the brief", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "team-project-notes-test-"));
    try {
      const result = await writeTeamArtifact({
        environmentId: "environment-a",
        threadId: "thread-a",
        projectRoot: root,
        title: "Planning a Search Feature",
        kind: "research",
        destination: { kind: "project" },
        content: "## Key Takeaways\n",
        attachmentsDir: NodePath.join(root, "attachments"),
        date: "2026-09-25T10:00:00.000Z",
      });
      expect(result.path).toBe(
        NodePath.join(
          root,
          "docs",
          "research",
          "2026-09-25-planning-a-search-feature-claudex-research.md",
        ),
      );
      expect(result.temporary).toBe(false);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
