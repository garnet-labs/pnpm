import { renderBrief } from "./runtime-review.js";

export const EVIDENCE_CHECK_NAME = "garnet/evidence";
const GITHUB_API = "https://api.github.com";
const MAX_ANCHORED_FILES = 20;
const MAX_CHECK_ANNOTATIONS = 50;
const MAX_TITLE = 255;
const MAX_SUMMARY = 65535;

/**
 * Reviewer-facing placement of a `get_runtime_review` result on the pull request head:
 * GitHub Actions workflow commands (annotations on the job's own check) and a
 * `garnet/evidence` check run with the same annotations. Both carry the head-bound
 * evidence sentence and every review-relevant destination change, anchored to the files
 * the diff touched. Anchoring is placement only: the record attributes destinations to
 * execution chains, not to lines, and the message says so.
 */

/**
 * @param {string|null|undefined} patch unified diff for one file, as GitHub's pulls/files returns it
 * @returns {number|null} first line of the first hunk in the new file, or null when the patch has no hunk
 */
export function firstHunkLine(patch) {
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/m.exec(patch ?? "");
  return hunk === null ? null : Math.max(1, Number(hunk[1]));
}

/**
 * @param {any} result a `get_runtime_review` result
 * @param {string[]} failOn assessments the caller treats as a failure
 * @returns {"failure"|"warning"|"notice"}
 */
export function annotationLevel(result, failOn = []) {
  if (failOn.includes(result.assessment)) return "failure";
  if (["workload-change", "undeterminable", "unavailable"].includes(result.assessment)) return "warning";
  return "notice";
}

/**
 * @param {any} result
 * @returns {string}
 */
export function annotationTitle(result) {
  const head = result.pull_request?.head_sha?.slice(0, 7) ?? "unknown";
  return `Garnet runtime evidence · ${result.assessment} · head ${head}`.slice(0, MAX_TITLE);
}

/**
 * The annotation body: the evidence sentence (or the reason no record is usable) and each
 * review-relevant destination change with its execution chain, step and job.
 *
 * @param {any} result
 * @returns {string}
 */
export function annotationMessage(result) {
  const lines = [result.evidence_sentence ?? result.reasons?.[0] ?? result.assessment_note ?? result.assessment];
  for (const row of result.review_relevant_changes ?? []) {
    const chain = (row.chain ?? []).join(" → ");
    lines.push(`${row.change === "added" ? "+" : "−"} ${row.destination}${chain ? ` — ${chain}` : ""}${row.step ? ` (step: ${row.step})` : ""} · ${row.job}`);
  }
  if ((result.review_relevant_changes ?? []).length > 0) {
    lines.push("The record binds destinations to execution chains, not to lines; this annotation marks a file the diff touched, not the line that caused the change.");
  }
  if (result.record?.comment_url) lines.push(`Record: ${result.record.comment_url}`);
  return lines.join("\n");
}

/**
 * One annotation per changed file (first hunk line), or a single file-less annotation when
 * the diff has no anchorable file. Files are anchored in the order GitHub lists them.
 *
 * @param {any} result
 * @param {{filename: string, patch?: string|null}[]} files the pull request's changed files
 * @param {{failOn?: string[]}} [options]
 * @returns {{path: string|null, line: number|null, level: "failure"|"warning"|"notice", title: string, message: string}[]}
 */
export function buildAnnotations(result, files = [], { failOn = [] } = {}) {
  const level = annotationLevel(result, failOn);
  const title = annotationTitle(result);
  const message = annotationMessage(result);
  const anchors = files
    .filter((file) => typeof file?.filename === "string" && firstHunkLine(file.patch) !== null)
    .slice(0, MAX_ANCHORED_FILES)
    .map((file) => ({ path: file.filename, line: firstHunkLine(file.patch), level, title, message }));
  return anchors.length > 0 ? anchors : [{ path: null, line: null, level, title, message }];
}

const COMMANDS = { failure: "error", warning: "warning", notice: "notice" };

function escapeData(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(value) {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/**
 * GitHub Actions workflow command for one annotation (`::error file=…,line=…,title=…::message`).
 *
 * @param {{path: string|null, line: number|null, level: "failure"|"warning"|"notice", title: string, message: string}} annotation
 * @returns {string}
 */
export function renderWorkflowCommand(annotation) {
  const props = [];
  if (annotation.path) props.push(`file=${escapeProperty(annotation.path)}`, `line=${annotation.line}`);
  props.push(`title=${escapeProperty(annotation.title)}`);
  return `::${COMMANDS[annotation.level]} ${props.join(",")}::${escapeData(annotation.message)}`;
}

/**
 * Payload for `POST /repos/{owner}/{repo}/check-runs` on the pull request head. The conclusion is
 * `failure` when the assessment is in `failOn` and `neutral` otherwise: the check publishes
 * evidence, it does not approve.
 *
 * @param {any} result
 * @param {{failOn?: string[], name?: string, annotations?: ReturnType<typeof buildAnnotations>}} [options]
 * @returns {Record<string, unknown>}
 */
export function buildCheckRun(result, { failOn = [], name = EVIDENCE_CHECK_NAME, annotations = [] } = {}) {
  const summary = [result.evidence_sentence ?? result.reasons?.[0] ?? null, result.assessment_note ?? null].filter(Boolean).join("\n\n");
  return {
    name,
    head_sha: result.pull_request.head_sha,
    status: "completed",
    conclusion: failOn.includes(result.assessment) ? "failure" : "neutral",
    ...(result.record?.comment_url ? { details_url: result.record.comment_url } : {}),
    output: {
      title: annotationTitle(result),
      summary: (summary || result.assessment).slice(0, MAX_SUMMARY),
      text: renderBrief(result),
      annotations: annotations
        .filter((annotation) => annotation.path !== null)
        .slice(0, MAX_CHECK_ANNOTATIONS)
        .map((annotation) => ({
          path: annotation.path,
          start_line: annotation.line,
          end_line: annotation.line,
          annotation_level: annotation.level,
          title: annotation.title,
          message: annotation.message,
        })),
    },
  };
}

function headers(token, extra = {}) {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "garnet-runtime-review-cli",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

/**
 * @param {string} repository `owner/name`
 * @param {number} number pull request number
 * @param {{fetchImpl?: typeof fetch, githubToken?: string|null}} [options]
 * @returns {Promise<{filename: string, patch?: string|null}[]>} first 100 changed files
 */
export async function fetchPullFiles(repository, number, { fetchImpl = fetch, githubToken = null } = {}) {
  const response = await fetchImpl(`${GITHUB_API}/repos/${repository}/pulls/${number}/files?per_page=100`, { headers: headers(githubToken) });
  if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${repository}#${number} files`);
  const files = await response.json();
  return Array.isArray(files) ? files : [];
}

/**
 * @param {string} repository `owner/name`
 * @param {Record<string, unknown>} payload from `buildCheckRun`
 * @param {{fetchImpl?: typeof fetch, githubToken: string}} options
 * @returns {Promise<{id: number, html_url: string}>}
 */
export async function createCheckRun(repository, payload, { fetchImpl = fetch, githubToken }) {
  const response = await fetchImpl(`${GITHUB_API}/repos/${repository}/check-runs`, {
    method: "POST",
    headers: headers(githubToken, { "content-type": "application/json" }),
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status} creating the ${payload.name} check run (needs checks: write)`);
  const data = await response.json();
  return { id: data.id, html_url: data.html_url };
}
