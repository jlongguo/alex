# ROS_GRAPH_TIMEOUT: publishers advertised but no data

Observed: ROS /clock, /scan and /odom each had one publisher, but no accepted messages.
Nav2 repeatedly lacked odom -> base_link. An advertised publisher is not a sample.

## Improvements

- Gazebo clock bridge now uses the recommended CLOCK ROS QoS.
- Failed acceptance probes the still-running Gazebo world service, stats, clock, odom
  and scan via bounded, read-only gz commands.
- Probe report is saved as .local/ros/gz-transport.json.
- Startup log first 100 lines and error lines are printed, as well as existing tail.
- No Nav2, scan, odom, TF or safety assertions are weakened.

## Read existing launch log before another run

    sed -n '1,180p' .local/ros/acceptance-launch.log
    grep -inE 'gz sim|gazebo|egl|ogre|render|fatal|exception|failed to|error:' .local/ros/acceptance-launch.log | head -90

## New acceptance run

    bash scripts/docker-sim.sh accept
    bash scripts/docker-sim.sh logs
    python3 -m json.tool .local/ros/gz-transport.json

No world service indicates Gazebo startup/model/plugin failure. Paused world:
sim time is not advancing. No world-clock message: the bridge has no clock
source. Clock exists but odom absent: inspect DiffDrive. Clock and odom present
but scan absent: inspect GPU LiDAR/EGL/OGRE2. Gazebo messages present but ROS
messages absent: investigate bridge mapping and QoS.

On macOS Docker Desktop, GPU rendering limitations are possible but unproven
without launch logs. The probe never controls the world or proves navigation.
