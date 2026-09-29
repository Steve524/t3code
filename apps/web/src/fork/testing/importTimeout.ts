import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

// The cold timeline import takes ~55s on Windows; its assertions take only seconds.
export const timelineImportTimeout =
  HostProcessPlatform.defaultValue() === "win32" ? 120_000 : 30_000;
