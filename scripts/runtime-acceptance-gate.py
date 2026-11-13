#!/usr/bin/env python3
"""R56 独立运行时验收证据门槛：只读核查，绝不把模拟/静态结果冒充真实验收。"""
import argparse
import json
from pathlib import Path
import subprocess
import sys


def _valid_run_id(value):
    return (
        isinstance(value, str)
        and 1 <= len(value) <= 128
        and all(ch.isalnum() or ch in '-_' for ch in value)
    )


def _run_validator(command, timeout=20):
    try:
        checked = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return checked.returncode == 0


def audit(
    ros_report=None,
    ros_run_id=None,
    voice_report=None,
    voice_run_id=None,
    nav2_fault_report=None,
    nav2_fault_run_id=None,
    ros_cancel_report=None,
    ros_cancel_run_id=None,
):
    if (ros_report is None) != (ros_run_id is None):
        raise ValueError('ROS_REPORT_AND_RUN_ID_REQUIRED_TOGETHER')
    if ros_run_id is not None and not _valid_run_id(ros_run_id):
        raise ValueError('INVALID_ROS_RUN_ID')
    if (voice_report is None) != (voice_run_id is None):
        raise ValueError('VOICE_REPORT_AND_RUN_ID_REQUIRED_TOGETHER')
    if voice_run_id is not None and not _valid_run_id(voice_run_id):
        raise ValueError('INVALID_VOICE_RUN_ID')

    if (nav2_fault_report is None) != (nav2_fault_run_id is None):
        raise ValueError('NAV2_FAULT_REPORT_AND_RUN_ID_REQUIRED_TOGETHER')
    if nav2_fault_run_id is not None and not _valid_run_id(nav2_fault_run_id):
        raise ValueError('INVALID_NAV2_FAULT_RUN_ID')

    if (ros_cancel_report is None) != (ros_cancel_run_id is None):
        raise ValueError('ROS_CANCEL_REPORT_AND_RUN_ID_REQUIRED_TOGETHER')
    if ros_cancel_run_id is not None and not _valid_run_id(ros_cancel_run_id):
        raise ValueError('INVALID_ROS_CANCEL_RUN_ID')

    result = {
        'schema': 'alex.dev/runtime-acceptance-gate/v1',
        'read_only': True,
        'ros_runtime': 'not_run',
        'voice_real_provider': 'not_run',
        'nav2_fault_contract': 'not_run',
        'ros_cancel_runtime': 'not_run',
        'physical_safety_certified': False,
        'release_approved': False,
        'remaining': [
            'REAL_ASR_LLM_TTS_PROVIDER_E2E',
            'GAZEBO_NAV2_THREE_LEG_RUNTIME',
            'GAZEBO_NAV2_CANCEL_RUNTIME',
            'PHYSICAL_SAFETY_REVIEW',
        ],
    }

    if ros_report is not None:
        # 复用原有三段目标、时钟/TF、run_id、误差和里程检查，不复制/放宽阈值。
        validator = Path(__file__).with_name('verify-ros-report.py')
        ok = _run_validator([
            sys.executable,
            str(validator),
            '--report',
            str(ros_report),
            '--run-id',
            ros_run_id,
        ])
        result['ros_runtime'] = 'verified' if ok else 'invalid'
        if ok:
            result['remaining'].remove('GAZEBO_NAV2_THREE_LEG_RUNTIME')

    if voice_report is not None:
        # 语音证据只接受真实供应商模式；注入测试报告不能冒充真实 ASR/LLM/TTS。
        validator = Path(__file__).with_name('verify-voice-runtime-report.mjs')
        ok = _run_validator([
            'node',
            str(validator),
            '--report',
            str(voice_report),
            '--run-id',
            voice_run_id,
        ])
        result['voice_real_provider'] = 'verified' if ok else 'invalid'
        if ok:
            result['remaining'].remove('REAL_ASR_LLM_TTS_PROVIDER_E2E')

    if nav2_fault_report is not None:
        # 故障注入证据只描述隔离子进程契约，不能解锁真实 Gazebo 三段导航门槛。
        validator = Path(__file__).with_name('verify-nav2-fault-contract.mjs')
        ok = _run_validator([
            'node', str(validator), '--report', str(nav2_fault_report),
            '--run-id', nav2_fault_run_id,
        ])
        result['nav2_fault_contract'] = 'verified-injected' if ok else 'invalid'

    if ros_cancel_report is not None:
        # 必须单独验证本次 Gazebo Nav2 取消终态与停止窗口，不能由伪 peer 证据代替。
        validator = Path(__file__).with_name('verify-ros-cancel-report.py')
        ok = _run_validator([
            sys.executable, str(validator), '--report', str(ros_cancel_report),
            '--run-id', ros_cancel_run_id,
        ])
        result['ros_cancel_runtime'] = 'verified' if ok else 'invalid'
        if ok:
            result['remaining'].remove('GAZEBO_NAV2_CANCEL_RUNTIME')

    result['status'] = (
        'blocked'
        if result['ros_runtime'] == 'invalid'
        or result['voice_real_provider'] == 'invalid'
        or result['nav2_fault_contract'] == 'invalid'
        or result['ros_cancel_runtime'] == 'invalid'
        else 'manual-review-required'
    )
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ros-report', type=Path)
    parser.add_argument('--ros-run-id')
    parser.add_argument('--voice-report', type=Path)
    parser.add_argument('--voice-run-id')
    parser.add_argument('--nav2-fault-report', type=Path)
    parser.add_argument('--nav2-fault-run-id')
    parser.add_argument('--ros-cancel-report', type=Path)
    parser.add_argument('--ros-cancel-run-id')
    parser.add_argument(
        '--require-all',
        action='store_true',
        help='任何真实语音、机器人或物理安全验收缺失时必须失败',
    )
    args = parser.parse_args()
    try:
        report = audit(
            args.ros_report,
            args.ros_run_id,
            args.voice_report,
            args.voice_run_id,
            args.nav2_fault_report,
            args.nav2_fault_run_id,
            args.ros_cancel_report,
            args.ros_cancel_run_id,
        )
    except ValueError as error:
        print('R56_RUNTIME_GATE_INVALID_ARGS:' + str(error), file=sys.stderr)
        return 2
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2))
    if report['status'] == 'blocked' or (
        args.require_all and report['remaining']
    ):
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
