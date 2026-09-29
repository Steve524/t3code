import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeClaudeAdapter } from "../../provider/Layers/ClaudeAdapter.ts";
import {
  SYNTHETIC_CLAUDE_MODEL_CATALOG,
  SYNTHETIC_CLAUDE_THINKING_MODEL,
  SYNTHETIC_CLAUDE_STANDARD_MODEL,
} from "../../provider/ClaudeModelCatalog.testFixtures.ts";

const defaultSettings = Schema.decodeSync(ClaudeSettings)({});

for (const selection of [undefined, false, true]) {
  it.effect(`sends the displayed thinking value to Claude when the selection is ${selection}`, () =>
    Effect.gen(function* () {
      let queryOptions: Options | undefined;
      let close = () => {};
      const closed = new Promise<void>((resolve) => {
        close = resolve;
      });
      const adapter = yield* makeClaudeAdapter(defaultSettings, {
        modelCatalog: Effect.succeed(SYNTHETIC_CLAUDE_MODEL_CATALOG),
        createQuery: ({ options }) => {
          queryOptions = options;
          return {
            [Symbol.asyncIterator]() {
              return {
                next: async () => {
                  await closed;
                  return { done: true as const, value: undefined };
                },
              };
            },
            setModel: async () => {},
            setPermissionMode: async () => {},
            setMaxThinkingTokens: async () => {},
            close,
          };
        },
      });
      const start = (model: string) =>
        adapter.startSession({
          threadId: ThreadId.make(model),
          provider: ProviderDriverKind.make("claudeAgent"),
          modelSelection: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            model,
            selection === undefined ? undefined : [{ id: "thinking", value: selection }],
          ),
          runtimeMode: "approval-required",
        });
      yield* start(SYNTHETIC_CLAUDE_THINKING_MODEL);
      expect(queryOptions?.settings).toMatchObject({ alwaysThinkingEnabled: selection ?? false });
      expect(queryOptions?.extraArgs?.["thinking-display"]).toBe(
        selection === true ? "summarized" : undefined,
      );
      yield* start(SYNTHETIC_CLAUDE_STANDARD_MODEL);
      expect(queryOptions?.settings).not.toHaveProperty("alwaysThinkingEnabled");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-thinking-test-" }),
          ServerSettingsService.layerTest(),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
  );
}
