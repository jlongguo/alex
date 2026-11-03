# Nav2 NavigateToPose lifecycle race on live Gazebo acceptance

User's macOS Docker run proved clock, 360-point laser scan, odometry, map,
fresh map->odom->base_link TF and advertised NavigateToPose action.
The first Nav2 goal was rejected while bt_navigator was still configuring.
The launch log explicitly says 'Action server is inactive. Rejecting the goal.'
About three wall seconds later the lifecycle manager recorded
'Managed nodes are active'.

The former ActionClient.server_is_ready() gate only checks discovery;
it does not establish an ACTIVE lifecycle node.

Acceptance now reads /bt_navigator/get_state and requires the real
lifecycle response ID 3 (ACTIVE) as well as an available action before
each NavigateToPose request. It waits asynchronously with a bounded
poll and records `nav2_lifecycle` evidence in the acceptance report.

If the node never becomes active: NAV2_LIFECYCLE_ACTIVE_TIMEOUT.
If a goal is rejected after activation: NAV2_GOAL_REJECTED; no blind
resubmission. All scan, TF, odometry, Nav2 feedback, arrival tolerance,
three-leg and simulation-only acceptance requirements remain unchanged.

    bash scripts/docker-sim.sh accept
    python3 -m json.tool .local/ros/acceptance-report.json
    grep -nE 'inactive|Activating bt_navigator|Managed nodes are active|goal' .local/ros/acceptance-launch.log

Static or CI success does not prove real three-leg navigation.
