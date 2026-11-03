#!/usr/bin/env bash
# Simulation-only automated Gazebo + Nav2 acceptance. Never attach to hardware.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${ALEX_ROS_SIMULATION_ONLY:-}" != "1" || "${ALEX_RUN_ROS_INTEGRATION:-}" != "1" ]]; then
  echo 'Set ALEX_ROS_SIMULATION_ONLY=1 and ALEX_RUN_ROS_INTEGRATION=1; simulation ONLY.' >&2
  exit 2
fi
if [[ "${ROS_DISTRO:-}" != jazzy ]]; then echo 'ROS 2 Jazzy must be sourced first.' >&2; exit 2; fi
if ! command -v ros2 >/dev/null || ! command -v gz >/dev/null || ! command -v setsid >/dev/null; then
  echo 'Missing ROS2, Gazebo, or setsid runtime; no acceptance run performed.' >&2
  exit 2
fi
cd "$ROOT"
mkdir -p .local/ros
report="$ROOT/.local/ros/acceptance-report.json"
log="$ROOT/.local/ros/acceptance-launch.log"
# Isolation: never talk to hardware / an arbitrary user's ROS domain.
export ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-77}"
export ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST
if [[ "$ROS_DOMAIN_ID" != 77 ]]; then echo 'Refusing non-dedicated ROS_DOMAIN_ID (expected 77)' >&2; exit 2; fi
# New process group: terminate Gazebo and ROS children on exit, not just npm.
setsid bash -c 'exec env ALEX_WITH_NAV2=true npm run sim:launch' >"$log" 2>&1 &
launcher=$!
cleanup() {
  kill -TERM -- "-$launcher" 2>/dev/null || true
  wait "$launcher" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
# ROS smoke waits for the graph; process exits early on launch failure.
export ALEX_RUN_ROS_INTEGRATION=1
sleep 2
if ! kill -0 "$launcher" 2>/dev/null; then
  echo "Gazebo launch terminated early. See $log" >&2
  tail -40 "$log" >&2 || true
  exit 1
fi
npm run sim:smoke -- --route --timeout 120 --goal-timeout 180 --report "$report"
printf 'Acceptance evidence: %s\nLaunch log: %s\n' "$report" "$log"
