#!/usr/bin/env python3
"""R63 Node -> Python -> Nav2 live bridge report verifier.

This validates report structure and conservative runtime claims. It does not
authenticate the self-hosted runner or independently observe TF/physical stop.
"""
import argparse
import json
from math import hypot, isfinite, pi
from pathlib import Path
import re
import sys

SCHEMA = 'alex.dev/nav2-bridge-live-acceptance/v1'
MODE = 'bridge-probe'
SOURCE = 'node-python-nav2-live'
RUN_ID = re.compile(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    re.I)
GOALS = (
    ('study_desk', 17.0, 16.0),
    ('dock', 7.0, 28.0),
)
REQUIRED_CHECKS = {
    'node_bridge_study_desk_arrived',
    'node_bridge_dock_arrived',
    'node_bridge_feedback_observed',
    'node_bridge_same_instance_reused',
}


def fail(code):
    raise ValueError(code)


def finite_number(value, low, high, code):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        fail(code)
    if not isfinite(value) or not low <= value <= high:
        fail(code)
    return float(value)


def verify_pose(value, x, y):
    if not isinstance(value, dict) or set(value) != {'x', 'y', 'heading'}:
        fail('NAV2_BRIDGE_INVALID_POSE')
    px = finite_number(value.get('x'), -1000, 1000, 'NAV2_BRIDGE_INVALID_POSE')
    py = finite_number(value.get('y'), -1000, 1000, 'NAV2_BRIDGE_INVALID_POSE')
    finite_number(value.get('heading'), -pi, pi, 'NAV2_BRIDGE_INVALID_POSE')
    # Node bridge itself accepts <= 0.5 grid-cell final distance; verifier must
    # not silently use a wider threshold.
    if hypot(px - x, py - y) > 0.5:
        fail('NAV2_BRIDGE_GOAL_POSE_UNVERIFIED')


def verify_bridge_report(report, expected_run_id=None):
    if not isinstance(report, dict) or report.get('schema') != SCHEMA:
        fail('NAV2_BRIDGE_INVALID_SCHEMA')
    if (report.get('mode') != MODE or report.get('status') != 'passed'
            or report.get('source') != SOURCE):
        fail('NAV2_BRIDGE_NOT_PASSED')
    if report.get('simulation_only') is not True:
        fail('NAV2_BRIDGE_NOT_SIMULATION_ONLY')
    if (report.get('physical_safety_certified') is not False
            or report.get('release_approved') is not False
            or report.get('independent_tf_verified') is not False):
        fail('NAV2_BRIDGE_OVERCLAIMED_EVIDENCE')
    if report.get('execution_class') != 'live-gazebo':
        fail('NAV2_BRIDGE_NOT_LIVE_GAZEBO')
    if report.get('runtime_chain') != 'node->python-rclpy->nav2-action':
        fail('NAV2_BRIDGE_WRONG_RUNTIME_CHAIN')
    run_id = report.get('run_id')
    if not isinstance(run_id, str) or not RUN_ID.fullmatch(run_id):
        fail('NAV2_BRIDGE_INVALID_RUN_ID')
    if expected_run_id is not None and expected_run_id != run_id:
        fail('NAV2_BRIDGE_RUN_ID_MISMATCH')
    if report.get('reason') is not None:
        fail('NAV2_BRIDGE_PASSED_WITH_REASON')

    checks = report.get('checks')
    if (not isinstance(checks, list) or len(checks) != len(REQUIRED_CHECKS)
            or len(set(checks)) != len(checks)
            or set(checks) != REQUIRED_CHECKS):
        fail('NAV2_BRIDGE_INCOMPLETE_CHECKS')

    legs = report.get('legs')
    if not isinstance(legs, list) or len(legs) != len(GOALS):
        fail('NAV2_BRIDGE_INCOMPLETE_ROUTE')
    for leg, (goal, x, y) in zip(legs, GOALS):
        if not isinstance(leg, dict):
            fail('NAV2_BRIDGE_INVALID_LEG')
        expected_keys = {
            'goal', 'status', 'verified', 'elapsed_ms', 'feedback_count',
            'moving_feedback_count', 'arrived_feedback_count',
            'first_sequence', 'last_sequence', 'max_progress', 'final_pose'
        }
        if set(leg) != expected_keys:
            fail('NAV2_BRIDGE_INVALID_LEG_FIELDS')
        if leg.get('goal') != goal or leg.get('status') != 'arrived':
            fail('NAV2_BRIDGE_WRONG_LEG_ORDER')
        if leg.get('verified') is not True:
            fail('NAV2_BRIDGE_UNVERIFIED_LEG')
        elapsed = leg.get('elapsed_ms')
        if type(elapsed) is not int or not 0 <= elapsed <= 300_000:
            fail('NAV2_BRIDGE_INVALID_ELAPSED')
        feedback = leg.get('feedback_count')
        moving = leg.get('moving_feedback_count')
        arrived = leg.get('arrived_feedback_count')
        first = leg.get('first_sequence')
        last = leg.get('last_sequence')
        progress = leg.get('max_progress')
        if (type(feedback) is not int or feedback < 3 or feedback > 10000
                or type(moving) is not int or moving < 1 or moving >= feedback
                or arrived != 1 or first != 1 or last != feedback
                or progress != 100):
            fail('NAV2_BRIDGE_INVALID_FEEDBACK_EVIDENCE')
        verify_pose(leg.get('final_pose'), x, y)

    bridge = report.get('bridge')
    if not isinstance(bridge, dict) or set(bridge) != {
            'active', 'stop_unconfirmed', 'final_pose'}:
        fail('NAV2_BRIDGE_INVALID_FINAL_STATE')
    if bridge.get('active') is not False or bridge.get('stop_unconfirmed') is not False:
        fail('NAV2_BRIDGE_NOT_IDLE')
    verify_pose(bridge.get('final_pose'), 7.0, 28.0)
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--run-id', required=True)
    args = parser.parse_args()
    try:
        if (not args.report.is_file() or args.report.is_symlink()
                or args.report.stat().st_size > 192 * 1024):
            fail('NAV2_BRIDGE_INVALID_FILE')
        report = json.loads(args.report.read_text(encoding='utf8'))
        verify_bridge_report(report, args.run_id)
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        code = str(exc)
        if not re.fullmatch(r'NAV2_BRIDGE_[A-Z0-9_]+', code):
            code = 'NAV2_BRIDGE_REPORT_INVALID'
        print(code, file=sys.stderr)
        return 1
    print('Node->Python->Nav2 Gazebo bridge report structurally verified')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
