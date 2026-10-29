import { getRuntimeReview, renderBrief, InputError, TOOL_VERSION } from "./runtime-review.js";
import { EXECUTION_PROFILE_TOOL, getExecutionProfile, renderProfileBrief, ProfileInputError } from "./execution-profile.js";
import { GARNET_PROFILE_TOOL, getGarnetProfile, renderGarnetProfileBrief, GarnetProfileInputError } from "./garnet-profile.js";

export { TOOL_VERSION };

export const RUNTIME_REVIEW_TOOL = Object.freeze({
  name: "get_runtime_review",
  title: "Garnet Runtime Review for a pull request",
  description:
    "Returns the Garnet Runtime Review record for a public GitHub pull request: what the PR's CI jobs actually did at runtime " +
    "(network destinations per process and step), compared with the previous commit. Only returns evidence bound to the PR's current head SHA; " +
    "stale, pending or missing records come back as verdict \"undeterminable\". Workload changes are separated from runner background and " +
    "GitHub/platform noise. Call it once per review with the repository (\"owner/name\") and the pull request number.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "Repository as \"owner/name\" (e.g. \"pnpm/pnpm\"), or the full pull request URL." },
      pr: { type: "integer", minimum: 1, description: "Pull request number. Optional when repo is a pull request URL." },
    },
    required: ["repo"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
});

export const SERVER_INSTRUCTIONS =
  "Call get_runtime_review with the pull request's repository and number before summarising runtime or CI behavior. " +
  "Treat verdict \"undeterminable\" as no evidence. Evidence never approves a pull request. " +
  "Use get_execution_profile on a returned profile link only when you need the full per-job record.";

/**
 * Build the tool set for one transport.
 *
 * hosted: get_runtime_review + get_execution_profile, public data only, no Garnet credentials.
 * local:  the same, plus get_garnet_profile when garnetctl is explicitly enabled.
 *
 * @param {{githubToken?: string | null, enableGarnetctl?: boolean, fetchImpl?: typeof fetch, runGarnetctl?: (args: string[]) => Promise<string>}} [options]
 * @returns {Map<string, {definition: object, call: (args: any) => Promise<object>, render: (result: any) => string, inputErrors: Function[]}>}
 */
export function createToolset({ githubToken = null, enableGarnetctl = false, fetchImpl, runGarnetctl } = {}) {
  const tools = new Map();
  tools.set(RUNTIME_REVIEW_TOOL.name, {
    definition: RUNTIME_REVIEW_TOOL,
    call: (args) => getRuntimeReview(args, { githubToken, ...(fetchImpl ? { fetchImpl } : {}) }),
    render: renderBrief,
    inputErrors: [InputError],
  });
  tools.set(EXECUTION_PROFILE_TOOL.name, {
    definition: EXECUTION_PROFILE_TOOL,
    call: (args) => getExecutionProfile(args, { githubToken, ...(fetchImpl ? { fetchImpl } : {}) }),
    render: renderProfileBrief,
    inputErrors: [ProfileInputError],
  });
  if (enableGarnetctl) {
    tools.set(GARNET_PROFILE_TOOL.name, {
      definition: GARNET_PROFILE_TOOL,
      call: (args) => getGarnetProfile(args, runGarnetctl ? { run: runGarnetctl } : {}),
      render: renderGarnetProfileBrief,
      inputErrors: [GarnetProfileInputError],
    });
  }
  return tools;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
export function garnetctlEnabled(env) {
  return ["1", "true", "yes"].includes(String(env.GARNET_RR_ENABLE_GARNETCTL ?? "").toLowerCase());
}
