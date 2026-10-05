#!/bin/bash
# Capture a normalized verb and exit code only. Arguments, command output,
# plaintext secrets, and environment variables never leave the terminal.
__lab_command_verb() {
  local history_line="$1"
  local verb="other"
  local command_name
  if [[ "$history_line" =~ ^[[:space:]]*[0-9]+[[:space:]]+([^[:space:]]+) ]]; then
    command_name="${BASH_REMATCH[1]}"
    verb="${command_name##*/}"
  fi
  if [[ ! "$verb" =~ ^[a-zA-Z0-9_.-]{1,30}$ ]]; then
    verb="other"
  fi
  printf '%s' "$verb"
}

__lab_report_command() {
  local exit_code=$?
  local verb
  verb="$(__lab_command_verb "$(HISTTIMEFORMAT= history 1)")"
  curl -fsS --max-time 2 -X POST \
    -H "Content-Type: application/json" \
    -H "X-Lab-Terminal-Token: ${LAB_TERMINAL_TOKEN:-}" \
    --data "{\"verb\":\"${verb}\",\"exit_code\":${exit_code}}" \
    "${LEARNING_SERVICE_URL:-http://learning-service:8091}/api/events/terminal" >/dev/null 2>&1 || true
}
PROMPT_COMMAND=__lab_report_command
export PROMPT_COMMAND
