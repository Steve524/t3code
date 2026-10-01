// @effect-diagnostics nodeBuiltinImport:off - Synchronous host-path parsing for test fixture output.
import * as NodePath from "node:path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Schema from "effect/Schema";

export const windowsHost = HostProcessPlatform.defaultValue() === "win32";
// Match the server suite's existing budget for real Git subprocesses on Windows.
export const gitIntegrationTimeout = (milliseconds: number) =>
  windowsHost ? 120_000 : milliseconds;
export const fixturePlatform = windowsHost ? "win32" : "linux";
export const pathWithSlashes = (path: string) => path.replace(/\\+/g, "/");
export const runtimeFixtureVersion = (command: string) =>
  NodePath.basename(NodePath.dirname(command));
export const joinFixtureSearchPath = (...paths: string[]) => paths.join(windowsHost ? ";" : ":");
export const quoteFixtureString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
export const screenshotMetadata = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ screenshotPath: Schema.String })),
);

// These fixture paths have no systemd specifiers; JSON quoting covers their backslashes/spaces.
export const systemdFixtureArgument = (path: string) =>
  /[\s"\\]/.test(path) ? quoteFixtureString(path) : path;

export const runtimeTempDirectory = (env: NodeJS.ProcessEnv | undefined) =>
  windowsHost ? env?.TEMP : env?.TMPDIR;
