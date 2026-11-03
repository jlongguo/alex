#!/usr/bin/env bash
# Source in the SAME shell that will run Nav2 and the acceptance client.
# No ROS process or hardware may be attached from this helper.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo 'Source scripts/prepare-ros-sim.sh; executing it cannot export a ROS overlay to the caller.' >&2
  exit 2
fi
set -euo pipefail
_ALEX_SIM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${ALEX_ROS_SIMULATION_ONLY:-}" != 1 ]]; then
  echo 'ALEX_ROS_SIMULATION_ONLY=1 is mandatory' >&2
  return 2
fi
if [[ -z "${ROS_DISTRO:-}" && -f /opt/ros/jazzy/setup.bash ]]; then
  set +u
  # shellcheck disable=SC1091
  source /opt/ros/jazzy/setup.bash
  set -u
fi
if [[ "${ROS_DISTRO:-}" != jazzy ]]; then
  echo 'ROS 2 Jazzy is required' >&2
  return 2
fi
export ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-77}"
if [[ "$ROS_DOMAIN_ID" != 77 ]]; then
  echo 'Refusing non-dedicated ROS_DOMAIN_ID: expected 77' >&2
  return 2
fi
export ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST
for _alex_cmd in ros2 gz colcon python3; do
  if ! command -v "$_alex_cmd" >/dev/null 2>&1; then
    echo "Missing ROS simulation executable: $_alex_cmd" >&2
    return 2
  fi
done
for _alex_pkg in ros_gz_sim ros_gz_bridge nav2_bringup nav2_common robot_state_publisher nav2_msgs tf2_ros; do
  if ! ros2 pkg prefix "$_alex_pkg" >/dev/null 2>&1; then
    echo "Missing ROS simulation package: $_alex_pkg" >&2
    return 2
  fi
done
_ALEX_EXPECTED_PARAMS="$_ALEX_SIM_ROOT/.local/ros/nav2_params.generated.yaml"
_ALEX_INSTALL="$_ALEX_SIM_ROOT/.local/ros/install"
if [[ "${ALEX_ROS_WORKSPACE_PREPARED:-}" != 1 ]]; then
  (cd "$_ALEX_SIM_ROOT" && npm run sim:check)
  _ALEX_NAV2_PREFIX="$(ros2 pkg prefix nav2_bringup)"
  _ALEX_NAV2_TEMPLATE="$_ALEX_NAV2_PREFIX/share/nav2_bringup/params/nav2_params.yaml"
  if [[ ! -f "$_ALEX_NAV2_TEMPLATE" ]]; then
    echo "Missing installed Nav2 params template: $_ALEX_NAV2_TEMPLATE" >&2
    return 2
  fi
  mkdir -p "$_ALEX_SIM_ROOT/.local/ros"
  python3 "$_ALEX_SIM_ROOT/robotics/ros2/alex_sim/alex_sim/nav2_tuning.py" \
    --input "$_ALEX_NAV2_TEMPLATE" --output "$_ALEX_EXPECTED_PARAMS"
  colcon --log-base "$_ALEX_SIM_ROOT/.local/ros/log" build \
    --base-paths "$_ALEX_SIM_ROOT/robotics/ros2/alex_sim" \
    --build-base "$_ALEX_SIM_ROOT/.local/ros/build" \
    --install-base "$_ALEX_INSTALL" \
    --packages-select alex_sim --symlink-install --event-handlers console_direct+
fi
if [[ ! -s "$_ALEX_EXPECTED_PARAMS" || ! -f "$_ALEX_INSTALL/setup.bash" ]]; then
  echo 'ROS simulation overlay or generated Nav2 parameters missing' >&2
  return 2
fi
export ALEX_ROS_NAV2_PARAMS_FILE="$_ALEX_EXPECTED_PARAMS"
# shellcheck disable=SC1091
set +u
source "$_ALEX_INSTALL/setup.bash"
set -u
_ALEX_ACTUAL_PREFIX="$(ros2 pkg prefix alex_sim 2>/dev/null || true)"
if [[ "$_ALEX_ACTUAL_PREFIX" != "$_ALEX_INSTALL/alex_sim" ]]; then
  echo "ROS overlay mismatch for alex_sim: $_ALEX_ACTUAL_PREFIX" >&2
  return 2
fi
export ALEX_ROS_WORKSPACE_PREPARED=1
unset _ALEX_CMD _ALEX_SIM_ROOT _ALEX_EXPECTED_PARAMS _ALEX_INSTALL _ALEX_ACTUAL_PREFIX _ALEX_NAV2_PREFIX _ALEX_NAV2_TEMPLATE _alex_cmd _alex_pkg
