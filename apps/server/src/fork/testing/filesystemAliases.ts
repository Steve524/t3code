import type * as FileSystem from "effect/FileSystem";

// Mock realpath too: Windows file IDs may exceed Number.MAX_SAFE_INTEGER,
// so the scanner can identify a directory by its canonical path instead.
export const filesystemAliases = (fs: FileSystem.FileSystem, aliases: Record<string, string>) => ({
  ...fs,
  realPath: (path: string) => fs.realPath(aliases[path] ?? path),
});
