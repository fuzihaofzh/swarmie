#!/usr/bin/env bash
set -u -o pipefail

LOG_DIR="${LOG_DIR:-artifacts/test-gate}"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/test-gate-$(date -u +%Y%m%dT%H%M%SZ).log"
RELATED_ISSUE="${RELATED_ISSUE:-#62 #61 #34 #35}"

log_line() {
  local msg="$1"
  echo "$msg" | tee -a "$LOG_FILE"
}

log_evidence() {
  local cmd="$1"
  local exit_code="$2"
  local timestamp="$3"
  local result="$4"
  local key_evidence="$5"

  log_line "[EVIDENCE] command=${cmd} | exit_code=${exit_code} | timestamp=${timestamp} | result=${result} | key_evidence=${key_evidence} | related_issue=${RELATED_ISSUE}"
}

run_logged() {
  local cmd="$1"
  local start_ts end_ts exit_code result evidence

  start_ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  log_line "[START] ${start_ts} | cmd=${cmd}"

  env -u npm_config_prefix -u NPM_CONFIG_PREFIX bash -lc "$cmd" 2>&1 | tee -a "$LOG_FILE"
  exit_code=${PIPESTATUS[0]}

  end_ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  log_line "[END] ${end_ts} | exit_code=${exit_code} | cmd=${cmd}"
  result="pass"
  evidence="cmd_completed;log_file=${LOG_FILE}"
  if [[ "$exit_code" -ne 0 ]]; then
    result="fail"
    evidence="cmd_failed;check_log_file=${LOG_FILE}"
  fi
  log_evidence "$cmd" "$exit_code" "$end_ts" "$result" "$evidence"

  return "$exit_code"
}

status=0

log_line "[ENV] utc_now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
if [[ -n "${npm_config_prefix-}" || -n "${NPM_CONFIG_PREFIX-}" ]]; then
  log_line "[ENV_FIX] detected npm prefix override; commands will run with npm_config_prefix/NPM_CONFIG_PREFIX unset"
  log_evidence "env_check" "0" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "pass" "detected_prefix_override;auto_unset_for_subshell"
else
  log_evidence "env_check" "0" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "pass" "no_prefix_override_detected"
fi
run_logged "node -v" || status=1
run_logged "npm -v" || status=1
run_logged "npm test -- tests/server.test.ts tests/ws-client.test.ts" || status=1
run_logged "npm test" || status=1

log_line "[SUMMARY] final_exit_code=${status} | log_file=${LOG_FILE}"
final_result="pass"
final_evidence="all_gate_commands_passed;log_file=${LOG_FILE}"
if [[ "$status" -ne 0 ]]; then
  final_result="fail"
  final_evidence="one_or_more_gate_commands_failed;check_log_file=${LOG_FILE}"
fi
log_evidence "ci_test_gate_summary" "$status" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$final_result" "$final_evidence"
exit "$status"
