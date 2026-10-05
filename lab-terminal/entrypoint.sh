#!/bin/sh
set -eu
mkdir -p /workspace
exec ttyd -W -b /terminal -p 7681 /usr/local/bin/lab-terminal-session
