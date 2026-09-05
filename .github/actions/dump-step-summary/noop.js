const fs = require('fs')
const { spawn } = require('child_process')

// Sample the sensor's log size while the workload runs. This step precedes the
// Garnet step, so the file does not exist yet and the sampler tolerates that;
// the post step prints the series alongside the final size.
const samples = '/tmp/jibril-size-samples.txt'
const loop = `while true; do printf '%s %s %s\\n' "$(date -u +%H:%M:%S)" "$(stat -c %s /var/log/jibril.out 2>/dev/null || echo -)" "$(stat -c %s /var/log/jibril.profile.json 2>/dev/null || echo -)" >> ${samples}; sleep 60; done`
const child = spawn('/bin/bash', ['-c', loop], {
  detached: true,
  stdio: ['ignore', fs.openSync('/dev/null', 'w'), fs.openSync('/dev/null', 'w')],
})
child.unref()
console.log(`jibril.out size sampler started (pid ${child.pid}), 60s interval, series in ${samples}`)
