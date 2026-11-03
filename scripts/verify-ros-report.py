#!/usr/bin/env python3
"""Validate live three-leg ROS acceptance evidence before reporting success.

This is a final evidence consistency check, not a replacement for running Gazebo.
"""
import argparse
import json
from math import isfinite
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'robotics/ros2/alex_sim'))
from alex_sim.acceptance import ACCEPTANCE_ROUTE  # noqa: E402


def verify_report(report):
    if not isinstance(report, dict) or report.get('schema') != 'alex.dev/ros-acceptance/v1':
        raise ValueError('INVALID_ACCEPTANCE_SCHEMA')
    if report.get('status') != 'passed' or report.get('mode') != 'route':
        raise ValueError('ROUTE_NOT_PASSED')
    if report.get('simulation_only') is not True:
        raise ValueError('NOT_SIMULATION_ONLY')
    if 'clock_scan_odom_map_tf_nav2_ready' not in report.get('checks', []):
        raise ValueError('MISSING_ROS_GRAPH_PROOF')
    legs = report.get('legs')
    if not isinstance(legs, list) or len(legs) != len(ACCEPTANCE_ROUTE):
        raise ValueError('INCOMPLETE_NAVIGATION_ROUTE')
    for goal, leg in zip(ACCEPTANCE_ROUTE, legs):
        if not isinstance(leg, dict) or leg.get('goal') != goal.name or leg.get('verified') is not True:
            raise ValueError('UNVERIFIED_GOAL:' + goal.name)
        if not (leg.get('x') == goal.x and leg.get('y') == goal.y):
            raise ValueError('WRONG_GOAL_COORDINATES:' + goal.name)
        def finite_number(name, lower, upper):
            value = leg.get(name)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value) or not lower <= value <= upper:
                raise ValueError('INVALID_LEG_' + name.upper() + ':' + goal.name)
            return value
        finite_number('position_error_m', 0, 0.12)
        finite_number('odom_distance_m', 0.4, 100)
        finite_number('wall_seconds', 0.01, 600)
        finite_number('feedback_count', 1, 1_000_000)
        x = finite_number('pose_x', -1000, 1000)
        y = finite_number('pose_y', -1000, 1000)
        from math import hypot
        if hypot(x - goal.x, y - goal.y) > 0.12:
            raise ValueError('POSE_DISAGREES_WITH_REPORTED_ERROR:' + goal.name)
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', required=True)
    args = parser.parse_args()
    try:
        data = json.loads(Path(args.report).read_text(encoding='utf8'))
        verify_report(data)
    except (OSError, ValueError, TypeError) as exc:
        print('ROS acceptance report INVALID:', exc, file=sys.stderr)
        return 1
    print('ROS acceptance report validated: route, graph and three independently verified goals')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
