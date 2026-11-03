# Alex Docker Simulation (v0.15 deployment tooling)

**This deploys only the isolated Gazebo/Nav2 simulation environment. It does NOT control physical hardware.** ROS navigation acceptance is not complete until the real container run finishes and its three-leg evidence is validated.

## Requirements

- Docker Engine or Docker Desktop with Compose v2, Linux or macOS (Docker Desktop ARM64 is supported by the base image).
- Recommended: 6 CPU cores, 12+ GB memory, 15+ GB free disk space for the ROS/Gazebo image and build caches.
- Ubuntu 24.04 (Noble) inside the container, ROS 2 Jazzy and Gazebo Harmonic.
- Internet access during the initial image build for Docker images and Ubuntu/ROS apt packages.
- GPU LiDAR needs a usable EGL/OGRE2 rendering backend. On macOS Docker Desktop, rendering support may not be available; a Linux x86_64 host with appropriate GPU setup is more reliable. **Do not disable sensor checks to claim acceptance.**

## One-command setup

From repository root:

```bash
bash scripts/docker-sim.sh setup
bash scripts/docker-sim.sh check
bash scripts/docker-sim.sh preflight
bash scripts/docker-sim.sh accept
```

Or run the entire sequence (stops on first failure):

```bash
bash scripts/docker-sim.sh all
```

The `setup` command only builds the container image; it does not launch Gazebo. Each subsequent command uses an ephemeral container and the same bind-mounted source tree. It retains reports in `.local/ros/` on your host.

Other commands:

```bash
bash scripts/docker-sim.sh doctor # Check local Docker installation
bash scripts/docker-sim.sh shell  # Inspect ROS installation interactively
bash scripts/docker-sim.sh logs   # Display existing acceptance evidence/logs
bash scripts/docker-sim.sh down   # Stop Compose environment (reports preserved)
```

The first `check` or `accept` installs Node dependencies inside the bind-mounted repository using `npm install --ignore-scripts`. Host `node_modules` is shared with the container if present; if running on macOS and dependencies include platform-specific binaries in future, use a Linux-only source checkout or isolate node_modules into a Compose volume.

## Reports and criteria

The existing `npm run sim:accept` starts Gazebo + Nav2 in the container and attempts three goals (charging dock -> desk -> story corner -> dock). It checks Nav2 Action completion, feedback, fresh TF, robot pose, and measured odometry. Successful container startup, a `ready_to_attempt` preflight, or passing JS tests are **not** navigation acceptance.

Files (persist after the container exits):

- `.local/ros/preflight.json`
- `.local/ros/acceptance-report.json`
- `.local/ros/diagnostics.json`
- `.local/ros/acceptance-launch.log`

The deployment script clears any old acceptance success before attempting a new run. The existing v0.14 verifier checks the current run ID and all required navigation legs. A failed run has a nonzero exit code; read diagnostics rather than manually editing its JSON files.

## Troubleshooting

**`docker compose` unavailable:** install Docker Engine/Desktop and Compose plugin v2 and start the daemon.

**`permission denied` on `.local/ros`:** script maps the host UID:GID into the container; check the host directory ownership and Linux bind-mount permissions. Avoid running `sudo` unnecessarily.

**`ros2`/`gz` not found:** ensure `setup` finished and the script used the `alex-ros-sim:jazzy-harmonic` image. `bash scripts/docker-sim.sh shell` then `ros2 pkg prefix nav2_bringup` or `gz sim --versions`.

**Gazebo crashes / `/scan` missing:** verify graphics drivers and EGL/OGRE2 support. `ALEX_GZ_HEADLESS_RENDERING=0 bash scripts/docker-sim.sh accept` is a *diagnostic attempt*, not a workaround for missing `/scan`. Docker Desktop may not provide sufficient GPU support. Prefer native Linux Docker with a properly configured rendering backend.

**DDS topics don't appear:** ROS runs fully inside one container. The config isolates the graph to domain 77 and local discovery; run `ros2 topic list` from `bash scripts/docker-sim.sh shell` only while the simulator is running in the *same* container. A separate `shell` subcommand creates a different container and will not share the LOCALHOST discovery graph. For live ROS debugging, execute inside the acceptance container with `docker exec` while it is active or use the saved launch logs.

**Review source before use:** Docker images, ROS/apt dependencies and third-party components are installed during build. This configuration does not enable privileged mode, expose host devices or use host networking. It does not add physical emergency-stop controls.

## Validation status

The Dockerfile, Compose configuration and deployment script can be statically checked without Docker. A real Docker image build and Gazebo/Nav2 three-goal acceptance require a Docker-enabled host and valid rendering backend; until run, they remain unverified.
