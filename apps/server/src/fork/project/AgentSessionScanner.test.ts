import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AgentSessionImportSource } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../../config.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as AgentSessionScanner from "../../project/AgentSessionScanner.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  windowsDirectoryIdentity,
  withWindowsFileIdentity,
  sameWindowsFileIdentity,
} from "./windowsFileIdentity.ts";

const encodeRecord = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const sourceJson = Schema.fromJsonString(AgentSessionImportSource);

it.effect(
  "detects replaced Windows transcripts when numeric inode and creation time cannot distinguish them",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-scanner-file-id-" });
      const workspace = path.join(root, "workspace");
      const codexHome = path.join(root, "codex");
      const filePath = path.join(
        codexHome,
        "sessions",
        "2026",
        "08",
        "24",
        "rollout-session.jsonl",
      );
      const now = Date.parse("2026-08-24T12:00:00.000Z");
      yield* TestClock.setTime(now);
      yield* fs.makeDirectory(workspace);
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      const write = (id: string) =>
        fs
          .writeFileString(
            filePath,
            [
              encodeRecord({ type: "session_meta", payload: { id, cwd: workspace } }),
              encodeRecord({
                type: "event_msg",
                payload: { type: "user_message", message: "Read me" },
              }),
            ].join("\n"),
          )
          .pipe(Effect.andThen(fs.utimes(filePath, now / 1000, now / 1000)));
      yield* write("original-session");

      // Effect drops oversized inode numbers; NTFS can reuse a deleted file's birth time.
      const missingIdentity = (info: FileSystem.File.Info) => ({
        ...info,
        ino: Option.none<number>(),
        birthtime: Option.some(DateTime.toDateUtc(DateTime.makeUnsafe(now))),
      });
      const fileSystem = FileSystem.FileSystem.of({
        ...fs,
        stat: (target) =>
          fs
            .stat(target)
            .pipe(Effect.map((info) => (target === filePath ? missingIdentity(info) : info))),
        open: (target, options) =>
          fs.open(target, options).pipe(
            Effect.map((file) =>
              target !== filePath
                ? file
                : {
                    ...file,
                    stat: file.stat.pipe(Effect.map(missingIdentity)),
                    readAlloc: (size: number) => file.readAlloc(size),
                  },
            ),
          ),
      });
      yield* Effect.gen(function* () {
        const scanner = yield* AgentSessionScanner.AgentSessionScanner;
        const first = (yield* scanner.recentThreads(workspace).pipe(Stream.runCollect))[0];
        expect(first?._tag).toBe("Importable");
        if (first?._tag !== "Importable") return;
        // Exercise the persisted contract, not just an in-memory object with extra fields.
        const source = yield* Schema.decodeUnknownEffect(sourceJson)(
          yield* Schema.encodeEffect(sourceJson)(first.source),
        );
        const unchanged = yield* scanner.recentThreads(workspace, [source]).pipe(Stream.runCollect);
        expect(unchanged[0]?._tag).toBe("AlreadyImported");
        const originalHandle = yield* fs.open(filePath);
        yield* fs.remove(filePath);
        yield* write("replaced-session");
        const replaced = yield* scanner.recentThreads(workspace, [source]).pipe(Stream.runCollect);
        expect(replaced[0]).toMatchObject({
          _tag: "Importable",
          thread: { providerSessionId: "replaced-session" },
          source: {
            size: source.size,
            mtimeMs: source.mtimeMs,
            inode: null,
            birthtimeMs: source.birthtimeMs,
          },
        });
        expect(
          sameWindowsFileIdentity(source, yield* withWindowsFileIdentity(source, originalHandle)),
        ).toBe(true);
        expect(sameWindowsFileIdentity(source, yield* withWindowsFileIdentity(source))).toBe(false);
        const { windowsFileId: _, ...legacySource } = source;
        const legacy = yield* scanner
          .recentThreads(workspace, [legacySource])
          .pipe(Stream.runCollect);
        expect(legacy[0]?._tag).toBe("Importable");
      }).pipe(
        Effect.provide(
          AgentSessionScanner.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                ServerSettings.layerTest({
                  providers: {
                    codex: { homePath: codexHome },
                    claudeAgent: { homePath: path.join(root, "claude") },
                  },
                }),
                ServerConfig.layerTest(root, path.join(root, "t3")),
                Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({}),
              ),
            ),
          ),
        ),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(HostProcessPlatform, "win32"),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps different directories distinct even when their fallback keys collide", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const first = yield* fs.makeTempDirectoryScoped({ prefix: "t3-scanner-first-" });
    const second = yield* fs.makeTempDirectoryScoped({ prefix: "t3-scanner-second-" });
    const firstId = yield* windowsDirectoryIdentity(first, "path:repo");
    const secondId = yield* windowsDirectoryIdentity(second, "path:repo");
    expect(firstId).not.toBe(secondId);
    expect(yield* windowsDirectoryIdentity(first, "path:REPO")).toBe(firstId);
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.provideService(HostProcessPlatform, "win32"),
  ),
);
