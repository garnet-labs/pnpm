#!/bin/sh
set -eu

: "${GVS_RUNTIME_NODE:?}"
: "${GVS_TRACE_FILE:?}"

node_bin=$(which node)
root_tool_bin=$(which garnet-root-tool 2>/dev/null || true)

{
  echo "lifecycle.path=$PATH"
  echo "node.which=$node_bin"
  echo "node.real=$(readlink -f "$node_bin")"
  echo "root-tool.which=${root_tool_bin:-missing}"
  if [ -n "$root_tool_bin" ]; then
    echo "root-tool.real=$(readlink -f "$root_tool_bin")"
  else
    echo "root-tool.real=missing"
  fi
} > "$GVS_TRACE_FILE"

node -e 'const fs = require("node:fs"); fs.appendFileSync(process.env.GVS_TRACE_FILE, `node-runtime.execPath=${fs.realpathSync(process.execPath)}\n`)'

if [ -n "$root_tool_bin" ]; then
  "$root_tool_bin"
else
  echo "root-tool.invoked=missing" >> "$GVS_TRACE_FILE"
fi
