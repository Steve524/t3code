/**
 * Converts the MCP servers of a repo's provider configs into `mcp.yaml` entries for
 * `/crew-init`. Pure: callers pass the file text. Secret values never survive the
 * conversion; they become `${secret:NAME}` references the user fills in Settings, Crews.
 *
 * @module mcpImports
 */
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import type { CrewMcpImport } from "../../../../../../packages/contracts/src/fork/crews/crewInit.ts";

/** The provider config files `/crew-init` reads, relative to the repo root. */
export const MCP_IMPORT_SOURCES = [
  ".mcp.json",
  ".cursor/mcp.json",
  ".vscode/mcp.json",
  ".codex/config.toml",
] as const;
export type McpImportSource = (typeof MCP_IMPORT_SOURCES)[number];

export interface McpImportResult {
  readonly imports: ReadonlyArray<CrewMcpImport>;
  /** Set when the file could not be read at all. */
  readonly error?: string;
}

const UNSUPPORTED_REMOTE = "HTTP and SSE servers are not supported yet; crews start stdio servers.";

// `${VAR}`, `$VAR`, and VS Code's `${env:VAR}` and `${input:id}`. A crew `${secret:NAME}` stays.
const ENV_REFERENCE = /\$\{(?:env:|input:)?([\w-]+)\}|\$([A-Za-z_]\w*)/gu;
const SECRET_REFERENCE = /\$\{secret:([\w-]+)\}/gu;
const SECRET_KEY =
  /(?:_TOKEN|_KEY|_SECRET|APIKEY)$|PASSWORD|CREDENTIAL|^(?:AUTHORIZATION|TOKEN|SECRET)$/iu;
const CREDENTIAL_PREFIX =
  /^(?:gh[pousr]_|github_pat_|glpat-|xox[abprs]-|sk-|sk_live_|rk_live_|AKIA|ASIA|AIza|ya29\.|eyJ|Bearer\s)/u;

/** A literal that reads as a token or key rather than a port, flag or name. */
export function looksLikeCredential(value: string): boolean {
  if (CREDENTIAL_PREFIX.test(value)) return true;
  // Long opaque runs of letters and digits; paths and URLs have separators this excludes.
  return /^[\w+=-]{24,}$/u.test(value) && /[a-z]/iu.test(value) && /\d/u.test(value);
}

/** One env value as `mcp.yaml` may hold it, and the secrets it now names. */
function convertEnvValue(key: string, value: string): { value: string; secrets: string[] } {
  const withReferences = value.replace(
    ENV_REFERENCE,
    (_match, braced: string | undefined, bare: string | undefined) =>
      `\${secret:${braced ?? bare}}`,
  );
  const secrets = [...withReferences.matchAll(SECRET_REFERENCE)].map((match) => match[1]!);
  if (secrets.length > 0) return { value: withReferences, secrets };
  if (SECRET_KEY.test(key) || looksLikeCredential(value)) {
    const name = key.replace(/[^\w-]/gu, "_");
    return { value: `\${secret:${name}}`, secrets: [name] };
  }
  return { value, secrets: [] };
}

/** One server entry of any source, already in a JSON-like shape. */
function convertServer(source: McpImportSource, name: string, entry: unknown): CrewMcpImport {
  const unsupported = (reason: string): CrewMcpImport => ({
    source,
    name,
    unsupported: reason,
    secrets: [],
  });
  if (!Predicate.isObject(entry)) return unsupported("The entry is not an object.");
  const type = typeof entry.type === "string" ? entry.type.toLowerCase() : "stdio";
  if (type !== "stdio" || entry.url !== undefined || entry.serverUrl !== undefined) {
    return unsupported(UNSUPPORTED_REMOTE);
  }
  if (typeof entry.command !== "string" || entry.command.trim() === "") {
    return unsupported("The entry has no command.");
  }
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  // `${secret:...}` never resolves in args, and copying a literal secret would leak it.
  const secretArg = args.find(
    (arg) => /\$\{|\$[A-Za-z_]/u.test(arg) || looksLikeCredential(arg.replace(/^--?[\w-]+=/u, "")),
  );
  if (secretArg !== undefined) {
    return unsupported(
      "An argument holds a variable or a secret. Crew servers take secrets in env only, so move it into env by hand.",
    );
  }
  const env: Record<string, string> = {};
  const secrets = new Set<string>();
  for (const [key, value] of Object.entries(Predicate.isObject(entry.env) ? entry.env : {})) {
    const converted = convertEnvValue(key, String(value));
    env[key] = converted.value;
    for (const secret of converted.secrets) secrets.add(secret);
  }
  return {
    source,
    name,
    server: {
      command: entry.command,
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    },
    secrets: [...secrets],
  };
}

const decodeLenientJson = Schema.decodeUnknownExit(fromLenientJson(Schema.Unknown));

/** The servers a provider config file defines, converted for `mcp.yaml`. */
export function convertMcpConfig(source: McpImportSource, text: string): McpImportResult {
  let servers: unknown;
  try {
    if (source === ".codex/config.toml") {
      servers = readToml(text).mcp_servers;
    } else {
      const decoded = decodeLenientJson(text);
      if (Exit.isFailure(decoded)) return { imports: [], error: "The file is not valid JSON." };
      const document = decoded.value;
      // VS Code names the map `servers`; Claude Code and Cursor name it `mcpServers`.
      servers = Predicate.isObject(document)
        ? source === ".vscode/mcp.json"
          ? document.servers
          : document.mcpServers
        : undefined;
    }
  } catch (error) {
    return { imports: [], error: error instanceof Error ? error.message : String(error) };
  }
  if (!Predicate.isObject(servers)) return { imports: [] };
  return {
    imports: Object.entries(servers).map(([name, entry]) => convertServer(source, name, entry)),
  };
}

/**
 * shortcut: reads the TOML subset Codex configs use (tables, dotted and quoted keys, strings,
 * arrays, inline tables); other values stay text and arrays of tables are skipped. Add a TOML
 * dependency if MCP configs need more.
 */
export function readToml(text: string): Record<string, unknown> {
  let index = 0;
  const root: Record<string, unknown> = {};
  let table: Record<string, unknown> = root;
  const fail = (message: string): never => {
    throw new Error(`${message} on line ${text.slice(0, index).split("\n").length}.`);
  };
  const skip = (newlines: boolean) => {
    for (;;) {
      const char = text[index];
      if (char === " " || char === "\t" || char === "\r" || (newlines && char === "\n")) index++;
      else if (char === "#") while (index < text.length && text[index] !== "\n") index++;
      else return;
    }
  };
  const readString = (): string => {
    const quote = text[index]!;
    if (text.startsWith(quote.repeat(3), index)) {
      const end = text.indexOf(quote.repeat(3), index + 3);
      if (end < 0) fail("Unterminated string");
      const body = text.slice(index + 3, end).replace(/^\r?\n/u, "");
      index = end + 3;
      return body;
    }
    index++;
    let out = "";
    while (text[index] !== quote) {
      if (index >= text.length || text[index] === "\n") fail("Unterminated string");
      if (quote === '"' && text[index] === "\\") {
        const escape = text[index + 1]!;
        index += 2;
        if (escape === "u" || escape === "U") {
          const length = escape === "u" ? 4 : 8;
          out += String.fromCodePoint(Number.parseInt(text.slice(index, index + length), 16));
          index += length;
        } else {
          const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" };
          out += map[escape] ?? fail("Unsupported escape");
        }
      } else {
        out += text[index++];
      }
    }
    index++;
    return out;
  };
  const readKey = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      skip(false);
      if (text[index] === '"' || text[index] === "'") {
        parts.push(readString());
      } else {
        const bare = /^[\w-]+/u.exec(text.slice(index))?.[0] ?? fail("Expected a key");
        parts.push(bare);
        index += bare.length;
      }
      skip(false);
      if (text[index] !== ".") return parts;
      index++;
    }
  };
  const child = (target: Record<string, unknown>, key: string) => {
    const existing = target[key] ?? {};
    if (!Predicate.isObject(existing)) fail(`"${key}" is not a table`);
    target[key] = existing;
    return existing as Record<string, unknown>;
  };
  const assign = (target: Record<string, unknown>, path: string[], value: unknown) => {
    const parent = path.slice(0, -1).reduce(child, target);
    parent[path.at(-1)!] = value;
  };
  const readValue = (): unknown => {
    skip(false);
    const char = text[index];
    if (char === '"' || char === "'") return readString();
    if (char === "[") {
      index++;
      const items: unknown[] = [];
      for (;;) {
        skip(true);
        if (text[index] === "]") break;
        items.push(readValue());
        skip(true);
        if (text[index] === ",") index++;
        else if (text[index] !== "]") fail("Expected , or ]");
      }
      index++;
      return items;
    }
    if (char === "{") {
      index++;
      const inline: Record<string, unknown> = {};
      skip(false);
      if (text[index] === "}") {
        index++;
        return inline;
      }
      for (;;) {
        const key = readKey();
        if (text[index++] !== "=") fail("Expected =");
        assign(inline, key, readValue());
        skip(false);
        const next = text[index++];
        if (next === "}") return inline;
        if (next !== ",") fail("Expected , or }");
      }
    }
    const bare = /^[^\s,\]}#]+/u.exec(text.slice(index))?.[0] ?? fail("Expected a value");
    index += bare.length;
    return bare === "true" ? true : bare === "false" ? false : bare;
  };
  for (;;) {
    skip(true);
    if (index >= text.length) return root;
    if (text[index] === "[") {
      const arrayOfTables = text[index + 1] === "[";
      index += arrayOfTables ? 2 : 1;
      const path = readKey();
      if (!text.startsWith(arrayOfTables ? "]]" : "]", index)) fail("Expected ]");
      index += arrayOfTables ? 2 : 1;
      // An array of tables is never part of `mcp_servers`, so its keys go nowhere.
      table = arrayOfTables ? {} : path.reduce(child, root);
    } else {
      const key = readKey();
      if (text[index++] !== "=") fail("Expected =");
      assign(table, key, readValue());
    }
    skip(false);
    if (index < text.length && text[index] !== "\n") fail("Expected a new line");
  }
}
