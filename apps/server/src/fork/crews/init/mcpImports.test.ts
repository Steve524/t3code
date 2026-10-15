import { describe, expect, it } from "vite-plus/test";

import { convertMcpConfig, looksLikeCredential, readToml } from "./mcpImports.ts";

const TOKEN = "ghp_EXAMPLE_NOT_A_REAL_TOKEN_0123456789";

describe("MCP config conversion", () => {
  it("converts a Claude Code .mcp.json stdio server and keeps plain literals", () => {
    const result = convertMcpConfig(
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          playwright: { command: "npx", args: ["@playwright/mcp@latest"], env: { PORT: "3000" } },
        },
      }),
    );
    expect(result).toEqual({
      imports: [
        {
          source: ".mcp.json",
          name: "playwright",
          server: { command: "npx", args: ["@playwright/mcp@latest"], env: { PORT: "3000" } },
          secrets: [],
        },
      ],
    });
  });

  it("never copies a secret: literal tokens, secret-looking keys and env references become secret references", () => {
    const result = convertMcpConfig(
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: {
              GITHUB_TOKEN: TOKEN,
              DB_PASSWORD: "hunter2",
              API_URL: "${API_URL}",
              HOME_BIN: "$HOME/bin",
              OPAQUE: "a1B2c3D4e5F6g7H8i9J0k1L2m3",
              LOG_LEVEL: "debug",
            },
          },
        },
      }),
    );
    const [github] = result.imports;
    expect(github?.server?.env).toEqual({
      GITHUB_TOKEN: "${secret:GITHUB_TOKEN}",
      DB_PASSWORD: "${secret:DB_PASSWORD}",
      API_URL: "${secret:API_URL}",
      HOME_BIN: "${secret:HOME}/bin",
      OPAQUE: "${secret:OPAQUE}",
      LOG_LEVEL: "debug",
    });
    expect(github?.secrets).toEqual(["GITHUB_TOKEN", "DB_PASSWORD", "API_URL", "HOME", "OPAQUE"]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("rejects HTTP and SSE servers in every JSON shape", () => {
    const http = { url: "https://example.test/mcp" };
    expect(
      convertMcpConfig(
        ".cursor/mcp.json",
        JSON.stringify({ mcpServers: { remote: http, sse: { type: "sse", url: "x" } } }),
      ).imports.map((entry) => [entry.name, entry.unsupported !== undefined, entry.server]),
    ).toEqual([
      ["remote", true, undefined],
      ["sse", true, undefined],
    ]);
    expect(
      convertMcpConfig(
        ".mcp.json",
        JSON.stringify({ mcpServers: { api: { type: "http", url: "https://x" } } }),
      ).imports[0]?.unsupported,
    ).toMatch(/not supported/u);
  });

  it("reads VS Code's servers map with comments, ${env:} and ${input:} references", () => {
    const text = `{
      // VS Code allows comments and trailing commas
      "inputs": [{ "id": "storybook-key", "type": "promptString", "password": true }],
      "servers": {
        "storybook": {
          "type": "stdio",
          "command": "npx",
          "args": ["storybook-mcp"],
          "env": { "SB_KEY": "\${input:storybook-key}", "SB_HOST": "\${env:SB_HOST}" },
        },
        "docs": { "type": "http", "url": "https://docs.test/mcp" },
      },
    }`;
    const result = convertMcpConfig(".vscode/mcp.json", text);
    expect(result.imports[0]).toEqual({
      source: ".vscode/mcp.json",
      name: "storybook",
      server: {
        command: "npx",
        args: ["storybook-mcp"],
        env: { SB_KEY: "${secret:storybook-key}", SB_HOST: "${secret:SB_HOST}" },
      },
      secrets: ["storybook-key", "SB_HOST"],
    });
    expect(result.imports[1]?.unsupported).toMatch(/HTTP/u);
  });

  it("refuses a server whose arguments carry a secret or a variable", () => {
    const result = convertMcpConfig(
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          inline: { command: "tool", args: [`--token=${TOKEN}`] },
          variable: { command: "tool", args: ["--key", "${API_KEY}"] },
          plain: { command: "tool", args: ["--port", "3000", "./src/index.js"] },
        },
      }),
    );
    expect(result.imports.map((entry) => entry.server === undefined)).toEqual([true, true, false]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("converts Codex TOML tables, inline env and multi-line arrays", () => {
    const text = `
model = "gpt-6.1-sol"
developer_instructions = """
Long text with [brackets] and "quotes".
"""

[[profiles]]
name = "skipped"

[mcp_servers.playwright]
command = "npx"
args = [
  "@playwright/mcp@latest", # trailing comment
  '--headless',
]
env = { "PORT" = "3000", LINEAR_API_KEY = "lin_abc" }

[mcp_servers."sentry-dev".env]
SENTRY_AUTH_TOKEN = "\${SENTRY_AUTH_TOKEN}"

[mcp_servers.sentry-dev]
command = "uvx"
startup_timeout_sec = 20
enabled = true

[mcp_servers.remote]
url = "https://mcp.example.test"
`;
    const result = convertMcpConfig(".codex/config.toml", text);
    expect(result.error).toBeUndefined();
    expect(result.imports).toEqual([
      {
        source: ".codex/config.toml",
        name: "playwright",
        server: {
          command: "npx",
          args: ["@playwright/mcp@latest", "--headless"],
          env: { PORT: "3000", LINEAR_API_KEY: "${secret:LINEAR_API_KEY}" },
        },
        secrets: ["LINEAR_API_KEY"],
      },
      {
        source: ".codex/config.toml",
        name: "sentry-dev",
        server: { command: "uvx", env: { SENTRY_AUTH_TOKEN: "${secret:SENTRY_AUTH_TOKEN}" } },
        secrets: ["SENTRY_AUTH_TOKEN"],
      },
      {
        source: ".codex/config.toml",
        name: "remote",
        unsupported: expect.stringMatching(/HTTP/u),
        secrets: [],
      },
    ]);
  });

  it("reports a file it cannot read instead of guessing", () => {
    expect(convertMcpConfig(".mcp.json", "{ not json").error).toBeDefined();
    expect(convertMcpConfig(".codex/config.toml", 'model = "unterminated').error).toMatch(
      /line 1/u,
    );
    expect(convertMcpConfig(".mcp.json", JSON.stringify({ other: true }))).toEqual({
      imports: [],
    });
  });

  it("reads TOML escapes and dotted keys", () => {
    expect(readToml("a.b = \"x\\ty\"\n[c]\nd = 'raw\\n'\n")).toEqual({
      a: { b: "x\ty" },
      c: { d: "raw\\n" },
    });
  });

  it("tells credentials from ports, flags and names", () => {
    expect(["ghp_x", "sk-proj-abc", "Bearer abc", "AKIAEXAMPLE"].map(looksLikeCredential)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(
      ["3000", "--verbose", "info", "./node_modules/.bin/server"].map(looksLikeCredential),
    ).toEqual([false, false, false, false]);
  });
});
