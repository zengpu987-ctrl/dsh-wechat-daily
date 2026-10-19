#!/bin/bash
# Runs as root. Probes whether task_for_pid works on the given pid.
PID="$1"
/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/var/root \
  /usr/bin/lldb -p "$PID" -b -s "$(dirname "$0")/probe.lldb" 2>&1
