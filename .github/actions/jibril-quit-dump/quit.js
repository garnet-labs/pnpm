const { execSync, spawn } = require('child_process')

// SIGQUIT makes the Go runtime print every goroutine's stack to stderr, which
// the unit redirects to /var/log/jibril.err, and then terminates the process.
// The sensor therefore does not survive this step: the stop it was given is
// cut short, and this cell's shutdown is not comparable to a cell that stops
// on its own. The point is the stack trace of a stop in progress.
const QUIT_AFTER_MS = 120_000
const STOP_TIMEOUT_MS = 1_800_000

function sh(cmd) {
  return execSync(cmd, { shell: '/bin/bash', encoding: 'utf8' }).trim()
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const pid = sh('systemctl show jibril.service -p MainPID --value')
  log(`sensor main pid ${pid}, state ${sh('systemctl is-active jibril.service || true')}`)

  const started = Date.now()
  const stop = spawn('/bin/bash', ['-c', 'sudo -n systemctl stop jibril.service'], { stdio: 'inherit' })
  let stopped = false
  stop.on('exit', (code) => {
    stopped = true
    log(`systemctl stop returned ${code} after ${Math.round((Date.now() - started) / 1000)}s`)
  })
  log('systemctl stop running in the background')

  await sleep(QUIT_AFTER_MS)

  if (stopped) {
    log('the stop finished before the dump was due; no SIGQUIT sent')
  } else {
    log(`sending SIGQUIT to ${pid} ${Math.round((Date.now() - started) / 1000)}s into the stop`)
    try {
      sh(`sudo -n kill -QUIT ${pid}`)
    } catch (err) {
      log(`SIGQUIT failed: ${err.message}`)
    }
  }

  while (!stopped && Date.now() - started < STOP_TIMEOUT_MS) {
    await sleep(5000)
  }
  if (!stopped) log(`stop still running after ${Math.round(STOP_TIMEOUT_MS / 1000)}s; giving up on waiting`)

  log(`unit now: ${sh('systemctl show jibril.service -p Result -p ExecMainStatus -p ExecMainCode -p ActiveState -p SubState | tr "\\n" " "')}`)
}

main()
