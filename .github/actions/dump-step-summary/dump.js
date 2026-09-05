const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

// The sensor's own shutdown evidence. This post step runs after the Garnet
// post step, so the unit has already been stopped and its journal, exit
// status and log directory describe the completed flush.
// The sensor writes ~1.8 GB to /var/log/jibril.out on a run this long, so
// every probe over it is bounded: the ends verbatim, a filtered slice, and a
// histogram of message shapes over the first and last 200 MB.
const OUT = '/var/log/jibril.out'
const strip = "sed -e 's/\\x1b\\[[0-9;]*m//g'"
const shape = `awk '{ s = \"\"; for (i = 4; i <= 11 && i <= NF; i++) s = s \" \" $i; print substr(s, 2) }'`

const probes = [
  ['journal', 'sudo -n journalctl -u jibril.service --no-pager -o short-precise | tail -200'],
  ['unit', 'sudo -n systemctl show jibril.service -p Result -p ExecMainStatus -p ExecMainCode -p ActiveState -p SubState'],
  ['log dir', 'ls -la /var/log/jibril* 2>&1 || true'],
  ['unit file', 'sudo -n cat /etc/systemd/system/jibril.service 2>&1 || true'],
  [
    'config',
    `cfg=$(sudo -n cat /etc/systemd/system/jibril.service 2>/dev/null | grep -oE -- '--config[= ][^ ]+' | head -1 | sed -E 's/^--config[= ]//'); ` +
      'if [ -n "$cfg" ]; then echo "--config points at $cfg"; sudo -n cat "$cfg" 2>&1 | head -c 32K; else echo "no --config in ExecStart"; fi',
  ],
  ['out lines', `sudo -n wc -l ${OUT} 2>&1 || true`],
  ['out head', `sudo -n head -c 64K ${OUT} 2>/dev/null | ${strip}`],
  ['out tail', `sudo -n tail -c 512K ${OUT} 2>/dev/null | ${strip}`],
  [
    'out grep',
    `sudo -n grep -ai -E 'profil|flush|shutdown|stop|sigterm|panic|fatal|error' ${OUT} 2>/dev/null | tail -300 | ${strip}`,
  ],
  [
    'out shape histogram',
    `{ sudo -n head -c 200M ${OUT} 2>/dev/null; sudo -n tail -c 200M ${OUT} 2>/dev/null; } | ${strip} | ${shape} | sort | uniq -c | sort -rn | head -40`,
  ],
  ['size samples', 'cat /tmp/jibril-size-samples.txt 2>&1 || true'],
]
for (const [label, cmd] of probes) {
  console.log(`----- BEGIN jibril ${label} -----`)
  try {
    console.log(execSync(cmd, { shell: '/bin/bash', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trimEnd())
  } catch (err) {
    console.log(`probe failed: ${err.message}`)
    if (err.stdout) console.log(err.stdout.toString().trimEnd())
    if (err.stderr) console.log(err.stderr.toString().trimEnd())
  }
  console.log(`----- END jibril ${label} -----`)
}

// Each step gets its own GITHUB_STEP_SUMMARY file, so read every summary
// file in the runner's file-commands directory to capture summaries
// written by other steps' post actions.
const own = process.env.GITHUB_STEP_SUMMARY
if (!own) {
  console.log('GITHUB_STEP_SUMMARY not set')
} else {
  const dir = path.dirname(own)
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('step_summary_') && !f.includes('-scrubbed'))
  console.log(`summary files in ${dir}: ${files.length}`)
  for (const f of files) {
    const p = path.join(dir, f)
    const bytes = fs.readFileSync(p)
    console.log(`--- ${f}: ${bytes.length} bytes`)
    if (bytes.length === 0) continue
    // Prefix every line so nothing in the dump can start with "::" — the
    // Actions runner would otherwise interpret such lines as workflow
    // commands. The prefixed lines also stay subject to secret masking.
    console.log(`----- BEGIN ${f} -----`)
    for (const line of bytes.toString('utf8').split('\n')) {
      console.log(`| ${line}`)
    }
    console.log(`----- END ${f} -----`)
  }
}
