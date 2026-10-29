import { createInterface } from "node:readline";
import { handleMcpMessage, rpcError } from "./mcp.js";

/**
 * Newline-delimited JSON-RPC over stdin/stdout (MCP stdio transport).
 * stdout carries protocol messages only; diagnostics go to stderr.
 *
 * @param {ReturnType<import("./tools.js").createToolset>} toolset
 * @param {{input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream}} [streams]
 * @returns {Promise<void>} resolves when input closes and pending calls finish
 */
export function serveStdio(toolset, { input = process.stdin, output = process.stdout } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set();
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    const task = (async () => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        output.write(`${JSON.stringify(rpcError(null, -32700, "Parse error"))}\n`);
        return;
      }
      const reply = await handleMcpMessage(message, { toolset });
      if (reply !== null) output.write(`${JSON.stringify(reply)}\n`);
    })();
    pending.add(task);
    task.finally(() => pending.delete(task));
  });
  return new Promise((resolve) => lines.on("close", () => Promise.allSettled([...pending]).then(() => resolve())));
}
