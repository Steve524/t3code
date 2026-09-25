// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { createAttachmentId } from "../../../attachmentStore.ts";

export type ArtifactKind = "plan" | "research" | "review";
export type NotesDestination =
  | { readonly kind: "temporary" }
  | { readonly kind: "custom"; readonly directory: string }
  | { readonly kind: "project" };

const shortHash = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 16);

function notesPath(input: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly projectRoot: string;
  readonly title: string;
  readonly kind: ArtifactKind;
  readonly destination: NotesDestination;
  readonly date: string;
}) {
  const temporaryDir = NodePath.join(
    NodeOS.tmpdir(),
    "t3-plan-loop",
    shortHash(input.environmentId),
    shortHash(input.threadId),
  );
  const directory =
    input.destination.kind === "custom"
      ? NodePath.resolve(input.projectRoot, input.destination.directory)
      : input.destination.kind === "project" && input.kind === "research"
        ? NodePath.join(input.projectRoot, "docs", "research")
        : temporaryDir;
  const slug =
    input.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "research";
  const fileName =
    input.kind === "plan"
      ? "PLAN.md"
      : input.kind === "review"
        ? "review-log.md"
        : input.destination.kind === "project"
          ? `${input.date.slice(0, 10)}-${slug}-claudex-research.md`
          : "research-brief.md";
  return { directory, fileName, temporary: directory === temporaryDir };
}

async function writeWithoutOverwrite(
  directory: string,
  fileName: string,
  content: string,
  suffix: string,
) {
  await NodeFSP.mkdir(directory, { recursive: true });
  const extension = NodePath.extname(fileName);
  const stem = fileName.slice(0, -extension.length);
  for (let attempt = 0; attempt < 100; attempt++) {
    const name =
      attempt === 0
        ? fileName
        : `${stem}-${suffix}${attempt === 1 ? "" : `-${attempt}`}${extension}`;
    const target = NodePath.join(directory, name);
    try {
      await NodeFSP.writeFile(target, content, { flag: "wx" });
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not find a free artifact filename.");
}

export async function writeTeamArtifact(input: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly projectRoot: string;
  readonly title: string;
  readonly kind: ArtifactKind;
  readonly destination: NotesDestination;
  readonly content: string;
  readonly attachmentsDir: string;
  readonly date: string;
}) {
  const attachmentId = createAttachmentId(input.threadId, "md");
  if (attachmentId === null) throw new Error("Could not create an artifact attachment ID.");
  const { directory, fileName, temporary } = notesPath(input);
  await NodeFSP.mkdir(input.attachmentsDir, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(input.attachmentsDir, `${attachmentId}.md`),
    input.content,
    {
      flag: "wx",
    },
  );
  const exportedPath = await writeWithoutOverwrite(
    directory,
    fileName,
    input.content,
    attachmentId.slice(-11, -3),
  );
  return {
    artifactId: attachmentId,
    sha256: NodeCrypto.createHash("sha256").update(input.content).digest("hex"),
    path: exportedPath,
    temporary,
    attachment: {
      _tag: "attachment" as const,
      attachmentId,
      fileName: NodePath.basename(exportedPath),
      mimeType: "text/markdown" as const,
    },
  };
}
