// A stdio MCP server for crew tests, speaking newline-delimited JSON-RPC. Its first argument
// names it, so one file can stand in for several servers.
import * as NodeReadline from "node:readline";

const name = process.argv[2] ?? "echo";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const tools = [
  { name: "echo", description: "Returns its text.", inputSchema: { type: "object" } },
  {
    name: "env",
    description: "Returns one environment variable.",
    inputSchema: { type: "object" },
  },
  { name: "argv", description: "Returns the process arguments.", inputSchema: { type: "object" } },
  { name: "pid", description: "Returns the process id.", inputSchema: { type: "object" } },
  { name: "crash", description: "Exits at once.", inputSchema: { type: "object" } },
];

NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  const text = (value) => reply({ content: [{ type: "text", text: String(value) }] });
  if (message.method === "initialize") {
    return reply({
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name, version: "1.0.0" },
    });
  }
  if (message.method === "tools/list") return reply({ tools });
  if (message.method === "tools/call") {
    const args = message.params.arguments ?? {};
    switch (message.params.name) {
      case "echo":
        return text(`${name}: ${args.text}`);
      case "env":
        return text(process.env[args.name] ?? "");
      case "argv":
        return text(JSON.stringify(process.argv));
      case "pid":
        return text(process.pid);
      case "crash":
        process.stderr.write("crashing on purpose\n");
        return process.exit(3);
    }
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
});
