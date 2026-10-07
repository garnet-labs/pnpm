import { createToolset, SERVER_INSTRUCTIONS, TOOL_VERSION, RUNTIME_REVIEW_TOOL } from "./tools.js";

export { RUNTIME_REVIEW_TOOL };

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_TOOLSET = createToolset();

/**
 * Handle one JSON-RPC message (or batch) for a stateless MCP server.
 *
 * @param {any} message
 * @param {{toolset?: ReturnType<typeof createToolset>, callTool?: (args: any) => Promise<object>}} [options]
 *   callTool overrides get_runtime_review (tests and custom hosts).
 * @returns {Promise<object | object[] | null>}
 */
export async function handleMcpMessage(message, { toolset = DEFAULT_TOOLSET, callTool } = {}) {
  let tools = toolset;
  if (callTool) {
    tools = new Map(toolset);
    tools.set(RUNTIME_REVIEW_TOOL.name, { ...toolset.get(RUNTIME_REVIEW_TOOL.name), call: callTool });
  }
  if (Array.isArray(message)) {
    const responses = (await Promise.all(message.map((item) => handleOne(item, tools)))).filter((item) => item !== null);
    return responses.length === 0 ? null : responses;
  }
  return handleOne(message, tools);
}

/**
 * @param {any} message
 * @param {ReturnType<typeof createToolset>} tools
 * @returns {Promise<object | null>}
 */
async function handleOne(message, tools) {
  if (message === null || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(message?.id ?? null, -32600, "Invalid Request");
  }
  const { id, method, params } = message;
  if (id === undefined) return null;
  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      return rpcResult(id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "garnet-runtime-review", title: "Garnet Runtime Review", version: TOOL_VERSION },
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: [...tools.values()].map((tool) => tool.definition) });
    case "resources/list":
      return rpcResult(id, { resources: [] });
    case "prompts/list":
      return rpcResult(id, { prompts: [] });
    case "tools/call": {
      const tool = tools.get(params?.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        const result = await tool.call(params.arguments ?? {});
        return rpcResult(id, {
          content: [{ type: "text", text: `${tool.render(result)}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`` }],
          structuredContent: result,
          isError: false,
        });
      } catch (error) {
        const text = tool.inputErrors.some((type) => error instanceof type) ? error.message : `${tool.definition.name} failed: ${error.message}`;
        return rpcResult(id, { content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * @param {any} id
 * @param {object} result
 * @returns {object}
 */
function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

/**
 * @param {any} id
 * @param {number} code
 * @param {string} message
 * @returns {object}
 */
export function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
