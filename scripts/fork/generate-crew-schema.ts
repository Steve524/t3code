// @effect-diagnostics nodeBuiltinImport:off - standalone file generator, outside an Effect runtime.
import * as NodeFSP from "node:fs/promises";

// A URL import keeps shared sources out of the scripts package's composite TypeScript project.
const { buildCrewFileJsonSchema, buildCrewsToolboxJsonSchema } = (await import(
  new URL("../../packages/shared/src/fork/crews/crewFileSchema.ts", import.meta.url).href
)) as {
  buildCrewFileJsonSchema: () => Record<string, unknown>;
  buildCrewsToolboxJsonSchema: () => Record<string, unknown>;
};

const directory = new URL("../../docs/fork/schema/", import.meta.url);
await NodeFSP.mkdir(directory, { recursive: true });
for (const [name, schema] of [
  ["crew.json", buildCrewFileJsonSchema()],
  ["crews-toolbox.json", buildCrewsToolboxJsonSchema()],
] as const) {
  await NodeFSP.writeFile(new URL(name, directory), `${JSON.stringify(schema, null, 2)}\n`);
}
