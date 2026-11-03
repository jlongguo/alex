#!/usr/bin/env bash
# Reproducible, hardware-free Ubuntu 24.04 / ROS 2 Jazzy Gazebo simulation.
# Usage: bash scripts/docker-sim.sh setup|check|preflight|accept|all|shell|logs|down|doctor
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="$ROOT/docker-compose.sim.yml"
IMAGE="alex-ros-sim:jazzy-harmonic"
REPORTS="$ROOT/.local/ros"

usage() {
  cat <<'HELP'
Alex Docker ROS simulation (Ubuntu 24.04 / Jazzy / Harmonic)
  setup      Build the container image and prepare local reports directory
  check      Run npm tests and ROS asset/Launch offline checks inside container
  preflight  Require the container's ROS prerequisites to be ready
  accept     Run real Gazebo/Nav2 three-goal navigation acceptance (can take time)
  all        setup -> check -> preflight -> accept (stops on first failure)
  shell      Start an interactive container shell
  logs       Show current host-side acceptance diagnostics and launch log
  down       Stop and remove Compose-managed containers, preserve report files
  doctor     Verify host Docker/Compose availability; no simulation started
  help       Print this help

No hardware devices or host network are mapped. A successful image build is NOT a
successful navigation test. Acceptance evidence remains in .local/ros/.
HELP
}

msg() { printf '[alex docker-sim] %s\n' "$*"; }
die() { printf '[alex docker-sim] ERROR: %s\n' "$*" >&2; exit 2; }

require_docker() {
  command -v docker >/dev/null 2>&1 || die 'Docker is missing. Install Docker Engine / Docker Desktop first.'
  docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 is required (docker compose ...).'
  docker info >/dev/null 2>&1 || die 'Docker daemon is not running or access is denied.'
  [[ -f "$COMPOSE" ]] || die "Missing $COMPOSE"
}

compose() { docker compose -f "$COMPOSE" --project-directory "$ROOT" "$@"; }

prepare() {
  mkdir -p "$REPORTS"
  export ALEX_DOCKER_UID="${ALEX_DOCKER_UID:-$(id -u)}"
  export ALEX_DOCKER_GID="${ALEX_DOCKER_GID:-$(id -g)}"
  [[ "$ALEX_DOCKER_UID" =~ ^[0-9]+$ && "$ALEX_DOCKER_GID" =~ ^[0-9]+$ ]] || die 'ALEX_DOCKER_UID and ALEX_DOCKER_GID must be numeric.'
  # The bind-mounted source must remain owned by its regular host user.
}

build() {
  msg 'Building ROS 2 Jazzy / Gazebo Harmonic image (first build downloads apt packages)...'
  compose build sim
}

ensure_image() {
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    build
  fi
}

# Docker named volumes are initially root-owned. Correct ONLY the container-only
# node_modules volume with a temporary CAP_CHOWN; normal ROS/npm stays nonroot.
init_node_modules() {
  local owner="${ALEX_DOCKER_UID}:${ALEX_DOCKER_GID}"
  msg "Preparing Docker node_modules volume for UID:GID $owner"
  if ! compose run --rm -T --no-deps --user 0:0 --cap-add CHOWN sim bash -lc \
      "set -euo pipefail; target=/workspace/alex/node_modules; current=\$(stat -c '%u:%g' \"\$target\"); if [[ \"\$current\" != '$owner' ]]; then chown -R -- '$owner' \"\$target\"; fi"; then
    die 'Could not initialize the Docker dependency volume. Check Docker volume ownership and user namespace settings.'
  fi
}

run_sim() {
  ensure_image
  init_node_modules
  # Normal service retains cap_drop ALL and no-new-privileges.
  compose run --rm -T sim bash -lc \
    "test -w /workspace/alex/node_modules || { echo 'Docker node_modules is not writable by the nonroot service user' >&2; exit 2; }; $1"
}

npm_setup='npm install --ignore-scripts --no-package-lock --no-audit --no-fund'

command_check() {
  msg 'Running regression tests and offline ROS asset checks inside container'
  run_sim "$npm_setup && npm test && npm run sim:check"
}

command_preflight() {
  msg 'Checking the actual container ROS installation (blocked is a nonzero result)'
  run_sim 'python3 scripts/ros-preflight.py --require --json .local/ros/preflight.json'
}

command_accept() {
  # A failed build or npm install must never leave an old 'passed' report behind.
  rm -f "$REPORTS/acceptance-report.json" "$REPORTS/diagnostics.json"
  msg 'Running real Gazebo/Nav2 acceptance. Success requires a verified three-leg report.'
  run_sim "$npm_setup && npm run sim:accept"
}

show_logs() {
  if [[ -f "$REPORTS/preflight.json" ]]; then
    printf '\n--- Preflight ---\n'; cat "$REPORTS/preflight.json"
  fi
  if [[ -f "$REPORTS/acceptance-report.json" ]]; then
    printf '\n--- Acceptance report ---\n'; cat "$REPORTS/acceptance-report.json"
  fi
  if [[ -f "$REPORTS/diagnostics.json" ]]; then
    printf '\n--- Diagnostics ---\n'; cat "$REPORTS/diagnostics.json"
  fi
  if [[ -f "$REPORTS/acceptance-launch.log" ]]; then
    printf '\n--- Launch log (last 120 lines) ---\n'; tail -n 120 "$REPORTS/acceptance-launch.log"
  fi
  if [[ ! -d "$REPORTS" ]]; then
    msg 'No acceptance files yet. Run: bash scripts/docker-sim.sh preflight'
  fi
}

main() {
  local action="${1:-help}"
  if (( $# > 1 )); then die 'Expected one command; see help.'; fi
  case "$action" in
    help|-h|--help) usage; return 0 ;;
    logs) show_logs; return 0 ;;
    setup|build|check|preflight|accept|all|shell|down|doctor) ;;
    *) usage >&2; die "Unknown command: $action" ;;
  esac
  require_docker
  prepare
  case "$action" in
    doctor)
      msg "Host: $(uname -s) / $(uname -m)"
      msg "Docker: $(docker --version)"
      docker compose version
      msg 'Container uses software/host-supported EGL. GPU LiDAR on Docker Desktop may be unavailable.'
      ;;
    setup|build) build; init_node_modules ;;
    check) command_check ;;
    preflight) command_preflight ;;
    accept) command_accept ;;
    all) rm -f "$REPORTS/acceptance-report.json" "$REPORTS/diagnostics.json"; build; command_check; command_preflight; command_accept ;;
    shell) ensure_image; init_node_modules; compose run --rm sim bash ;;
    down) compose down ;;
  esac
}

main "$@"
