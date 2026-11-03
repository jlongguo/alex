#!/usr/bin/env bash
# Local ROS 2 Jazzy + Gazebo Harmonic only. Never use with physical robots.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${ALEX_ROS_SIMULATION_ONLY:-}" != "1" ]]; then
  echo 'Set ALEX_ROS_SIMULATION_ONLY=1 to explicitly acknowledge simulation-only operation.' >&2
  exit 2
fi
if [[ -z "${ROS_DISTRO:-}" && -f /opt/ros/jazzy/setup.bash ]]; then
  # shellcheck disable=SC1091
  set +u
  source /opt/ros/jazzy/setup.bash
  set -u
fi
if [[ "${ROS_DISTRO:-}" != "jazzy" ]]; then
  echo 'ROS 2 Jazzy is required. Source /opt/ros/jazzy/setup.bash first.' >&2
  exit 2
fi
for exe in ros2 gz colcon python3; do
  if ! command -v "$exe" >/dev/null 2>&1; then echo "Missing executable: $exe" >&2;exit 2;fi
done
for pkg in ros_gz_sim ros_gz_bridge nav2_bringup nav2_common robot_state_publisher; do
  if ! ros2 pkg prefix "$pkg" >/dev/null 2>&1; then echo "Missing ROS package: $pkg" >&2;exit 2;fi
done
cd "$ROOT"
npm run sim:check
# All generated/build files remain in .local and never enter Git.
mkdir -p .local/ros
colcon --log-base "$ROOT/.local/ros/log" build --base-paths robotics/ros2/alex_sim \
  --build-base "$ROOT/.local/ros/build" --install-base "$ROOT/.local/ros/install" \
  --packages-select alex_sim --symlink-install --event-handlers console_direct+
# shellcheck disable=SC1091
set +u
source "$ROOT/.local/ros/install/setup.bash"
set -u
export ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-77}"
ros2 launch alex_sim sim.launch.py with_nav2:="${ALEX_WITH_NAV2:-true}"
