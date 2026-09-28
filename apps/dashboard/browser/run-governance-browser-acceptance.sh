#!/bin/sh
set -eu

temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/marea-governance-browser-proof.XXXXXX")
log_file="$temp_dir/server.log"
server_pid=""
browser_pid=""
build_pid=""
server_pids_file="$temp_dir/server.pids"
browser_pids_file="$temp_dir/browser.pids"
build_pids_file="$temp_dir/build.pids"
: >"$server_pids_file"
: >"$browser_pids_file"
: >"$build_pids_file"

owned_running() {
  pid=$1
  state=$(ps -p "$pid" -o state= 2>/dev/null | tr -d '[:space:]' || true)
  case "$state" in
    ""|Z*) return 1 ;;
    *) return 0 ;;
  esac
}

owned_tree() {
  tree_root=$1
  tree_seen=" $tree_root "
  tree_frontier=$tree_root
  printf '%s\n' "$tree_root"
  while [ -n "$tree_frontier" ]; do
    tree_next=""
    for tree_parent in $tree_frontier; do
      for tree_child in $(
        ps -axo pid=,ppid= 2>/dev/null | awk -v parent="$tree_parent" '$2 == parent {print $1}'
      ); do
        case "$tree_seen" in
          *" $tree_child "*) continue ;;
        esac
        tree_seen="$tree_seen$tree_child "
        tree_next="$tree_next $tree_child"
        printf '%s\n' "$tree_child"
      done
    done
    tree_frontier=$tree_next
  done
}

record_owned_process() {
  record_pid=$1
  record_file=$2
  record_started=$(ps -p "$record_pid" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' || true)
  record_command=$(ps -p "$record_pid" -o command= 2>/dev/null | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' || true)
  [ -n "$record_started" ] && [ -n "$record_command" ] || return 0
  if ! awk -F '\t' -v pid="$record_pid" '$1 == pid {found = 1; exit} END {exit !found}' \
    "$record_file"
  then
    printf '%s\t%s\t%s\n' "$record_pid" "$record_started" "$record_command" >>"$record_file"
  fi
}

record_owned_tree() {
  record_root=$1
  record_file=$2
  [ -n "$record_root" ] || return 0
  for record_pid in $(owned_tree "$record_root"); do
    record_owned_process "$record_pid" "$record_file"
  done
}

record_matches_current_process() {
  match_pid=$1
  match_file=$2
  recorded_started=$(awk -F '\t' -v pid="$match_pid" '$1 == pid {print $2; exit}' "$match_file")
  current_started=$(ps -p "$match_pid" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' || true)
  [ -n "$recorded_started" ] && [ "$recorded_started" = "$current_started" ]
}

is_owned_root() {
  candidate_pid=$1
  root_pid=$2
  allow_unwaited_root=$3
  [ "$candidate_pid" = "$root_pid" ] || return 1
  candidate_parent=$(ps -p "$candidate_pid" -o ppid= 2>/dev/null | tr -d '[:space:]' || true)
  # An unwaited PID is not sufficient ownership if the shell already reaped it.
  [ "$candidate_parent" = "$$" ]
}

signal_owned_processes() {
  signal_file=$1
  signal_name=$2
  signal_label=$3
  signal_root=$4
  signal_allow_unwaited_root=$5
  signal_failed=0
  for signal_pid in $(awk -F '\t' '{p[NR] = $1} END {for (i = NR; i >= 1; i--) print p[i]}' "$signal_file"); do
    if owned_running "$signal_pid"; then
      if is_owned_root "$signal_pid" "$signal_root" "$signal_allow_unwaited_root" || \
        record_matches_current_process "$signal_pid" "$signal_file"; then
        kill "-$signal_name" "$signal_pid" 2>/dev/null || true
      else
        echo "refusing to signal changed $signal_label pid $signal_pid" >&2
        signal_failed=1
      fi
    fi
  done
  [ "$signal_failed" -eq 0 ]
}

owned_processes_running() {
  running=0
  identity_failed=0
  running_file=$1
  running_root=$2
  running_allow_unwaited_root=$3
  while IFS="$(printf '\t')" read -r running_pid running_command; do
    [ -n "$running_pid" ] || continue
    if owned_running "$running_pid"; then
      if is_owned_root "$running_pid" "$running_root" "$running_allow_unwaited_root" || \
        record_matches_current_process "$running_pid" "$running_file"; then
        running=1
      else
        echo "refusing to treat changed pid $running_pid as an owned process" >&2
        identity_failed=1
      fi
    fi
  done <"$running_file"
  if [ "$running" -ne 0 ]; then return 0; fi
  if [ "$identity_failed" -ne 0 ]; then return 2; fi
  return 1
}

stop_owned_tree() {
  pid=$1
  name=$2
  pid_file=$3
  allow_unwaited_root=$4
  [ -n "$pid" ] || return 0
  record_owned_tree "$pid" "$pid_file"
  cleanup_failed=0
  signal_owned_processes "$pid_file" TERM "$name" "$pid" "$allow_unwaited_root" || cleanup_failed=1
  ticks=0
  while [ "$ticks" -lt 20 ]; do
    record_owned_tree "$pid" "$pid_file"
    if owned_processes_running "$pid_file" "$pid" "$allow_unwaited_root"; then
      running_status=0
    else
      running_status=$?
    fi
    if [ "$running_status" -eq 1 ]; then break; fi
    if [ "$running_status" -eq 2 ]; then cleanup_failed=1; break; fi
    sleep 0.05
    ticks=$((ticks + 1))
  done
  if owned_processes_running "$pid_file" "$pid" "$allow_unwaited_root"; then
    running_status=0
  else
    running_status=$?
  fi
  if [ "$running_status" -eq 0 ]; then
    echo "$name owned process tree did not stop after 1 second; sending KILL" >&2
    signal_owned_processes "$pid_file" KILL "$name" "$pid" "$allow_unwaited_root" || cleanup_failed=1
    ticks=0
    while [ "$ticks" -lt 20 ]; do
      if owned_processes_running "$pid_file" "$pid" "$allow_unwaited_root"; then
        running_status=0
      else
        running_status=$?
      fi
      if [ "$running_status" -eq 1 ]; then break; fi
      if [ "$running_status" -eq 2 ]; then cleanup_failed=1; break; fi
      sleep 0.05
      ticks=$((ticks + 1))
    done
  fi
  if owned_processes_running "$pid_file" "$pid" "$allow_unwaited_root"; then
    running_status=0
  else
    running_status=$?
  fi
  if [ "$running_status" -eq 0 ]; then
    echo "unable to verify cleanup of owned $name process tree; pids: $(awk -F '\t' '{print $1}' "$pid_file" | tr '\n' ' ')" >&2
    cleanup_failed=1
  elif [ "$running_status" -eq 2 ]; then
    cleanup_failed=1
  fi
  return "$cleanup_failed"
}

cleanup() {
  status=$?
  trap - EXIT INT TERM
  aggregate_cleanup_failed=0
  stop_owned_tree "$browser_pid" "browser" "$browser_pids_file" 0 || aggregate_cleanup_failed=1
  stop_owned_tree "$server_pid" "server" "$server_pids_file" 1 || aggregate_cleanup_failed=1
  stop_owned_tree "$build_pid" "build" "$build_pids_file" 0 || aggregate_cleanup_failed=1
  if [ "$aggregate_cleanup_failed" -eq 0 ] && [ "$status" -eq 0 ]; then
    if ! rm -rf "$temp_dir"; then
      echo "unable to remove owned proof artifacts: $temp_dir" >&2
      aggregate_cleanup_failed=1
    fi
  else
    echo "retaining failed proof diagnostics: $temp_dir" >&2
  fi
  if [ "$aggregate_cleanup_failed" -ne 0 ] && [ "$status" -eq 0 ]; then status=1; fi
  exit "$status"
}

trap cleanup EXIT
on_signal() {
  signal_exit=$1
  trap - INT TERM
  exit "$signal_exit"
}

trap 'on_signal 130' INT
trap 'on_signal 143' TERM

(bun run --cwd apps/dashboard build &&
  bun build apps/teacher-server/smoke/governance-browser-acceptance.ts --target=node --outfile "$temp_dir/server.mjs") &
build_pid=$!
build_deadline=$(( $(date +%s) + 60 ))
while owned_running "$build_pid"; do
  record_owned_tree "$build_pid" "$build_pids_file"
  if [ "$(date +%s)" -ge "$build_deadline" ]; then
    echo "Proof build exceeded its 60-second deadline" >&2
    exit 124
  fi
  sleep 0.1
done
wait "$build_pid"
GOVERNANCE_ACCEPTANCE_ROOT="$temp_dir" GOVERNANCE_DASHBOARD_DIST="$(pwd)/apps/dashboard/dist" node "$temp_dir/server.mjs" >"$log_file" 2>&1 &
server_pid=$!
record_owned_tree "$server_pid" "$server_pids_file"
deadline_ms=$(( $(node -p 'Date.now()') + 20000 ))
server_url=""
while [ "$(node -p 'Date.now()')" -lt "$deadline_ms" ]; do
  record_owned_tree "$server_pid" "$server_pids_file"
  server_url=$(sed -n 's/^GOVERNANCE_ACCEPTANCE_URL=//p' "$log_file" | head -n 1)
  [ -n "$server_url" ] && break
  if ! owned_running "$server_pid"; then break; fi
  sleep 0.1
done
if [ -z "$server_url" ]; then
  sed -n '1,160p' "$log_file" >&2
  exit 1
fi
if [ -n "${PLAYWRIGHT_NODE_PATH:-}" ]; then
  NODE_PATH="$PLAYWRIGHT_NODE_PATH${NODE_PATH:+:$NODE_PATH}"
  export NODE_PATH
fi
GOVERNANCE_ACCEPTANCE_ROOT="$temp_dir" GOVERNANCE_ACCEPTANCE_URL="$server_url" node apps/dashboard/browser/governance-browser-acceptance.mjs &
browser_pid=$!
record_owned_tree "$browser_pid" "$browser_pids_file"
browser_deadline=$(( $(date +%s) + 180 ))
while owned_running "$browser_pid"; do
  record_owned_tree "$browser_pid" "$browser_pids_file"
  if [ "$(date +%s)" -ge "$browser_deadline" ]; then
    echo "Browser proof exceeded its 180-second deadline" >&2
    exit 124
  fi
  sleep 0.1
done
set +e
wait "$browser_pid"
status=$?
set -e
if [ "$status" -ne 0 ]; then sed -n '1,160p' "$log_file" >&2; fi
exit "$status"
