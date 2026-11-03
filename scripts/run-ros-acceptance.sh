#!/usr/bin/env bash
# Simulation-only automated Gazebo + Nav2 acceptance. Never attach to hardware.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
report="${ALEX_ROS_REPORT:-$ROOT/.local/ros/acceptance-report.json}"
log="${ALEX_ROS_LOG:-$ROOT/.local/ros/acceptance-launch.log}"
preflight="${ALEX_ROS_PREFLIGHT:-$ROOT/.local/ros/preflight.json}"
mkdir -p "$(dirname "$report")" "$(dirname "$log")" "$(dirname "$preflight")"
# Overwrite any stale success before checking even the simulation opt-in flags.
python3 scripts/ros-evidence.py --report "$report" --status blocked --reason 'PREFLIGHT_PENDING'
launcher=''
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [[ -n "$launcher" ]]; then
    kill -TERM -- "-$launcher" 2>/dev/null || true
    wait "$launcher" 2>/dev/null || true
  fi
  if (( status != 0 )); then
    python3 scripts/ros-evidence.py --report "$report" --status failed --reason 'ACCEPTANCE_EXITED_BEFORE_RESULT' --if-status running >/dev/null || true
  fi
  python3 scripts/diagnose-ros-acceptance.py --report "$report" --preflight "$preflight" \
    --log "$log" --out "${ALEX_ROS_DIAGNOSTICS:-$ROOT/.local/ros/diagnostics.json}" >/dev/null || true
  exit "$status"
}
trap cleanup EXIT
if [[ "${ALEX_ROS_SIMULATION_ONLY:-}" != "1" || "${ALEX_RUN_ROS_INTEGRATION:-}" != "1" ]]; then
  echo 'Set ALEX_ROS_SIMULATION_ONLY=1 and ALEX_RUN_ROS_INTEGRATION=1; simulation ONLY.' >&2
  exit 2
fi
if [[ "${ROS_DISTRO:-}" != jazzy ]]; then echo 'ROS 2 Jazzy must be sourced first.' >&2; exit 2; fi
# Explicitly isolate the test graph. Refuse a user-supplied non-isolated domain.
export ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-77}"
export ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST
if [[ "$ROS_DOMAIN_ID" != 77 ]]; then echo 'Refusing non-dedicated ROS_DOMAIN_ID (expected 77)' >&2; exit 2; fi
if ! python3 scripts/ros-preflight.py --require --json "$preflight"; then
  echo "ROS prerequisites unavailable; see $preflight. No Gazebo acceptance performed." >&2
  exit 2
fi
# Source the same freshly built overlay into this process before launching
# Gazebo AND before invoking ros_smoke.py. A child shell's sourced overlay
# cannot modify this parent process (v0.13 could fail importing alex_sim).
# shellcheck disable=SC1091
source "$ROOT/scripts/prepare-ros-sim.sh"
# GPU LiDAR depends on a rendering backend; prefer EGL headless when running acceptance.
export ALEX_GZ_HEADLESS_RENDERING="${ALEX_GZ_HEADLESS_RENDERING:-1}"
python3 scripts/ros-evidence.py --report "$report" --status running --reason 'ROS_PROCESS_STARTING'
export ALEX_ROS_ACCEPTANCE_RUN_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "$report")"
if [[ -z "$ALEX_ROS_ACCEPTANCE_RUN_ID" ]]; then echo 'Acceptance run ID missing' >&2; exit 2; fi
# New process group: terminate Gazebo and ROS children on exit, not just npm.
setsid bash -c 'exec env ALEX_WITH_NAV2=true npm run sim:launch' >"$log" 2>&1 &
launcher=$!
sleep 2
if ! kill -0 "$launcher" 2>/dev/null; then
  echo "Gazebo launch terminated early. See $log" >&2
  tail -40 "$log" >&2 || true
  exit 1
fi
npm run sim:smoke -- --route --timeout 120 --goal-timeout 180 --report "$report"
# Never accept a graph-only, single-leg or malformed / stale report as success.
if ! python3 scripts/verify-ros-report.py --report "$report" --run-id "$ALEX_ROS_ACCEPTANCE_RUN_ID"; then
  python3 scripts/ros-evidence.py --report "$report" --status failed --reason 'REPORT_VERIFICATION_FAILED' --if-status passed >/dev/null || true
  exit 1
fi
printf 'Acceptance evidence: %s\nLaunch log: %s\n' "$report" "$log"
