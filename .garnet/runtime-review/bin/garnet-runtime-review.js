#!/usr/bin/env node
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { createToolset, garnetctlEnabled, TOOL_VERSION } from "../src/tools.js";
import { serveStdio } from "../src/stdio.js";
import { createHttpHandler } from "../src/http.js";
import { renderBrief, InputError } from "../src/runtime-review.js";
import { renderProfileBrief, ProfileInputError } from "../src/execution-profile.js";
import { buildAnnotations, buildCheckRun, createCheckRun, fetchPullFiles, renderWorkflowCommand, EVIDENCE_CHECK_NAME } from "../src/github-check.js";

const WAIT_INTERVAL_MS = 20000;
const EXIT = { ok: 0, policy: 2, error: 3, usage: 64 };
const ASSESSMENTS = ["workload-change", "noise-only-change", "no-change", "first-snapshot", "undeterminable", "unavailable"];

const HELP = `garnet-runtime-review ${TOOL_VERSION}

Usage:
  garnet-runtime-review [mcp]                      Local MCP server over stdio (default)
  garnet-runtime-review serve [--port N] [--host H] Self-hosted MCP over HTTP (POST /mcp)
  garnet-runtime-review check <owner/name> <pr>    Runtime Review for one pull request
  garnet-runtime-review check <pull-request-url>
      --json                 print the full JSON result instead of the brief
      --fail-on <list>       comma-separated assessments that exit 2
                             (default: none; e.g. workload-change,undeterminable)
      --wait <seconds>       re-check every 20s while no record is bound to the
                             current head (assessment "unavailable"), up to N seconds
      --annotate             print GitHub Actions workflow commands that annotate the
                             changed files with the head-bound delta (error level when
                             the assessment is in --fail-on); the brief goes to
                             $GITHUB_STEP_SUMMARY instead of stdout when that file is set
      --github-check[=name]  publish a "garnet/evidence" check run on the head SHA with
                             the delta as title, summary and file annotations; conclusion
                             is failure when --fail-on matches, neutral otherwise
                             (GITHUB_TOKEN with checks: write)
  garnet-runtime-review profile <profile-url> [--json] [--destination S] [--pr N]

Exit codes (check/profile): 0 result returned, 2 assessment matched --fail-on,
3 lookup failed (network, GitHub, private repository), 64 usage error.

Environment:
  GITHUB_TOKEN                  optional; raises GitHub's anonymous 60 requests/hour limit
  GARNET_RR_ENABLE_GARNETCTL=1  local mcp/serve only: add get_garnet_profile (uses garnetctl + GARNET_TOKEN)`;

/**
 * @param {string[]} argv
 * @returns {{positional: string[], flags: Record<string, string | boolean>}}
 */
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) flags[key] = inline;
    else if (["json", "help", "version", "annotate", "github-check"].includes(key)) flags[key] = true;
    else flags[key] = argv[(index += 1)] ?? "";
  }
  return { positional, flags };
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * With garnetctl enabled, refuse browser cross-origin and DNS-rebinding requests:
 * Host must name a loopback host, and any Origin must be this server's own origin
 * (another localhost port is a different origin).
 *
 * @param {import("node:http").IncomingMessage} request
 * @returns {boolean}
 */
function localRequest(request) {
  const hostname = (value) => {
    try {
      return new URL(value.includes("://") ? value : `http://${value}`).hostname.replace(/^\[|\]$/g, "");
    } catch {
      return null;
    }
  };
  const hostHeader = String(request.headers.host ?? "");
  const host = hostname(hostHeader);
  if (host === null || !LOOPBACK.has(host)) return false;
  const origin = request.headers.origin;
  return origin === undefined || String(origin).toLowerCase() === `http://${hostHeader.toLowerCase()}`;
}

async function main() {
  const [command = "mcp", ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  const githubToken = process.env.GITHUB_TOKEN || null;

  if (command === "--help" || command === "-h" || command === "help" || flags.help) return void console.log(HELP);
  if (command === "--version" || command === "-v") return void console.log(TOOL_VERSION);

  if (command === "mcp") {
    await serveStdio(createToolset({ githubToken, enableGarnetctl: garnetctlEnabled(process.env) }));
    return;
  }

  if (command === "serve") {
    const port = Number(flags.port ?? process.env.PORT ?? 8787);
    const host = String(flags.host ?? "127.0.0.1");
    const enableGarnetctl = garnetctlEnabled(process.env);
    if (enableGarnetctl && !LOOPBACK.has(host)) {
      console.error("GARNET_RR_ENABLE_GARNETCTL exposes your Garnet project's profiles without authentication; serve binds it to loopback only (drop --host or unset the variable)");
      process.exitCode = EXIT.usage;
      return;
    }
    const handler = createHttpHandler(createToolset({ githubToken, enableGarnetctl }));
    createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (enableGarnetctl && !localRequest(request)) {
        response.statusCode = 403;
        response.end();
        return;
      }
      if (path !== "/mcp" && path !== "/") {
        response.statusCode = 404;
        response.end();
        return;
      }
      handler(request, response).catch((error) => {
        console.error(error);
        if (!response.headersSent) response.statusCode = 500;
        response.end();
      });
    }).listen(port, host, () => console.error(`garnet-runtime-review MCP listening on http://${host}:${port}/mcp`));
    return;
  }

  if (command === "check") {
    const failOn = String(flags["fail-on"] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    const unknown = failOn.filter((value) => !ASSESSMENTS.includes(value));
    if (unknown.length > 0 || positional.length === 0) {
      console.error(unknown.length > 0 ? `unknown assessment(s): ${unknown.join(", ")}; valid: ${ASSESSMENTS.join(", ")}` : HELP);
      process.exitCode = EXIT.usage;
      return;
    }
    const waitSeconds = flags.wait === undefined ? 0 : Number(flags.wait);
    if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
      console.error("--wait takes a number of seconds");
      process.exitCode = EXIT.usage;
      return;
    }
    const tools = createToolset({ githubToken });
    const deadline = Date.now() + waitSeconds * 1000;
    let result;
    try {
      for (;;) {
        result = await tools.get("get_runtime_review").call({ repo: positional[0], ...(positional[1] ? { pr: Number(positional[1]) } : {}) });
        if (result.assessment !== "unavailable" || Date.now() + WAIT_INTERVAL_MS > deadline) break;
        console.error(`no record bound to head yet (${result.reasons?.[0] ?? "pending"}); re-checking in ${WAIT_INTERVAL_MS / 1000}s`);
        await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
      }
    } catch (error) {
      console.error(error instanceof InputError ? error.message : `lookup failed: ${error.message}`);
      process.exitCode = error instanceof InputError ? EXIT.usage : EXIT.error;
      return;
    }
    const summaryFile = flags.annotate && !flags.json ? process.env.GITHUB_STEP_SUMMARY : undefined;
    if (summaryFile) appendFileSync(summaryFile, `${renderBrief(result)}\n`);
    else console.log(flags.json ? JSON.stringify(result, null, 2) : renderBrief(result));
    if (!result.pull_request?.head_sha) {
      console.error(`lookup failed: ${result.reasons?.[0] ?? "pull request not readable"}`);
      process.exitCode = EXIT.error;
      return;
    }
    if (flags.annotate || flags["github-check"]) {
      try {
        if (flags["github-check"] && !githubToken) throw new InputError("--github-check needs GITHUB_TOKEN with checks: write");
        const files = await fetchPullFiles(result.repository, result.pull_request.number, { githubToken });
        const annotations = buildAnnotations(result, files, { failOn });
        if (flags.annotate) for (const annotation of annotations) console.log(renderWorkflowCommand(annotation));
        if (flags["github-check"]) {
          const name = typeof flags["github-check"] === "string" ? flags["github-check"] : EVIDENCE_CHECK_NAME;
          const check = await createCheckRun(result.repository, buildCheckRun(result, { failOn, name, annotations }), { githubToken });
          console.error(`published ${name} check run ${check.html_url}`);
        }
      } catch (error) {
        console.error(error instanceof InputError ? error.message : `publish failed: ${error.message}`);
        process.exitCode = error instanceof InputError ? EXIT.usage : EXIT.error;
        return;
      }
    }
    if (failOn.includes(result.assessment)) process.exitCode = EXIT.policy;
    return;
  }

  if (command === "profile") {
    if (positional.length === 0) {
      console.error(HELP);
      process.exitCode = EXIT.usage;
      return;
    }
    try {
      const result = await createToolset({ githubToken }).get("get_execution_profile").call({
        url: positional[0],
        ...(flags.destination ? { destination: String(flags.destination) } : {}),
        ...(flags.pr !== undefined ? { pr: Number(flags.pr) } : {}),
      });
      console.log(flags.json ? JSON.stringify(result, null, 2) : renderProfileBrief(result));
      if (!result.available) process.exitCode = EXIT.error;
    } catch (error) {
      console.error(error instanceof ProfileInputError ? error.message : `lookup failed: ${error.message}`);
      process.exitCode = error instanceof ProfileInputError ? EXIT.usage : EXIT.error;
    }
    return;
  }

  console.error(`unknown command: ${command}\n\n${HELP}`);
  process.exitCode = EXIT.usage;
}

main();
