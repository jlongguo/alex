# ROS /clock DDS Reliability compatibility (Jazzy / Harmonic)

A live Docker run explicitly logged incompatible RELIABILITY QoS on /clock.
Gazebo's bridge publishes with CLOCK QoS (BEST_EFFORT) while the acceptance
client requested default RELIABLE via integer depth 10; DDS rejects this
pairing even when a publisher is visible in the graph.

The acceptance client now requests BEST_EFFORT + VOLATILE for /clock and
SENSOR_DATA for /odom. It still requires advancing clock, valid scan, odom,
map, TF and Nav2 Action; no acceptance gate is weakened.

The read-only Gazebo probe was also corrected: no unsupported gz topic -n 1
flag, root /clock fallback, and no false world-not-running conclusion
when CLI discovery fails or times out. The supplied Gazebo startup log
showed world-control service initialization, so probe results must be
interpreted with their CLI status and timing.

After update:
    bash scripts/docker-sim.sh accept
    bash scripts/docker-sim.sh logs
    python3 -m json.tool .local/ros/acceptance-report.json
    python3 -m json.tool .local/ros/gz-transport.json

If clock starts arriving but odom or scan remains absent, inspect Gazebo
physics/robot plugins and GPU LiDAR EGL/OGRE2 behavior, not Nav2 timeouts.
Actual three-goal navigation remains unverified without the live report.
