# macOS Docker Desktop: isolate OGRE2 rendering from the physics loop

Observed in a real Jazzy / Gazebo Harmonic run:
Gazebo loaded the world, DiffDrive and Sensors, but its last visible sensor
initialization was 'Loading plugin [gz-rendering-ogre2]'. The actual
ROS graph still missed dynamic clock/odom/scan data and Nav2 lacked odom TF.
This is evidence of a possible rendering initialization blocker, not proof.

## Rendering configuration

`docker-compose.sim.yml` now enables Mesa software GL for the Docker
simulation container: LIBGL_ALWAYS_SOFTWARE=1 and GALLIUM_DRIVER=llvmpipe.
The Dockerfile already installs libgl1-mesa-dri, EGL and GBM. Gazebo keeps
its --headless-rendering mode and the same GPU LiDAR and strict acceptance.
This is a compatibility attempt, not a promise that EGL works in Docker Desktop.
On a host with working passed-through graphics acceleration, override
`ALEX_LIBGL_ALWAYS_SOFTWARE=0 ALEX_GALLIUM_DRIVER=...` as appropriate.

## A/B isolation

    bash scripts/docker-sim.sh physics
    python3 -m json.tool .local/ros/physics-only.json

This separate diagnostic generates a *temporary* Alex world with the
Sensors system plugin removed; original map, robot SDF, physics, DiffDrive
and source assets remain unchanged. It starts a dedicated `gz sim -r -s`
process, checks Gazebo Transport clock progression and odometry, and
terminates its own process group. The report explicitly says
`physics_only_no_sensors` and cannot be accepted as Nav2 evidence.

If physics-only clock advances but full acceptance still has no clock,
the Sensors/OGRE2 initialization path is implicated. If physics-only also
fails to advance, investigate Gazebo server physics, transport and runtime
independently of the LiDAR. If clock/odom advance in both, examine
ROS/Gazebo topic bridging, QoS and separate GPU LiDAR sample delivery.

Only the unchanged `bash scripts/docker-sim.sh accept` and subsequent
strict three-leg report can establish navigation success.

## Re-run full simulation

    bash scripts/docker-sim.sh accept
    bash scripts/docker-sim.sh logs

Do NOT remove lidar or TF from acceptance checks to force a passing report.
On hosts without Mesa EGL support, using a native Linux simulation host
with compatible GPU software or devices may ultimately be required.
