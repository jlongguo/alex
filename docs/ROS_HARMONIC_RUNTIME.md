# Harmonic GPU lidar / clock integration diagnosis

This change corrects ROS/Gazebo interoperability details but does NOT prove that Docker can render a GPU lidar scan. ROS_GRAPH_TIMEOUT means one or more ROS graph prerequisites were absent.

- Gazebo Harmonic GPU lidar uses <lidar> and <gz_frame_id>, not legacy <ray> and <frame_id>.
- Gazebo may only expose /world/alex_home/clock if /clock is already published. The bridge now maps the world clock to ROS /clock.
- Gazebo starts at verbosity 4 to provide plugin and rendering diagnostics.

After applying the graph diagnostics prerequisite PR and this fix:

    bash scripts/docker-sim.sh accept
    bash scripts/docker-sim.sh logs
    python3 -m json.tool .local/ros/acceptance-report.json
    python3 -m json.tool .local/ros/diagnostics.json

Inspect graph.missing before attempting workarounds. A missing scan with valid clock/odom suggests rendering (OGRE2/EGL) or the bridge. Docker Desktop macOS may not provide GPU rendering. Do not disable scan, TF or Nav2 Action evidence to pass acceptance.

If the report lacks graph snapshots, apply the prior ROS graph diagnostics patch before retrying.
