#!/usr/bin/env python3
"""R59 真实 Gazebo 导航超时/恢复证据校验：仅读取报告，不控制 ROS。

此模块复用 R58 的取消/停稳核验及 R55 路线的几何和里程标准；
任何结构缺失、超时未触发或恢复目标顺序错误都不能解除发布门槛。
"""
import argparse
import json
from math import hypot
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'robotics/ros2/alex_sim'))
from alex_sim.acceptance import DESK, DOCK  # noqa: E402
import importlib.util  # 标准库按路径加载脚本，避免改变现有校验器文件名。
CANCEL_VALIDATOR = Path(__file__).with_name('verify-ros-cancel-report.py')
_spec = importlib.util.spec_from_file_location('alex_ros_cancel_validator', CANCEL_VALIDATOR)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
verify_cancel_report, number = _module.verify_cancel_report, _module.number


def verify_recovery_leg(leg, goal):
    if not isinstance(leg, dict) or leg.get('verified') is not True:
        raise ValueError('RECOVERY_LEG_NOT_VERIFIED')
    if (leg.get('goal') != goal.name
            or type(leg.get('x')) not in (int, float)
            or type(leg.get('y')) not in (int, float)
            or leg['x'] != goal.x or leg['y'] != goal.y):
        raise ValueError('RECOVERY_GOAL_MISMATCH')
    if (not number(leg.get('position_error_m'), 0, 0.12)
            or not number(leg.get('odom_distance_m'), 0.4, 100)
            or not number(leg.get('wall_seconds'), 0.01, 600)
            or not number(leg.get('feedback_count'), 1, 1_000_000)):
        raise ValueError('RECOVERY_NAVIGATION_EVIDENCE_INCOMPLETE')
    if (not number(leg.get('pose_x'), -1000, 1000)
            or not number(leg.get('pose_y'), -1000, 1000)
            or hypot(leg['pose_x'] - goal.x, leg['pose_y'] - goal.y) > 0.12):
        raise ValueError('RECOVERY_POSE_NOT_VERIFIED')


def verify_timeout_recovery_report(report, run_id):
    if not isinstance(report, dict):
        raise ValueError('INVALID_TIMEOUT_RECOVERY_REPORT')
    if (report.get('schema') != 'alex.dev/ros-timeout-recovery/v1'
            or report.get('mode') != 'timeout-recovery'
            or report.get('status') != 'passed'):
        raise ValueError('TIMEOUT_RECOVERY_NOT_PASSED')
    legs = report.get('legs')
    if not isinstance(legs, list) or len(legs) != 2:
        raise ValueError('RECOVERY_ROUTE_INCOMPLETE')
    # 用真实 R58 的取消/TF/odom 停稳标准核查；仅归一化报告类型与恢复腿，
    # 不能用 R57 的伪进程证据、未观测的模拟取消或三段路径报告充数。
    base = {
        **report,
        'schema': 'alex.dev/ros-cancel-acceptance/v1',
        'mode': 'cancel-probe',
        'legs': [],
    }
    verify_cancel_report(base, run_id)
    checks = report.get('checks')
    required = {
        'nav2_forced_timeout_observed',
        'nav2_recovery_to_desk_verified',
        'nav2_return_to_dock_verified',
    }
    if not isinstance(checks, list) or not required.issubset(set(
            value for value in checks if isinstance(value, str))):
        raise ValueError('MISSING_TIMEOUT_RECOVERY_CHECKS')
    timeout = report.get('timeout')
    if (not isinstance(timeout, dict)
            or timeout.get('kind') != 'controlled_action_deadline'
            or not number(timeout.get('deadline_seconds'), 1.5, 1.5)
            or not number(timeout.get('elapsed_seconds'), 1.5, 3.0)
            or not number(timeout.get('feedback_count'), 1, 1_000_000)
            or timeout.get('pending_at_deadline') is not True):
        raise ValueError('NAV2_TIMEOUT_NOT_VERIFIED')
    for leg, goal in zip(legs, (DESK, DOCK)):
        verify_recovery_leg(leg, goal)
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--run-id', required=True)
    args = parser.parse_args()
    try:
        if not 2 <= args.report.stat().st_size <= 128 * 1024:
            raise ValueError('INVALID_TIMEOUT_REPORT_SIZE')
        report = json.loads(args.report.read_text(encoding='utf8'))
        verify_timeout_recovery_report(report, args.run_id)
    except (OSError, ValueError, TypeError) as exc:
        print('ROS_TIMEOUT_RECOVERY_INVALID:' + type(exc).__name__, file=sys.stderr)
        return 1
    print('Live Gazebo Nav2 timeout, cancellation, stop and two-leg recovery report structurally verified')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
