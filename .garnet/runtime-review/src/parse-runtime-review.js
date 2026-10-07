const SUMMARY_RE = /^<!-- garnet:summary (\{.*\}) -->$/m;
const COMMIT_RE = /^<!-- garnet:commit ([0-9a-f]{40}) -->$/m;

const COUNT_FIELDS = [
  "jobs",
  "changed",
  "unchanged",
  "noOutbound",
  "vanished",
  "added",
  "removed",
  "backgroundAdded",
  "backgroundRemoved",
  "vanishedDestinations",
  "chains",
  "destinations",
];

/**
 * @typedef {object} RuntimeReviewParseResult
 * @property {string} contractVersion
 * @property {{headSha: string, comparedSha: string | null, isComparison: boolean}} comparison
 * @property {Record<string, number | null>} counts
 * @property {string[] | null} kinds
 * @property {string | null} recordedAt
 * @property {string | null} capturedAt
 * @property {{ok: boolean, checks: Record<string, object>, errors: string[]}} selfCheck
 */

/**
 * Parse the machine register from a Garnet Runtime Review comment.
 *
 * The marker is the compatibility boundary: unknown future keys are ignored,
 * while the stable fields are normalized and the adjacent human surface is
 * checked for count drift.
 *
 * @param {string} body
 * @returns {RuntimeReviewParseResult}
 */
export function parseRuntimeReviewComment(body) {
  if (typeof body !== "string" || body === "") {
    throw new Error("parseRuntimeReviewComment requires a non-empty comment body");
  }

  const summaryMatch = SUMMARY_RE.exec(body);
  if (summaryMatch === null) {
    throw new Error("Garnet Runtime Review comment has no garnet:summary marker");
  }

  let summary;
  try {
    summary = JSON.parse(summaryMatch[1]);
  } catch (error) {
    throw new Error(`Invalid garnet:summary JSON: ${error.message}`);
  }
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    throw new Error("garnet:summary must contain a JSON object");
  }

  const headSha = requireSha(summary.commit, "commit");
  const comparedSha = summary.previous === null || summary.previous === undefined
    ? null
    : requireSha(summary.previous, "previous");
  const counts = {};
  for (const field of COUNT_FIELDS) {
    counts[field] = normalizeCount(summary[field], field);
  }

  const selfCheck = checkRenderedCounts(body, counts, comparedSha !== null);
  return {
    contractVersion: requireString(summary.contract, "contract"),
    comparison: {
      headSha,
      comparedSha,
      isComparison: comparedSha !== null,
    },
    counts,
    kinds: Array.isArray(summary.kinds)
      ? summary.kinds.filter((kind) => typeof kind === "string")
      : null,
    recordedAt: summary.recorded === null || summary.recorded === undefined
      ? null
      : requireString(summary.recorded, "recorded"),
    capturedAt: summary.recorded === null || summary.recorded === undefined
      ? null
      : requireString(summary.recorded, "recorded"),
    selfCheck,
  };
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number | null}
 */
function normalizeCount(value, field) {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`garnet:summary.${field} must be a non-negative integer or null`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireString(value, field) {
  if (typeof value !== "string" || value === "") {
    throw new Error(`garnet:summary.${field} must be a non-empty string`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireSha(value, field) {
  const sha = requireString(value, field);
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`garnet:summary.${field} must be a 40-character lowercase SHA`);
  }
  return sha;
}

/**
 * @param {string} body
 * @param {Record<string, number | null>} counts
 * @param {boolean} isComparison
 * @returns {{ok: boolean, checks: Record<string, object>, errors: string[]}}
 */
function checkRenderedCounts(body, counts, isComparison) {
  const checks = {};
  const errors = [];
  const headlineMatch = /\*\*Execution Profiles recorded for (\d+) jobs?\b/.exec(body);
  checks.jobsHeadline = compareCheck(
    counts.jobs,
    headlineMatch === null ? null : Number(headlineMatch[1]),
    "jobs headline",
    errors,
  );

  const snapshotMetaMatch = /> \*(\d+)&nbsp;destinations(?: across (\d+)&nbsp;jobs)?\*/.exec(body);
  if (!isComparison && snapshotMetaMatch !== null) {
    checks.snapshotMeta = compareCheck(
      counts.destinations,
      Number(snapshotMetaMatch[1]),
      "snapshot destinations",
      errors,
    );
    if (snapshotMetaMatch[2] !== undefined && counts.jobs !== null) {
      checks.snapshotMetaJobs = compareCheck(
        counts.jobs,
        Number(snapshotMetaMatch[2]),
        "snapshot metadata jobs",
        errors,
      );
    }
  } else {
    checks.snapshotMeta = {
      checked: false,
      reason: isComparison ? "comparison surface has no run-level destination total" : "destination metadata absent",
    };
  }

  if (isComparison) {
    // The renderer drops zero sides and inflects the unit: `+1&nbsp;−2&nbsp;destinations`,
    // `−1&nbsp;destination`, `+3&nbsp;destinations`.
    const deltaMatches = [...body.matchAll(/(?:\+(\d+)(?:&nbsp;−(\d+))?|−(\d+))&nbsp;destinations?\b/g)];
    const renderedAdded = deltaMatches.reduce((total, match) => total + Number(match[1] ?? 0), 0);
    const renderedRemoved = deltaMatches.reduce((total, match) => total + Number(match[2] ?? match[3] ?? 0), 0);
    checks.added = compareCheck(counts.added, renderedAdded, "added destinations", errors);
    checks.removed = compareCheck(counts.removed, renderedRemoved, "removed destinations", errors);

    const changedMatch = /(\d+)&nbsp;job(?:s)? changed\b/.exec(body);
    const unchangedMatch = /(\d+)&nbsp;job(?:s)? unchanged\b/.exec(body);
    const noOutboundMatch = /(\d+)&nbsp;job(?:s)? with no outbound destinations recorded/.exec(body);
    checks.changed = compareOptionalCheck(counts.changed, changedMatch, "changed jobs", errors);
    checks.unchanged = compareOptionalCheck(counts.unchanged, unchangedMatch, "unchanged jobs", errors);
    checks.noOutbound = compareOptionalCheck(counts.noOutbound, noOutboundMatch, "no-outbound jobs", errors);

    const vanishedMatch = /(\d+)&nbsp;job(?:s)? no longer recorded/.exec(body);
    checks.vanished = compareOptionalCheck(counts.vanished, vanishedMatch, "vanished jobs", errors);
    const vanishedDestinationsMatch = /no longer recorded · \d+ job\(s\) · (\d+) destination/.exec(body);
    checks.vanishedDestinations = compareOptionalCheck(
      counts.vanishedDestinations,
      vanishedDestinationsMatch,
      "vanished destinations",
      errors,
    );
    const currentComparisonDestinations = countCurrentComparisonDestinations(body);
    checks.destinations = compareCheck(
      counts.destinations,
      currentComparisonDestinations,
      "comparison destinations",
      errors,
    );
  } else if (counts.destinations !== null) {
    const snapshotFoldDestinations = countSnapshotFoldDestinations(body);
    if (snapshotFoldDestinations !== null || counts.destinations > 0) {
      checks.destinations = compareCheck(
        counts.destinations,
        snapshotFoldDestinations,
        "snapshot fold destinations",
        errors,
      );
    }
  }

  checks.chains = {
    checked: false,
    reason: "chain counts are machine-register-only and never render on the human surface",
  };
  return { ok: errors.length === 0, checks, errors };
}

/**
 * @param {string} body
 * @returns {number}
 */
function countCurrentComparisonDestinations(body) {
  let total = 0;
  for (const fence of body.matchAll(/```diff\n([\s\S]*?)\n```/g)) {
    for (const line of fence[1].split("\n")) {
      if (/^[ +].*○ /.test(line)) {
        total += 1;
      }
    }
  }
  for (const match of body.matchAll(/<summary>[^<]*.*?· (\d+)&nbsp;destinations · unchanged<\/summary>/g)) {
    total += Number(match[1]);
  }
  return total;
}

/**
 * @param {string} body
 * @returns {number | null}
 */
function countSnapshotFoldDestinations(body) {
  const matches = [...body.matchAll(/<summary>.*?· (\d+)&nbsp;destinations(?:<\/summary>| · unchanged<\/summary>)/g)];
  return matches.length === 0 ? null : matches.reduce((total, match) => total + Number(match[1]), 0);
}

/**
 * @param {number | null} expected
 * @param {number | null} actual
 * @param {string} label
 * @param {string[]} errors
 * @returns {object}
 */
function compareCheck(expected, actual, label, errors) {
  const ok = expected === actual;
  if (!ok) {
    errors.push(`${label} mismatch: marker=${String(expected)}, rendered=${String(actual)}`);
  }
  return { checked: true, expected, rendered: actual, ok };
}

/**
 * @param {number | null} expected
 * @param {RegExpExecArray | null} match
 * @param {string} label
 * @param {string[]} errors
 * @returns {object}
 */
function compareOptionalCheck(expected, match, label, errors) {
  if (expected === null) {
    return { checked: false, reason: `marker field ${label} is null` };
  }
  return compareCheck(expected, match === null && expected === 0 ? 0 : match === null ? null : Number(match[1]), label, errors);
}
