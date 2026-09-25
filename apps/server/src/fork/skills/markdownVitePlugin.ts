import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

export const planLoopMarkdownPlugin = {
  name: "t3-plan-loop-markdown",
  async load(id: string) {
    if (
      !id.replaceAll("\\", "/").includes("/src/fork/skills/t3-plan-loop/") ||
      !id.endsWith(".md")
    ) {
      return;
    }
    const content = await Effect.runPromise(
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.readFileString(id)),
        Effect.provide(NodeServices.layer),
      ),
    );
    return `export default ${JSON.stringify(content)}`;
  },
};
