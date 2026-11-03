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
