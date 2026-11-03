#!/usr/bin/env bash
# Local ROS 2 Jazzy + Gazebo Harmonic only. Never use with physical robots.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Must be sourced; package discovery and PYTHONPATH must survive into ros2 launch.
# shellcheck disable=SC1091
source "$ROOT/scripts/prepare-ros-sim.sh"
ros2 launch alex_sim sim.launch.py with_nav2:="${ALEX_WITH_NAV2:-true}"
