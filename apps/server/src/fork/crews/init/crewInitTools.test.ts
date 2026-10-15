import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

import { BUNDLED_SKILLS } from "../skills/bundledSkills.gen.ts";
import { makeStandaloneCrewInitTools, type CrewInitToolName } from "./standaloneTools.ts";

const TOKEN = "ghp_EXAMPLE_NOT_A_REAL_TOKEN_0123456789";
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const scratchProject = ProjectId.make("project-scratch");
const threadIn = (projectId: ProjectId) => ThreadId.make(`thread-in-${projectId}`);
const orphanThread = ThreadId.make("thread-of-a-removed-project");

interface Sandbox {
  /** Project A's root; it has the fixture `.t3` toolbox and provider MCP configs. */
  readonly rootA: string;
  readonly rootB: string;
  /** Calls a `t3_*` tool as an agent in `threadId`; refusals come back as results. */
  readonly call: (
    threadId: ThreadId,
    name: CrewInitToolName,
    params?: unknown,
  ) => Effect.Effect<{ readonly isFailure: boolean; readonly result: any }>;
}

/** Runs against copies of the fixtures, so nothing a test does reaches the committed ones. */
const withTools = <A, E>(
  body: (sandbox: Sandbox) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixtures = path.join(import.meta.dirname, "..", "__fixtures__");
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-crews-" });
    const home = path.join(root, "home");
    const rootA = path.join(root, "a");
    const rootB = path.join(root, "b");
    const scratchRoot = path.join(root, "scratch");
    yield* fileSystem.copy(path.join(fixtures, "home"), home);
    for (const projectRoot of [rootA, rootB, scratchRoot]) {
      yield* fileSystem.makeDirectory(projectRoot, { recursive: true });
    }
    // Committed as `project-toolbox` because the repo ignores every `.t3` directory.
    yield* fileSystem.copy(path.join(fixtures, "project-toolbox"), path.join(rootA, ".t3"));
    yield* fileSystem.writeFileString(
      path.join(rootA, ".t3", "mcp.yaml"),
      [
        "servers:",
        "  storybook:",
        "    command: npx",
        '    args: ["storybook-mcp"]',
        "    env:",
        '      SB_TOKEN: "${secret:SB_TOKEN}"',
        `      SB_LITERAL: "${TOKEN}"`,
        "",
      ].join("\n"),
    );
    yield* fileSystem.writeFileString(
      path.join(rootA, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          github: { command: "npx", args: ["-y", "server-github"], env: { GITHUB_TOKEN: TOKEN } },
          docs: { type: "http", url: "https://docs.test/mcp" },
        },
      }),
    );
    const tools = yield* makeStandaloneCrewInitTools({
      home,
      projects: { [projectA]: rootA, [projectB]: rootB, [scratchProject]: scratchRoot },
      scratchRoot,
      threads: new Map([
        [threadIn(projectA), projectA],
        [threadIn(projectB), projectB],
        [threadIn(scratchProject), scratchProject],
        [orphanThread, ProjectId.make("removed")],
      ]),
    });
    return yield* body({ rootA, rootB, call: tools.call });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("crew-init tools", () => {
  it.effect(
    "AC 14 returns only the calling thread's project toolbox, and no_project without one",
    () =>
      withTools(({ rootA, rootB, call }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const a = yield* call(threadIn(projectA), "t3_crews_toolbox");
          expect(a.isFailure).toBe(false);
          expect(a.result.directory).toBe(path.join(rootA, ".t3"));
          expect(a.result.files).toEqual(
            expect.arrayContaining([
              "crews.yaml",
              "mcp.yaml",
              "tools.yaml",
              "skills/glossary/SKILL.md",
            ]),
          );
          expect(Object.keys(a.result.tools.tools)).toEqual(["unit-tests", "e2e", "lint"]);

          const b = yield* call(threadIn(projectB), "t3_crews_toolbox");
          expect(b.result).toMatchObject({
            directory: path.join(rootB, ".t3"),
            files: [],
            grants: null,
            mcpImports: [],
          });

          for (const threadId of [threadIn(scratchProject), orphanThread]) {
            for (const tool of ["t3_crews_toolbox", "t3_crews_list", "t3_skill_get"] as const) {
              const refused = yield* call(
                threadId,
                tool,
                tool === "t3_skill_get" ? { name: "crew-init" } : {},
              );
              expect(refused).toMatchObject({ isFailure: true, result: { code: "no_project" } });
            }
          }
        }),
      ),
  );

  it.effect("redacts MCP env values and converts repo MCP configs without their secrets", () =>
    withTools(({ call }) =>
      Effect.gen(function* () {
        const { result } = yield* call(threadIn(projectA), "t3_crews_toolbox");
        expect(result.mcp.servers.storybook.env).toEqual({
          SB_TOKEN: "${secret:SB_TOKEN}",
          SB_LITERAL: "<redacted>",
        });
        expect(result.mcpImports).toEqual([
          {
            source: ".mcp.json",
            name: "github",
            server: {
              command: "npx",
              args: ["-y", "server-github"],
              env: { GITHUB_TOKEN: "${secret:GITHUB_TOKEN}" },
            },
            secrets: ["GITHUB_TOKEN"],
          },
          expect.objectContaining({ name: "docs", unsupported: expect.stringMatching(/HTTP/u) }),
        ]);
        expect(JSON.stringify(result)).not.toContain(TOKEN);
        const crew = yield* call(threadIn(projectA), "t3_crews_get", { crewId: "feature-trio" });
        expect(JSON.stringify(crew.result)).not.toContain(TOKEN);
      }),
    ),
  );

  it.effect("lists crews and reports what a bare project leaves unresolved", () =>
    withTools(({ call }) =>
      Effect.gen(function* () {
        const list = yield* call(threadIn(projectB), "t3_crews_list");
        expect(list.result.crews.map((crew: { id: string }) => crew.id)).toEqual([
          "bugfix-duo",
          "feature-trio",
        ]);

        const { result } = yield* call(threadIn(projectB), "t3_crews_get", {
          crewId: "feature-trio",
        });
        expect(result.references).toEqual({
          skills: ["repo-conventions", "testing"],
          mcp: ["playwright"],
          tools: ["unit-tests"],
        });
        // T3 home defines `testing` and `playwright`; only the repo can define the rest.
        expect(result.unresolved).toEqual({
          skills: ["repo-conventions"],
          mcp: [],
          tools: ["unit-tests"],
        });
        expect(
          result.roles.find((role: { id: string }) => role.id === "implementer").references.tools,
        ).toEqual(["unit-tests"]);
        expect(result.steps.find((step: { id: string }) => step.id === "plan")).toEqual({
          id: "plan",
          type: "task",
          role: "planner",
          task: "prompts/plan.md",
        });

        const missing = yield* call(threadIn(projectB), "t3_crews_get", { crewId: "nope" });
        expect(missing).toMatchObject({ isFailure: true, result: { code: "not_found" } });
      }),
    ),
  );

  it.effect("AC 15 dry-runs proposed files with line and column and writes nothing", () =>
    withTools(({ rootB, call }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const malformed = yield* call(threadIn(projectB), "t3_crews_validate", {
          files: { "crews.yaml": "version: 1\ntags:\n  worker: { tools: [unit-tests]\n" },
        });
        expect(malformed.isFailure).toBe(false);
        const error = malformed.result.diagnostics.find(
          (diagnostic: { severity: string }) => diagnostic.severity === "error",
        );
        expect(error).toMatchObject({ file: path.join(rootB, ".t3", "crews.yaml") });
        expect(error.line).toBeGreaterThan(0);
        expect(error.column).toBeGreaterThan(0);

        const proposed = yield* call(threadIn(projectB), "t3_crews_validate", {
          files: {
            "tools.yaml": "tools:\n  unit-tests:\n    run: pnpm test\n    timeoutSeconds: 600\n",
            "skills/repo-conventions/SKILL.md":
              "---\nname: repo-conventions\n---\nRead AGENTS.md.\n",
          },
        });
        const trio = proposed.result.crews.find(
          (crew: { id: string }) => crew.id === "feature-trio",
        );
        expect(trio.unresolved).toEqual({ skills: [], mcp: [], tools: [] });
        expect(trio.status).toBe("ok");
        expect(yield* fileSystem.exists(path.join(rootB, ".t3"))).toBe(false);

        const outside = yield* call(threadIn(projectB), "t3_crews_validate", {
          files: { "../.mcp.json": "{}" },
        });
        expect(outside).toMatchObject({ isFailure: true, result: { code: "not_allowed" } });
      }),
    ),
  );

  it.effect("serves the bundled crew-init skill, the same text as its SKILL.md", () =>
    withTools(({ call }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const skills = path.join(import.meta.dirname, "..", "skills");
        // The bundle carries the generated copy; regenerate it after editing a skill.
        for (const name of (yield* fileSystem.readDirectory(skills)).toSorted()) {
          const directory = path.join(skills, name);
          if (!(yield* fileSystem.stat(directory)).type.includes("Directory")) continue;
          for (const file of yield* fileSystem.readDirectory(directory)) {
            const text = (yield* fileSystem.readFileString(path.join(directory, file))).replace(
              /\r\n/gu,
              "\n",
            );
            expect(BUNDLED_SKILLS[name]?.[file], `${name}/${file}`).toBe(text);
          }
        }
        const skill = yield* call(threadIn(projectB), "t3_skill_get", { name: "crew-init" });
        expect(skill.result).toMatchObject({ name: "crew-init", file: "SKILL.md" });
        expect(skill.result.content).toContain("t3_crews_validate");
        const unknown = yield* call(threadIn(projectB), "t3_skill_get", { name: "constructor" });
        expect(unknown).toMatchObject({ isFailure: true, result: { code: "not_found" } });
      }),
    ),
  );
});
