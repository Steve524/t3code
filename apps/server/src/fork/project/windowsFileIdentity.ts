// @effect-diagnostics nodeBuiltinImport:off - Effect omits inode IDs above Number.MAX_SAFE_INTEGER.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";
import type { AgentSessionImportSource } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

const fstat = NodeUtil.promisify(NodeFS.fstat);
const readFileId = (target: string | number) =>
  Effect.tryPromise(() =>
    typeof target === "string"
      ? NodeFSP.stat(target, { bigint: true })
      : fstat(target, { bigint: true }),
  ).pipe(
    Effect.map((info) => (info.ino > 0n ? `${info.dev}:${info.ino}` : null)),
    Effect.orElseSucceed(() => null),
  );

export const windowsDirectoryIdentity = Effect.fnUntraced(function* (
  realPath: string,
  fallback: string,
) {
  if ((yield* HostProcessPlatform) !== "win32") return fallback;
  const id = yield* readFileId(realPath);
  return id === null ? fallback : `inode:${id}`;
});

export const withWindowsFileIdentity = Effect.fnUntraced(function* <
  T extends { readonly filePath: string; readonly inode: number | null },
>(identity: T, file?: FileSystem.File) {
  if (
    (yield* HostProcessPlatform) !== "win32" ||
    (identity.inode !== null && Number.isSafeInteger(identity.inode) && identity.inode > 0)
  ) {
    return identity;
  }
  // Read the open descriptor during validation, so a path replacement cannot disguise it.
  // Node's implementation exposes fd; an alternate filesystem must fail closed here.
  const target =
    file === undefined
      ? identity.filePath
      : "fd" in file && typeof file.fd === "number"
        ? file.fd
        : null;
  const windowsFileId = target === null ? null : yield* readFileId(target);
  return { ...identity, windowsFileId };
});

export const sameWindowsFileIdentity = (
  left: Pick<AgentSessionImportSource, "filePath" | "windowsFileId">,
  right: Pick<AgentSessionImportSource, "filePath" | "windowsFileId">,
) =>
  left.windowsFileId !== null &&
  right.windowsFileId !== null &&
  left.windowsFileId === right.windowsFileId;
