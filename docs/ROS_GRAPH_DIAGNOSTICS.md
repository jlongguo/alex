# Debugging ROS_GRAPH_TIMEOUT in Alex Docker simulation

`ROS_GRAPH_TIMEOUT` means at least one **required** ROS observation was not
available. It does **not** prove that the LiDAR, DDS discovery, Gazebo, AMCL or
Nav2 is individually at fault. The check remains strict and never marks a
partial graph as a successful navigation.

## First reproduce with the same Docker image

```bash
bash scripts/docker-sim.sh accept
bash scripts/docker-sim.sh logs
python3 -m json.tool .local/ros/acceptance-report.json
python3 -m json.tool .local/ros/diagnostics.json
```

No image rebuild is needed when changing these bind-mounted scripts. The
colcon overlay is regenerated as part of the acceptance command.

`acceptance-report.json` now contains a `graph` object with `missing`,
`hints`, observed ROS topics, required topic publisher counts, TF edges and
sensor sample counts. During graph startup, snapshots are emitted every 15
seconds, including a final snapshot on timeout. A failed smoke test also
prints the last 90 lines of `acceptance-launch.log`, without concealing the
original exit status.

## Interpreting missing checks

| Missing item | Check first |
| --- | --- |
| `clock_missing` or `clock_not_advancing` | Did the Gazebo process start, load the world and bridge `/clock`? |
| `scan_missing` | Did GPU LiDAR render with EGL/OGRE2? Does `ros_gz_bridge` bridge `/scan`? |
| `odom_missing` / `tf_missing:odom->base_link` | DiffDrive SDF plugin, `/odom` and Gazebo `/tf` bridge |
| `map_missing_or_invalid` | Nav2 `map_server`, map dimensions 60 × 34 at 0.1 m resolution |
| `tf_missing:base_link->lidar_link` | `robot_state_publisher` and `/tf_static` |
| `tf_missing:map->odom` / `map_to_base_link_tf_not_fresh` | AMCL localization, initial pose and scan TF |
| `navigate_to_pose_not_ready` | Nav2 lifecycle and `bt_navigator` |

A working `sim:preflight` proves package availability **only**, not Gazebo
runtime operation. An empty ROS topic list suggests the launch crashed, DDS
could not discover peers, or the test had a different ROS domain; inspect the
launch log before assuming a specific cause.

For macOS Docker Desktop, software EGL/GPU LiDAR may be unavailable. Do not
remove `/scan` or TF requirements to force a pass. Use a compatible Linux host
when rendering is the blocker.

No actual robot motor or external shared ROS graph is involved. ROS Domain 77
is isolated to localhost in the simulation container.
