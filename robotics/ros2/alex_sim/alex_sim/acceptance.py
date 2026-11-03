"""ROS-independent evidence contracts for v0.12 simulation acceptance.

This module never sends velocity commands or invokes a robot controller.
"""
from dataclasses import dataclass
from math import hypot, isfinite


@dataclass(frozen=True)
class Waypoint:
    name: str
    x: float
    y: float


# The same grid-cell centers as the canonical 0.1m Alex household map.
DOCK = Waypoint('dock', 0.7, 2.8)
DESK = Waypoint('study_desk', 1.7, 1.6)
STORY = Waypoint('story_corner', 4.9, 1.7)
ACCEPTANCE_ROUTE = (DESK, STORY, DOCK)


def goal_arrival_heading(start_pose, goal):
    """Heading along the actual travel leg, not the map's arbitrary +X axis.

    Differential drive arrivals should not demand an unnecessary last-metre
    turn to yaw=0 near household furniture. This changes only the requested
    final orientation; canonical target coordinates and proof tolerance stay.
    """
    from math import atan2, cos, sin
    if (start_pose is None or len(start_pose) != 2
            or not all(isfinite(float(v)) for v in start_pose)):
        raise ValueError('INVALID_GOAL_START_POSE')
    dx, dy = goal.x - start_pose[0], goal.y - start_pose[1]
    if hypot(dx, dy) < 0.01:
        raise ValueError('GOAL_TOO_CLOSE_FOR_TRAVEL_HEADING')
    yaw = atan2(dy, dx)
    return yaw, sin(yaw / 2.0), cos(yaw / 2.0)


def distance_to(goal, pose):
    if pose is None or len(pose) != 2 or not all(isfinite(v) for v in pose):
        raise ValueError('MISSING_OR_NONFINITE_ROBOT_POSE')
    return hypot(goal.x - pose[0], goal.y - pose[1])


def verify_arrival(goal, pose, *, status, feedback_count, tf_fresh, odom_distance_m, start_distance_m, tolerance=0.12):
    """Require successful Nav2 action AND independently observed fresh TF pose."""
    if status != 'SUCCEEDED':
        raise ValueError('NAV2_ACTION_NOT_SUCCEEDED')
    if not tf_fresh:
        raise ValueError('STALE_OR_MISSING_MAP_TF')
    if feedback_count < 1:
        raise ValueError('MISSING_NAV2_FEEDBACK')
    if not isfinite(odom_distance_m) or odom_distance_m < 0:
        raise ValueError('INVALID_ODOMETRY_EVIDENCE')
    if start_distance_m >= 0.5 and odom_distance_m < 0.4:
        raise ValueError('ROBOT_HAS_NOT_TRAVELLED')
    error = distance_to(goal, pose)
    if error > tolerance:
        raise ValueError(f'GOAL_POSE_OUTSIDE_TOLERANCE:{error:.3f}m')
    return round(error, 4)


def verify_graph(seen, frames, action_ready, clock_advanced):
    required = {'clock', 'scan', 'odom', 'map'}
    missing = sorted(required.difference(seen))
    if missing:
        raise ValueError('ROS_TOPICS_MISSING:' + ','.join(missing))
    for edge in (('odom', 'base_link'), ('map', 'odom'), ('base_link', 'lidar_link')):
        if edge not in frames:
            raise ValueError('ROS_TF_MISSING:' + '->'.join(edge))
    if not clock_advanced:
        raise ValueError('SIMULATION_CLOCK_NOT_ADVANCING')
    if not action_ready:
        raise ValueError('NAV2_ACTION_UNAVAILABLE')


def summarize_leg(goal, tf_pose, *, status, feedback_count, tf_fresh, odom_distance_m, start_distance_m, elapsed, tolerance=0.12):
    err = verify_arrival(goal, tf_pose, status=status, feedback_count=feedback_count,
                         tf_fresh=tf_fresh, odom_distance_m=odom_distance_m,
                         start_distance_m=start_distance_m, tolerance=tolerance)
    return {'goal': goal.name, 'x': goal.x, 'y': goal.y,
            'pose_x': round(tf_pose[0], 4), 'pose_y': round(tf_pose[1], 4),
            'position_error_m': err, 'feedback_count': feedback_count,
            'odom_distance_m': round(odom_distance_m, 3),
            'wall_seconds': round(elapsed, 2), 'verified': True}


# ROS-agnostic graph diagnostics. Missing data must NEVER satisfy acceptance.
GRAPH_TF_EDGES = (('odom', 'base_link'), ('map', 'odom'), ('base_link', 'lidar_link'))
GRAPH_TOPICS = ('/clock', '/scan', '/odom', '/map', '/tf', '/tf_static')


def graph_readiness_snapshot(seen, frames, clock_times, *, odom_samples,
                             scan_samples, scan_ranges, map_valid,
                             tf_fresh, nav2_ready, observed_topics=(), publisher_counts=None):
    """Return bounded evidence for ROS_GRAPH_TIMEOUT without importing rclpy.

    The snapshot is diagnostic only; the existing strict verify_graph / TF
    checks remain the authoritative gate for navigation and acceptance.
    """
    missing = []
    if 'clock' not in seen:
        missing.append('clock_missing')
    elif len(clock_times) < 2 or clock_times[-1] <= clock_times[0]:
        missing.append('clock_not_advancing')
    if 'scan' not in seen or scan_samples == 0:
        missing.append('scan_missing')
    elif scan_ranges < 10:
        missing.append('scan_insufficient_ranges')
    if 'odom' not in seen or odom_samples == 0:
        missing.append('odom_missing')
    elif odom_samples < 2:
        missing.append('odom_insufficient_samples')
    if not map_valid:
        missing.append('map_missing_or_invalid')
    for parent, child in GRAPH_TF_EDGES:
        if (parent, child) not in frames:
            missing.append('tf_missing:' + parent + '->' + child)
    if not tf_fresh:
        missing.append('map_to_base_link_tf_not_fresh')
    if not nav2_ready:
        missing.append('navigate_to_pose_not_ready')

    hints = []
    if 'clock_missing' in missing or 'clock_not_advancing' in missing:
        hints.append('Check Gazebo server lifecycle and /clock GZ_TO_ROS bridge in acceptance-launch.log')
    if any(x.startswith('scan_') for x in missing):
        hints.append('Check Gazebo gpu_lidar EGL/OGRE2 rendering and /scan ros_gz_bridge')
    if any(x.startswith('odom_') or x == 'tf_missing:odom->base_link' for x in missing):
        hints.append('Check Gazebo DiffDrive, /odom and /tf Pose_V bridge')
    if 'map_missing_or_invalid' in missing:
        hints.append('Check Nav2 map_server activation and alex_home.yaml map dimensions')
    if 'tf_missing:base_link->lidar_link' in missing:
        hints.append('Check robot_state_publisher /tf_static and robot_description')
    if 'tf_missing:map->odom' in missing or 'map_to_base_link_tf_not_fresh' in missing:
        hints.append('Check AMCL initial pose, laser scans and the full map->odom->base_link TF chain')
    if 'navigate_to_pose_not_ready' in missing:
        hints.append('Check Nav2 lifecycle manager /bt_navigator startup and action server')
    return {
        'ready_candidate': not missing,
        'missing': missing,
        'hints': hints,
        'clock_observations': len(clock_times),
        'odom_samples': odom_samples,
        'scan_samples': scan_samples,
        'scan_ranges': scan_ranges,
        'map_valid': bool(map_valid),
        'tf_fresh': bool(tf_fresh),
        'nav2_action_ready': bool(nav2_ready),
        'observed_tf_edges': [f'{a}->{b}' for a, b in sorted(frames)][:32],
        'observed_topics': sorted(set(observed_topics))[:80],
        'publishers': {name: max(0, int((publisher_counts or {}).get(name, 0)))
                       for name in GRAPH_TOPICS},
    }
