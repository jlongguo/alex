#!/usr/bin/env python3
"""R55 独立运行时验收证据门槛：只读核查，绝不把模拟/静态结果冒充真实验收。"""
import argparse
import json
from pathlib import Path
import subprocess
import sys


def audit(ros_report=None, ros_run_id=None):
    if (ros_report is None) != (ros_run_id is None):
        raise ValueError('ROS_REPORT_AND_RUN_ID_REQUIRED_TOGETHER')
    if ros_run_id is not None and (
        not isinstance(ros_run_id, str) or len(ros_run_id) > 128
        or not all(ch.isalnum() or ch in '-_' for ch in ros_run_id)
    ):
        raise ValueError('INVALID_ROS_RUN_ID')
    result = {
        'schema': 'alex.dev/runtime-acceptance-gate/v1',
        'read_only': True,
        'ros_runtime': 'not_run',
        'voice_real_provider': 'not_run',
        'physical_safety_certified': False,
        'release_approved': False,
        'remaining': [
            'REAL_ASR_LLM_TTS_PROVIDER_E2E',
            'GAZEBO_NAV2_THREE_LEG_RUNTIME',
            'PHYSICAL_SAFETY_REVIEW',
        ],
    }
    if ros_report is not None:
        # 复用原有三段目标、时钟/TF、run_id、误差和里程检查，不复制/放宽阈值。
        validator = Path(__file__).with_name('verify-ros-report.py')
        try:
            checked = subprocess.run(
                [sys.executable, str(validator), '--report', str(ros_report),
                 '--run-id', ros_run_id],
                capture_output=True, text=True, timeout=20, check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            result['ros_runtime'] = 'invalid'
        else:
            result['ros_runtime'] = 'verified' if checked.returncode == 0 else 'invalid'
            if result['ros_runtime'] == 'verified':
                result['remaining'].remove('GAZEBO_NAV2_THREE_LEG_RUNTIME')
    result['status'] = (
        'blocked' if result['ros_runtime'] == 'invalid'
        else 'manual-review-required'
    )
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ros-report', type=Path)
    parser.add_argument('--ros-run-id')
    parser.add_argument('--require-all', action='store_true',
                        help='任何真实语音或机器人验收缺失时必须失败')
    args = parser.parse_args()
    try:
        report = audit(args.ros_report, args.ros_run_id)
    except ValueError as error:
        print('R55_RUNTIME_GATE_INVALID_ARGS:' + str(error), file=sys.stderr)
        return 2
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2))
    if report['status'] == 'blocked' or (
        args.require_all and report['remaining']
    ):
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
