# Root Gazebo clock versus world-qualified clock: observed Docker evidence

The macOS Docker physics-only probe reported 90 advancing clock observations
on Gazebo Transport /clock, plus real /odom samples. Gazebo Harmonic also
logged 'Found no publishers on /clock, adding root clock topic'.
The ROS bridge, however, listened to /world/alex_home/clock, which was not
shown to be published. A ROS topic can advertise a bridge publisher without
receiving any Gazebo data.

For Alex's isolated one-world Gazebo process, the bridge now subscribes to
Gazebo /clock and publishes ROS /clock with the existing CLOCK QoS.
Only one ROS clock publisher is bridged to avoid duplicate sources.

The failed-acceptance Transport probe now directly echoes /clock and
/world/alex_home/clock, /odom and /scan even with empty topic discovery.
Diagnostic output distinguishes topic advertisement from actual samples.

    bash scripts/docker-sim.sh accept
    bash scripts/docker-sim.sh logs
    python3 -m json.tool .local/ros/gz-transport.json
    python3 -m json.tool .local/ros/acceptance-report.json

If clock recovers but scan remains absent, inspect OGRE2/EGL GPU LiDAR
rendering in Docker Desktop independently of the clock bridge.
Only live three-goal Nav2 acceptance can establish navigation success.
