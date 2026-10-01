import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

// ponytail: serialize Windows imports to avoid pool startup timeouts; raise the limit once reliable.
export const windowsTestWorkers =
  HostProcessPlatform.defaultValue() === "win32" ? { maxWorkers: 1 } : {};
