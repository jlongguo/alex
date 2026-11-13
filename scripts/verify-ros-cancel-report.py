#!/usr/bin/env python3
"""R58 真实 Gazebo/Nav2 取消验收报告的只读严格校验，不连接 ROS 或物理设备。"""
import argparse
import json
from math import isfinite
from pathlib import Path
import re
import sys

RUN_ID = re.compile(r'^[A-Za-z0-9_-]{1,128}$')
REQUIRED_CHECKS = {
    'clock_scan_odom_map_tf_nav2_ready',
    'bt_navigator_lifecycle_active',
    'nav2_cancel_acknowledged',
    'nav2_cancel_terminal',
    'post_cancel_stop_observed',
}


def number(value, low, high):
    return (type(value) in (float, int) and isfinite(value)
            and low <= value <= high)


def verify_cancel_report(report, expected_run_id):
    if not isinstance(report, dict) or report.get('schema') != 'alex.dev/ros-cancel-acceptance/v1':
        raise ValueError('INVALID_CANCEL_SCHEMA')
    if report.get('status') != 'passed' or report.get('mode') != 'cancel-probe':
        raise ValueError('CANCEL_PROBE_NOT_PASSED')
    if (report.get('simulation_only') is not True
            or report.get('physical_safety_certified') is not False
            or report.get('release_approved') is not False):
        raise ValueError('INVALID_CANCEL_SCOPE')
    run_id = report.get('run_id')
    if not isinstance(run_id, str) or not RUN_ID.fullmatch(run_id):
        raise ValueError('INVALID_CANCEL_RUN_ID')
    if not expected_run_id or run_id != expected_run_id:
        raise ValueError('CANCEL_RUN_ID_MISMATCH')
    if report.get('legs') != []:
        raise ValueError('CANCEL_PROBE_IS_NOT_ROUTE')
    checks = report.get('checks')
    if not isinstance(checks, list) or not REQUIRED_CHECKS.issubset(set(
            x for x in checks if isinstance(x, str))):
        raise ValueError('MISSING_CANCEL_CHECKS')
    graph = report.get('graph')
    if not isinstance(graph, dict) or graph.get('missing') != []:
        raise ValueError('CANCEL_GRAPH_NOT_READY')
    if (graph.get('ready_candidate') is not True
            or graph.get('map_valid') is not True
            or graph.get('tf_fresh') is not True
            or graph.get('nav2_action_ready') is not True
            or not number(graph.get('clock_observations'), 2, 100000)
            or not number(graph.get('odom_samples'), 2, 100000)
            or not number(graph.get('scan_ranges'), 10, 100000)):
        raise ValueError('CANCEL_GRAPH_INCOMPLETE')
    if not set(('odom->base_link', 'map->odom', 'base_link->lidar_link')).issubset(
            set(graph.get('observed_tf_edges') or [])):
        raise ValueError('CANCEL_TF_INCOMPLETE')
    lifecycle = report.get('nav2_lifecycle')
    if (not isinstance(lifecycle, dict)
            or lifecycle.get('state_id') != 3
            or not number(lifecycle.get('active_responses'), 1, 100000)
            or lifecycle.get('last_error') is not None):
        raise ValueError('CANCEL_NAVIGATOR_NOT_ACTIVE')
    cancel = report.get('cancel')
    if not isinstance(cancel, dict) or cancel.get('goal') != 'study_desk':
        raise ValueError('CANCEL_GOAL_MISMATCH')
    if (cancel.get('goal_accepted') is not True
            or cancel.get('cancel_request_sent') is not True
            or cancel.get('cancel_acknowledged') is not True
            or cancel.get('terminal_status') != 'CANCELED'):
        raise ValueError('CANCEL_ACTION_NOT_CONFIRMED')
    if cancel.get('tf_fresh') is not True or cancel.get('odom_advanced') is not True:
        raise ValueError('CANCEL_STOP_SENSORS_NOT_FRESH')
    if (not number(cancel.get('position_drift_m'), 0, 0.08)
            or not number(cancel.get('observation_seconds'), 1.5, 5.0)
            or cancel.get('nonzero_velocity_commands') != 0
            or type(cancel.get('nonzero_velocity_commands')) is not int):
        raise ValueError('CANCEL_STOP_NOT_VERIFIED')
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', required=True, type=Path)
    parser.add_argument('--run-id', required=True)
    args = parser.parse_args()
    try:
        # 有界读取，避免误将大体量原始 ROS 日志当作结构化验收结果。
        if args.report.stat().st_size > 128 * 1024:
            raise ValueError('CANCEL_REPORT_TOO_LARGE')
        report = json.loads(args.report.read_text(encoding='utf8'))
        verify_cancel_report(report, args.run_id)
    except (OSError, ValueError, TypeError) as exc:
        print('ROS_CANCEL_REPORT_INVALID:' + type(exc).__name__, file=sys.stderr)
        return 1
    print('Gazebo Nav2 cancel evidence structurally verified; no physical safety claim')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
