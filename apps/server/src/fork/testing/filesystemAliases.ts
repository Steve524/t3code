import type * as FileSystem from "effect/FileSystem";
import type { AgentSessionImportSource } from "@t3tools/contracts";
import { windowsHost } from "./platformFixtures.ts";

// Mock realpath too: Windows file IDs may exceed Number.MAX_SAFE_INTEGER,
// so the scanner can identify a directory by its canonical path instead.
export const filesystemAliases = (fs: FileSystem.FileSystem, aliases: Record<string, string>) => ({
  ...fs,
  realPath: (path: string) => fs.realPath(aliases[path] ?? path),
});

// This fixture requires distinct identities. NTFS can preserve creation time,
// while Effect omits oversized inode IDs, so supply the old ID explicitly.
export const replacementBaseline = (source: AgentSessionImportSource) =>
  windowsHost && source.inode === null ? { ...source, inode: 1 } : source;
