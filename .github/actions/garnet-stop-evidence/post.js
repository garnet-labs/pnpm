const { execSync } = require('node:child_process')

function run (label, command) {
  console.log(`::group::${label}`)
  try {
    console.log(execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  } catch (error) {
    console.log(`(${label} failed: ${error.message})`)
  }
  console.log('::endgroup::')
}

run('profile file', 'sudo ls -la /var/log/jibril.profile.json; sudo wc -c /var/log/jibril.profile.json')
run('profile.status.json (v2.18+)', 'sudo cat /var/run/jibril/profile.status.json')
run('jibril shutdown log', "sudo journalctl -u jibril.service --no-pager -o short-iso | grep -i -E 'shutdown|dispatcher|drain|profile|exec.*(timeout|finished)|stopp' | tail -n 80")
