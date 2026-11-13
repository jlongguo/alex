#!/usr/bin/env python3
"""R59 独立 Gazebo 同会话取消后恢复证据校验，不连接 ROS 或驱动。"""
import argparse
import json
from math import isfinite
from pathlib import Path
from runpy import run_path
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'robotics/ros2/alex_sim'))
from alex_sim.acceptance import DESK, DOCK  # noqa: E402

# 直接复用 R58 取消证据和三段导航的严格位置/里程阈值，
# 避免“恢复成功”以更宽松的数学标准冒充原有导航验收。
verify_cancel_report = run_path(
    str(Path(__file__).with_name('verify-ros-cancel-report.py'))
)['verify_cancel_report']
verify_navigation_legs = run_path(
    str(Path(__file__).with_name('verify-ros-report.py'))
)['verify_navigation_legs']

RECOVERY_CHECKS = {
    'post_cancel_recovery_desk_verified',
    'post_cancel_return_dock_verified',
}


def verify_recovery_report(report, expected_run_id):
    # recovery=True 仅复用 R58 的严格取消 ACK、终态 CANCELED、
    # 图谱就绪、Lifecycle ACTIVE、TF、odom 与速度观测门槛。
    verify_cancel_report(report, expected_run_id, recovery=True)
    checks = report.get('checks')
    if not isinstance(checks, list) or not RECOVERY_CHECKS.issubset(
            {value for value in checks if isinstance(value, str)}):
        raise ValueError('MISSING_RECOVERY_CHECKS')
    recovery = report.get('recovery')
    if not isinstance(recovery, dict):
        raise ValueError('MISSING_RECOVERY_STAGES')
    if (recovery.get('source') != 'same-gazebo-session'
            or recovery.get('cancel_verified') is not True
            or recovery.get('recovery_goals') != [DESK.name, DOCK.name]
            or recovery.get('return_to_dock_verified') is not True):
        raise ValueError('INVALID_RECOVERY_SEQUENCE')

    # 恢复目标必须在取消之后连续完成，按默认三段导航的相同 12cm
    # 位置误差、反馈、里程和墙钟时间要求核验，不能交换顺序。
    verify_navigation_legs(report.get('legs'), (DESK, DOCK))
    last_goal = report.get('last_goal')
    if (not isinstance(last_goal, dict)
            or last_goal.get('goal') != DOCK.name
            or last_goal.get('action_status') != 'SUCCEEDED'
            or last_goal.get('tf_fresh') is not True):
        raise ValueError('RECOVERY_FINAL_ACTION_UNVERIFIED')
    feedback = last_goal.get('feedback_count')
    if type(feedback) is not int or feedback < 1:
        raise ValueError('RECOVERY_FINAL_FEEDBACK_MISSING')
    odom = last_goal.get('odom_distance_m')
    if type(odom) not in (int, float) or not isfinite(odom) or odom < 0.4:
        raise ValueError('RECOVERY_FINAL_ODOM_MISSING')
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--run-id', required=True)
    args = parser.parse_args()
    try:
        if not args.report.is_file() or args.report.stat().st_size > 192 * 1024:
            raise ValueError('INVALID_RECOVERY_FILE')
        data = json.loads(args.report.read_text(encoding='utf8'))
        verify_recovery_report(data, args.run_id)
    except (OSError, ValueError, TypeError) as exc:
        # 文件名、环境变量以及原始 ROS 错误不写到报告验证日志中。
        print('ROS_RECOVERY_REPORT_INVALID:' + type(exc).__name__, file=sys.stderr)
        return 1
    print('Gazebo Nav2 same-session cancellation and dock recovery structurally verified')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
