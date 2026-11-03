# Gazebo physics-only diagnostic: discovery and direct clock samples

The prior physics-only run successfully started the world but `gz topic --list`
returned empty, so the probe **never attempted** a clock subscription.
`clock_advanced: false` did not prove physics was frozen or OGRE2 the cause.

Gazebo Transport's default partition is HOSTNAME:USERNAME; its discovery
uses UDP multicast. The Compose simulation now sets a deterministic
GZ_PARTITION shared by Gazebo, ros_gz_bridge, and the probe. This may
eliminate partition ambiguity but cannot repair broken multicast transport.

The updated probe directly samples `/clock` and `/world/alex_home/clock`
even when topic discovery returns nothing, and also tries `/odom` directly.
Each attempt has a bounded subprocess timeout, and reports source topic,
message samples, discovery status, partition, and errors.

    bash scripts/docker-sim.sh physics
    python3 -m json.tool .local/ros/physics-only.json

If `clock_advanced: true`, Gazebo can advance without Sensors/OGRE2.
If direct echoes report no samples and `listed_topics` is empty, suspect
Transport discovery/multicast or simulator publishing; this is inconclusive
regarding physics. Observe `clock_echo_attempts`, `topic_list_stderr`,
`gz_partition`, and `startup_log_tail`.

Do not treat physics-only as three-goal Nav2 acceptance.
