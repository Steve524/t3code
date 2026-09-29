import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { windowsSystemTar } from "../build-cli-archive.ts";

// Git Bash's GNU tar treats a drive letter as a remote host.
export const archiveTestCommand = (command: string) =>
  command === "tar" && HostProcessPlatform.defaultValue() === "win32"
    ? windowsSystemTar()
    : command;

export const archiveListingLines = (stdout: string) => stdout.split(/\r?\n/);
