/**
 * The check line: one sentence per pull request head, templated from the structured facts of a
 * `get_runtime_review` result and the pull request's changed files. Three outcomes:
 *
 *   nothing new         the workload connected to nothing it had not connected to in the compared run
 *   new behaviour       at least one workload destination was added or removed, with its execution chain
 *   capture incomplete  the record cannot support either claim (missing, pending, another head, capture
 *                       not declared complete, first recorded run, unreadable)
 *
 * Every clause is a fact the result already carries. No model, no free text, no approval: the line
 * says what the recorded job connected to and what the diff touches; the reviewer decides about the PR.
 */

export const CHECK_LINE_OUTCOMES = Object.freeze(["nothing new", "new behaviour", "capture incomplete"]);

const MAX_LINE = 255;
const MAX_NAMED_DESTINATIONS = 3;
const MAX_FULL_CHAIN = 4;
const SEPARATOR = " · ";

const FILE_CLASSES = [
  ["lockfile", /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|flake\.lock|packages\.lock\.json)$/],
  ["manifest", /(^|\/)(package\.json|pnpm-workspace\.yaml|Cargo\.toml|go\.mod|pyproject\.toml|setup\.py|setup\.cfg|requirements[^/]*\.txt|Pipfile|Gemfile|composer\.json|[^/]+\.csproj|Dockerfile[^/]*|action\.ya?ml)$/],
  ["registry config", /(^|\/)(\.npmrc|\.yarnrc(\.yml)?|\.pnpmfile\.cjs|pip\.conf|\.pypirc|\.cargo\/config(\.toml)?|\.nuget\/NuGet\.Config|\.gitmodules)$/i],
  ["workflow", /^\.github\/(workflows|actions)\//],
];

/**
 * Observed strings (destinations, processes, steps, jobs) are run data, not instructions: one line,
 * no backticks, no control characters.
 *
 * @param {unknown} value
 * @returns {string}
 */
function plain(value) {
  return String(value ?? "").replace(/[`\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function short(sha) {
  return typeof sha === "string" && sha.length >= 7 ? sha.slice(0, 7) : null;
}

/**
 * Which of the file classes that commonly explain a new connection the diff touches. The clause
 * reports *touches*, never *explains*: nothing in the record attests the causal link yet.
 *
 * @param {{filename?: string}[]|null|undefined} files `pulls/{n}/files` rows, or null when not fetched
 * @returns {{inspected: boolean, partial: boolean, count: number, touched: Record<string, string[]>}}
 *   `partial` is true when GitHub returned only some pages of the diff; the clause then says so
 */
export function diffTouches(files) {
  if (!Array.isArray(files)) return { inspected: false, partial: false, count: 0, touched: {} };
  const touched = {};
  for (const file of files) {
    if (typeof file?.filename !== "string") continue;
    for (const [label, pattern] of FILE_CLASSES) {
      if (pattern.test(file.filename)) (touched[label] ??= []).push(file.filename);
    }
  }
  return { inspected: true, partial: files.partial === true, count: files.length, touched };
}

function jobLabels(result, rows) {
  const names = new Set();
  for (const row of rows) if (typeof row.job === "string") names.add(row.job.split(" / ").pop());
  if (names.size === 0) for (const job of result.jobs ?? []) if (typeof job?.job === "string") names.add(job.job);
  return [...names].map(plain);
}

/**
 * The facts the line is templated from. Only these fields reach the sentence.
 *
 * @param {any} result a `get_runtime_review` result
 * @param {{filename?: string}[]|null} [files] the pull request's changed files, or null when not fetched
 * @returns {Record<string, unknown>}
 */
export function buildCheckLineFacts(result, files = null) {
  const headSha = typeof result?.pull_request?.head_sha === "string" ? result.pull_request.head_sha : null;
  const record = result?.record ?? null;
  const rows = Array.isArray(result?.review_relevant_changes) ? result.review_relevant_changes : [];
  const facts = {
    outcome: "capture incomplete",
    reason: null,
    head_sha: headSha,
    compared_with: short(record?.compared_with),
    bound_to_head: record?.bound_to_head === true,
    assessment: typeof result?.assessment === "string" ? result.assessment : null,
    jobs: jobLabels(result ?? {}, rows),
    changes: rows.map((row) => ({
      change: row.change === "removed" ? "removed" : "added",
      destination: plain(row.destination),
      chain: Array.isArray(row.chain) ? row.chain.map(plain) : [],
      step: row.step ? plain(row.step).replace(/"/g, "") : null,
      job: plain(row.job),
    })),
    destinations: Number.isInteger(record?.counts?.destinations) ? record.counts.destinations : null,
    noise_total: Number.isInteger(result?.noise?.total) ? result.noise.total : 0,
    diff: diffTouches(files),
    first_seen: null,
  };
  if (headSha === null) {
    facts.reason = "pull request not readable";
    return facts;
  }
  const head = short(headSha);
  switch (facts.assessment) {
    case "workload-change":
      if (facts.bound_to_head && facts.changes.length > 0) facts.outcome = "new behaviour";
      else facts.reason = `record for head ${head} lists a workload change without its rows`;
      break;
    case "noise-only-change":
      if (facts.bound_to_head && facts.changes.length === 0) {
        facts.outcome = "nothing new";
        facts.reason = "workload unchanged; every changed destination is runner or platform noise";
      } else facts.reason = `record for head ${head} is not bound to this head`;
      break;
    case "no-change":
      if (facts.bound_to_head && result.verdict === "unchanged") {
        facts.outcome = "nothing new";
        facts.reason = "capture declared complete";
      } else facts.reason = `record for head ${head} cannot support a no-change claim`;
      break;
    case "first-snapshot":
      facts.reason = "first recorded run, no earlier run to compare";
      break;
    case "unavailable":
      facts.reason = staleReason(result, head) ?? `no record for head ${head} yet`;
      break;
    case "undeterminable":
      facts.reason = undeterminableReason(result, head);
      break;
    default:
      facts.reason = `record for head ${head} cannot be read`;
  }
  return facts;
}

/**
 * Binding is decided from the record's summary, so when the summary names another commit that
 * SHA is the one to show; the HTML marker can equal the head while the summary does not.
 */
function staleReason(result, head) {
  if (!result.record) return null;
  if (result.record.pending === true) return `record for head ${head} is still recording, not finalized`;
  if (result.record.bound_to_head !== false) return null;
  const first = typeof result.reasons?.[0] === "string" ? result.reasons[0] : "";
  const summaryCommit = short(first.match(/record is bound to ([0-9a-f]{40})/)?.[1]);
  const marker = short(result.record.marker_commit);
  const bound = summaryCommit ?? (marker !== head ? marker : null);
  if (bound === null && typeof result.record.marker_commit !== "string" && summaryCommit === null) return null;
  return bound ? `record is for commit ${bound}, not head ${head}` : `record is for another commit, not head ${head}`;
}

function undeterminableReason(result, head) {
  const first = typeof result.reasons?.[0] === "string" ? result.reasons[0] : "";
  const stale = staleReason(result, head);
  if (stale !== null) return stale;
  const quality = first.match(/capture_quality is "([^"]*)"/);
  if (quality) return `capture declared ${plain(quality[1])}, not complete, for head ${head}; a missed connection reads exactly like no change`;
  const status = first.match(/marker status is "([^"]*)"/);
  if (status) return `record for head ${head} is ${plain(status[1])}, not finalized`;
  if (/partial capture declaration/.test(first)) return `capture declaration for head ${head} is partial (status or capture_quality missing)`;
  if (/capture completeness is not declared/.test(first)) return `capture completeness not declared for head ${head}; a missed connection reads exactly like no change`;
  if (first === "") return `record for head ${head} cannot support a claim either way`;
  return plain(first).slice(0, 120);
}

function renderChain(chain) {
  if (chain.length === 0) return null;
  if (chain.length <= MAX_FULL_CHAIN) return chain.join(" → ");
  return `${chain[0]} → … → ${chain[chain.length - 2]} → ${chain[chain.length - 1]}`;
}

function renderNamedChanges(changes) {
  const named = changes.slice(0, MAX_NAMED_DESTINATIONS).map((row) => `${row.change === "added" ? "+" : "−"}${row.destination}`);
  const more = changes.length - named.length;
  return named.join(" ") + (more > 0 ? ` and ${more} more` : "");
}

function renderChanges(changes) {
  const parts = [renderNamedChanges(changes)];
  const chains = [...new Set(changes.map((row) => renderChain(row.chain)).filter((chain) => chain !== null))];
  if (chains.length === 1) parts.push(`via ${chains[0]}`);
  else if (chains.length > 1) parts.push(`via ${[...new Set(changes.map((row) => row.chain[row.chain.length - 1]).filter(Boolean))].join(", ")}`);
  const steps = [...new Set(changes.map((row) => row.step).filter((step) => step !== null))];
  if (steps.length === 1) parts.push(`at step "${steps[0]}"`);
  return parts.join(" ");
}

function renderDiff(diff) {
  if (!diff.inspected) return "diff not inspected";
  const labels = FILE_CLASSES.map(([label]) => label).filter((label) => Array.isArray(diff.touched[label]));
  const files = `${diff.count} ${diff.count === 1 ? "file" : "files"}`;
  if (diff.partial) {
    const touched = labels.length === 0 ? "none a lockfile, manifest, registry config or workflow" : `touches ${renderTouched(diff, labels)}`;
    return `diff partly inspected (first ${files} only), ${touched}`;
  }
  if (labels.length === 0) return `diff touches no lockfile, manifest, registry config or workflow (${files})`;
  return `diff touches ${renderTouched(diff, labels)}`;
}

function renderTouched(diff, labels) {
  return labels.map((label) => `${label} ${diff.touched[label].map((file) => file.split("/").pop()).slice(0, 2).join(", ")}`).join("; ");
}

function capLine(line) {
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
}

/**
 * @param {ReturnType<typeof buildCheckLineFacts>} facts
 * @returns {string} one line, at most 255 characters, no newlines
 */
export function renderCheckLine(facts) {
  const jobs = facts.jobs.length > 0 ? ` in ${facts.jobs.join(", ")}` : "";
  const parts = [facts.outcome];
  if (facts.outcome === "new behaviour") {
    parts.push(renderChanges(facts.changes) + jobs, renderDiff(facts.diff));
  } else if (facts.outcome === "nothing new" && facts.assessment === "noise-only-change") {
    parts.push(`workload unchanged${jobs}${facts.compared_with ? ` compared with ${facts.compared_with}` : ""}`, `${facts.noise_total} changed destinations, all runner or platform noise`);
  } else if (facts.outcome === "nothing new") {
    parts.push(`${facts.destinations ?? "all"} destinations${jobs}, all seen in ${facts.compared_with ?? "the compared run"}`, facts.reason);
  } else if (facts.assessment === "first-snapshot") {
    parts.push(`first recorded run${jobs}${facts.destinations !== null ? `, ${facts.destinations} destinations` : ""}, no earlier run to compare`);
  } else {
    parts.push(facts.reason);
  }
  const line = parts.filter((part) => typeof part === "string" && part !== "").join(SEPARATOR);
  return capLine(line);
}

/**
 * @param {ReturnType<typeof buildCheckLineFacts>} facts
 * @returns {string} outcome and destination names, or the full incomplete line, capped at 255 characters
 */
export function renderCheckTitle(facts) {
  let title;
  const compared = facts.compared_with ? ` compared with ${facts.compared_with}` : "";
  if (facts.outcome === "new behaviour") {
    title = `${facts.outcome} · ${renderNamedChanges(facts.changes)}${compared}`;
  } else if (facts.outcome === "nothing new") {
    title = `${facts.outcome} · workload unchanged${compared}`;
  } else {
    title = renderCheckLine(facts);
  }
  return capLine(title);
}

/**
 * @param {any} result a `get_runtime_review` result
 * @param {{filename?: string}[]|null} [files] the pull request's changed files, or null when not fetched
 * @returns {{outcome: "nothing new"|"new behaviour"|"capture incomplete", title: string, line: string, facts: Record<string, unknown>}}
 */
export function checkLine(result, files = null) {
  const facts = buildCheckLineFacts(result, files);
  return { outcome: facts.outcome, title: renderCheckTitle(facts), line: renderCheckLine(facts), facts };
}
