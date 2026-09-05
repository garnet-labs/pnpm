#!/usr/bin/env node
// Explicitly dispatched trusted default-branch collector. Artifacts are data only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {api, pages, read, authorizeCI, main as publishMain} from './garnet-dependabot-publish.mjs';

const MB = 1024 * 1024;
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const digest = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const numeric = value => /^[1-9]\d{0,19}$/.test(String(value ?? ''));

export function unpackDataArchive(zip, directory, name) {
  assert(/^garnet-(?:record-\d+-\d+-(?:base|head)|verification-\d+-\d+)$/.test(name), 'unsafe_artifact_name');
  const allowed = name.startsWith('garnet-verification-')
    ? ['verification.json', 'verifier.json'] : ['receipt.json', 'jibril.profile.json', 'workload.log'];
  const names = execFileSync('unzip', ['-Z1', zip], {encoding: 'utf8', timeout: 30000,
    maxBuffer: MB, stdio: ['ignore', 'pipe', 'pipe']}).trim().split('\n');
  assert(names.length > 0 && names.length <= allowed.length && new Set(names).size === names.length &&
    names.every(n => allowed.includes(n)), 'unexpected_archive_members');
  // Never unzip to a path. Stream explicitly allowed members into freshly
  // created ordinary files: ZIP symlinks, traversal and executable modes cannot act.
  fs.mkdirSync(directory, {mode: 0o700});
  for (const name of names) {
    const limit = name === 'workload.log' ? 64 * MB : name === 'jibril.profile.json' ? 128 * MB : MB;
    const bytes = execFileSync('unzip', ['-p', zip, name], {timeout: 30000,
      maxBuffer: limit, stdio: ['ignore', 'pipe', 'pipe']});
    assert(bytes.length <= limit, 'oversized_archive_member');
    fs.writeFileSync(path.join(directory, name), bytes, {flag: 'wx', mode: 0o600});
  }
}

export function validateCollectMetadata(a, name, run) {
  assert(a.name === name && numeric(a.id) && !a.expired &&
    String(a.workflow_run?.id) === String(run.id) && a.workflow_run?.head_sha === run.head_sha &&
    Number.isSafeInteger(a.size_in_bytes) && a.size_in_bytes > 0 && a.size_in_bytes <= 256 * MB &&
    /^sha256:[a-f0-9]{64}$/.test(a.digest || ''), 'untrusted_artifact_metadata');
}

export function waitForCompletedRun(repo, runId, {
  authorize = authorizeCI,
  sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  attempts = 25, interval = 5000,
} = {}) {
  // The verifier dispatches after upload, just before its worker run closes.
  // Authorization is repeated during this bounded wait; changed attempts/SHAs
  // fail immediately. No artifact is downloaded before completed is observed.
  for (let i = 0; i < attempts; i++) {
    const trust = authorize(repo, runId, {allowInProgress: true});
    if (trust.run.status === 'completed') return trust;
    if (i + 1 < attempts) sleep(interval);
  }
  throw new Error('worker_completion_wait_expired');
}

export function collectorMain() {
  assert(process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch',
    'collector_requires_trusted_workflow_dispatch');
  const repo = process.env.GITHUB_REPOSITORY;
  assert(/^garnet-labs\/[A-Za-z0-9_.-]+$/.test(repo || ''), 'invalid_repository');
  const event = JSON.parse(read(process.env.GITHUB_EVENT_PATH, MB));
  assert(numeric(event.inputs?.run_id), 'invalid_triggering_run');
  const runId = String(event.inputs.run_id);
  // Live path, ID, branch, same-repository identity, attempt and ancestry checks
  // precede every artifact download, not merely publication.
  const {run} = waitForCompletedRun(repo, runId);
  const metadata = pages(`repos/${repo}/actions/runs/${runId}/artifacts`, 'artifacts');
  const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'garnet-read-only-data-'));
  fs.chmodSync(root, 0o700);
  const names = ['base', 'head'].map(side => `garnet-record-${runId}-${run.run_attempt}-${side}`);
  names.push(`garnet-verification-${runId}-${run.run_attempt}`);
  for (const name of names) {
    const matches = metadata.filter(a => a.name === name);
    assert(matches.length <= 1, 'duplicate_attempt_artifact');
    if (!matches.length) continue; // Publisher decides if retained evidence is bound/incomplete.
    const a = matches[0];
    validateCollectMetadata(a, name, run);
    const bytes = execFileSync('gh', ['api',
      `repos/${repo}/actions/artifacts/${a.id}/zip`, '--method', 'GET'],
    {timeout: 120000, maxBuffer: 256 * MB, stdio: ['ignore', 'pipe', 'pipe']});
    assert(digest(bytes) === a.digest, 'downloaded_archive_digest_mismatch');
    const zip = path.join(root, `${name}.zip`);
    fs.writeFileSync(zip, bytes, {flag: 'wx', mode: 0o600});
    unpackDataArchive(zip, path.join(root, name), name);
  }
  const headFile = path.join(root, names[1], 'receipt.json');
  const receipt = JSON.parse(read(headFile, MB));
  const pr = receipt.snapshot?.pr_number;
  assert(Number.isSafeInteger(pr) && pr > 0 && pr <= 999999999, 'invalid_receipt_pr_number');
  // This number is only a lookup target. The publisher independently checks the
  // complete hashed snapshot, exact live head, author, immutable source and verifier.
  try {
    const bytes = execFileSync('gh', ['api',
      `repos/${repo}/actions/runs/${runId}/attempts/${run.run_attempt}/logs`, '--method', 'GET'],
    {timeout: 120000, maxBuffer: 128 * MB, stdio: ['ignore', 'pipe', 'pipe']});
    const logZip = path.join(root, 'actions-logs.zip');
    fs.writeFileSync(logZip, bytes, {flag: 'wx', mode: 0o600});
    const members = execFileSync('unzip', ['-Z1', logZip], {encoding: 'utf8', timeout: 30000,
      maxBuffer: MB, stdio: ['ignore', 'pipe', 'pipe']}).trim().split('\n');
    assert(members.length <= 10000 && members.every(n => !n.startsWith('/') &&
      !n.includes('\\') && !n.split('/').includes('..') && !/[\x00-\x1f]/.test(n)), 'unsafe_log_members');
    const lines = [];
    for (const member of members) {
      const m = /^(record \((?:base|head), [a-f0-9]{40}\))\/\d+_(Post Start trusted sensor using OIDC only)\.txt$/.exec(member);
      if (!m) continue;
      const text = execFileSync('unzip', ['-p', logZip, member], {encoding: 'utf8', timeout: 30000,
        maxBuffer: 8 * MB, stdio: ['ignore', 'pipe', 'pipe']});
      for (const line of text.replaceAll('\uFEFF', '').split('\n')) if (line) lines.push(`${m[1]}\t${m[2]}\t${line}`);
    }
    const log = lines.join('\n') + '\n';
    assert(Buffer.byteLength(log) <= 16 * MB, 'oversized_hosted_locator_logs');
    fs.writeFileSync(path.join(root, 'run.log'), log, {flag: 'wx', mode: 0o600});
  } catch { /* Hosted locators remain unverified/absent; capture status is unaffected. */ }
  const output = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'garnet-dependabot-publication');
  fs.mkdirSync(output, {recursive: true, mode: 0o700});
  try {
    const preview = publishMain(['--ci', '--repo', repo, '--pr', String(pr), '--run', runId,
      '--evidence', root, '--publish']);
    fs.writeFileSync(path.join(output, 'collector-result.json'), JSON.stringify({
      repository: repo, pr, run_id: runId, run_attempt: run.run_attempt,
      recording_verified: preview.verified, security_verdict: 'HOLD',
    }, null, 2) + '\n', {mode: 0o600});
  } finally {
    for (const name of ['publisher-preview.md', 'publisher-preview.json', 'publisher-result.json']) {
      if (fs.existsSync(path.join(root, name))) fs.copyFileSync(path.join(root, name), path.join(output, name));
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { collectorMain(); }
  catch (e) {
    console.error(`Collector stopped: ${/^[a-z0-9_]+$/.test(e?.message ?? '') ? e.message : 'data_or_api_validation_failed'}. No approval or merge was attempted.`);
    process.exitCode = 1;
  }
}
