import { handleMcpMessage, rpcError } from "./mcp.js";

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Stateless MCP Streamable HTTP handler (JSON responses, no SSE).
 * Works as a Vercel function and with node:http.
 *
 * @param {ReturnType<import("./tools.js").createToolset>} toolset
 * @returns {(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => Promise<void>}
 */
export function createHttpHandler(toolset) {
  return async function handler(request, response) {
    if (request.method === "GET" && !String(request.headers.accept ?? "").includes("text/event-stream")) {
      sendJson(response, 200, {
        name: "garnet-runtime-review",
        transport: "MCP Streamable HTTP (stateless, JSON responses)",
        endpoint: "/mcp",
        tools: [...toolset.keys()],
        reads: ["api.github.com (public repositories only)", "app.garnet.ai/api/public/runs"],
      });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "GET, POST");
      sendJson(response, 405, rpcError(null, -32000, "Method not allowed: this endpoint is stateless and does not open SSE streams"));
      return;
    }
    let message;
    try {
      message = JSON.parse(await readBody(request));
    } catch {
      sendJson(response, 400, rpcError(null, -32700, "Parse error"));
      return;
    }
    const reply = await handleMcpMessage(message, { toolset });
    if (reply === null) {
      response.statusCode = 202;
      response.end();
      return;
    }
    sendJson(response, 200, reply);
  };
}

/**
 * @param {import("node:http").IncomingMessage & {body?: unknown}} request
 * @returns {Promise<string>}
 */
async function readBody(request) {
  if (typeof request.body === "string") return request.body;
  if (request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) return JSON.stringify(request.body);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * @param {import("node:http").ServerResponse} response
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload));
}
