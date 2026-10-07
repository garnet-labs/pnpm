const BLOCK_RE = /<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g;
const DIFF_RE = /```diff\n([\s\S]*?)```/;
const PLAIN_FENCE_RE = /```\n([\s\S]*?)```/;
const PRE_RE = /<pre>\n?([\s\S]*?)<\/pre>/;
const JOB_LINK_RE = /<code>([^<]+)<\/code>\s*\/\s*<a href="(https:\/\/github\.com\/[^"]+\/actions\/runs\/\d+[^"]*)"><code>([^<]+)<\/code>/;
const PROFILE_LINK_RE = /https:\/\/app\.garnet\.ai\/public\/runs\/(\d+)\?profile=([0-9a-f-]{36})/;
const TREE_LINE_RE = /^([+\- ]) ((?:[│ ] {2})*)(?:[├└]─ )?(.*)$/;
const ACTIONS_RESULTS_RE = /^productionresultssa\d+\.blob\.core\.windows(?:\.net)?$/;

/**
 * @typedef {object} Destination
 * @property {string} destination - Destination as rendered, with `[.]` defanging removed.
 * @property {"added" | "removed" | "unchanged"} change
 * @property {"workload" | "runner background"} origin
 * @property {string[]} chain - Process names from the root to the process that acted.
 * @property {string | null} step - Nearest GitHub step annotation on the chain.
 * @property {string | null} context - The renderer's parenthesised context, e.g. "dns resolver".
 * @property {string | null} noise - Why a change is not review-relevant, or null when it is.
 */

/**
 * @typedef {object} RecordedJob
 * @property {string} workflow
 * @property {string} job
 * @property {string} runUrl
 * @property {string | null} profileUrl - Public Execution Profile page for the job.
 * @property {string | null} profileJsonUrl - Public JSON twin of that page.
 * @property {Destination[]} destinations
 */

/**
 * Split a Runtime Review comment into its recorded jobs and destination rows.
 *
 * Reads only the rendered `diff` tree; the marker counts are reconciled
 * separately by `evaluateConsumerVerdict`.
 *
 * @param {string} body
 * @returns {RecordedJob[]}
 */
export function parseRecordedJobs(body) {
  const jobs = [];
  let unreadable = 0;
  for (const match of body.matchAll(BLOCK_RE)) {
    const [, summary, content] = match;
    const link = JOB_LINK_RE.exec(summary);
    const tree = readTree(content);
    if (link !== null && tree === null) unreadable += 1;
    if (link === null || tree === null) continue;
    const profile = PROFILE_LINK_RE.exec(content);
    jobs.push({
      workflow: decodeEntities(link[1]),
      job: decodeEntities(link[3]),
      runUrl: decodeEntities(link[2]),
      profileUrl: profile === null ? null : `https://app.garnet.ai/public/runs/${profile[1]}?profile=${profile[2]}`,
      profileJsonUrl: profile === null ? null : `https://app.garnet.ai/api/public/runs/${profile[1]}?profile=${profile[2]}`,
      destinations: parseTree(tree),
    });
  }
  return Object.assign(jobs, { unreadable });
}

/**
 * Comparison records render a ```diff block; first snapshots render an HTML
 * `<pre>` tree and older unchanged folds a plain fence, both without change
 * markers. All are normalised to diff lines.
 *
 * @param {string} content
 * @returns {string | null}
 */
function readTree(content) {
  const diff = DIFF_RE.exec(content);
  if (diff !== null) return diff[1];
  const plain = PLAIN_FENCE_RE.exec(content);
  const pre = plain === null ? PRE_RE.exec(content) : null;
  const tree = plain?.[1] ?? (pre === null ? null : decodeEntities(pre[1].replace(/<[^>]+>/g, "")));
  if (tree === null) return null;
  return tree.split("\n").map((line) => `  ${line}`).join("\n");
}

/**
 * @param {string} diff
 * @returns {Destination[]}
 */
function parseTree(diff) {
  const destinations = [];
  /** @type {{name: string, step: string | null, background: boolean}[]} */
  const stack = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) continue;
    const parsed = TREE_LINE_RE.exec(line);
    if (parsed === null || parsed[3].trim() === "") continue;
    const [, marker, indent, rest] = parsed;
    const depth = rest === line.slice(2 + indent.length) && !/^[├└]─ /.test(line.slice(2 + indent.length)) ? 0 : indent.length / 3 + 1;
    stack.length = depth;
    const { text, context } = splitContext(rest);
    if (text.startsWith("○ ")) {
      const destination = undefang(text.slice(2).trim());
      const chain = stack.map((node) => node.name);
      const step = [...stack].reverse().find((node) => node.step !== null)?.step ?? null;
      const origin = stack.some((node) => node.background) ? "runner background" : "workload";
      const change = marker === "+" ? "added" : marker === "-" ? "removed" : "unchanged";
      destinations.push({ destination, change, origin, chain, step, context, noise: noiseReason({ destination, change, origin, context, chain }) });
      continue;
    }
    const step = /^step: "(.*)"$/.exec(context ?? "")?.[1] ?? null;
    stack.push({ name: text.trim(), step, background: /\brunner background\b/.test(context ?? "") });
  }
  return destinations;
}

/**
 * Explain why a changed destination is runner or platform noise rather than
 * workload behavior. Unchanged rows are never noise; they are not a change.
 *
 * @param {Pick<Destination, "destination" | "change" | "origin" | "context" | "chain">} row
 * @returns {string | null}
 */
export function noiseReason({ destination, change, origin, context, chain }) {
  if (change === "unchanged") return null;
  const host = destination.split(" ")[0];
  if (origin === "runner background") return "runner background: the runner's infrastructure, not the workflow";
  if (/\bgithub infra\b|\brotated from\b/.test(context ?? "")) return "GitHub infrastructure address rotation";
  if (/\bdns resolver\b/.test(context ?? "")) return "local DNS resolver";
  if (/\bgarnet sensor\b/.test(context ?? "")) return "Garnet sensor traffic";
  if (ACTIONS_RESULTS_RE.test(host) && chain[0] === "Runner.Worker") {
    return "GitHub Actions results-storage shard rotation (Runner.Worker upload), not workflow code";
  }
  return null;
}

/**
 * @param {string} text
 * @returns {{text: string, context: string | null}}
 */
function splitContext(text) {
  const match = /^(.*?)\s+\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/.exec(text);
  if (match === null) return { text, context: null };
  if (/^\d{1,3}(?:\.\d{1,3}){3}$|:/.test(match[2]) && match[1].startsWith("○ ")) {
    return { text: `${match[1]} (${match[2]})`, context: null };
  }
  return { text: match[1], context: match[2] };
}

/**
 * @param {string} value
 * @returns {string}
 */
function undefang(value) {
  return value.replaceAll("[.]", ".");
}

/**
 * @param {string} value
 * @returns {string}
 */
function decodeEntities(value) {
  return value.replaceAll("&amp;", "&").replaceAll("&nbsp;", " ").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
}
