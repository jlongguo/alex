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
    ros_recovery_report=None,
    ros_recovery_run_id=None,
    ros_bridge_report=None,
    ros_bridge_run_id=None,
    ros_workflow_bundle=None,
    ros_workflow_run_id=None,
    ros_workflow_sha=None,
    ros_artifact_attestation=None,
    ros_artifact_folder=None,
    ros_artifact_id=None,
    ros_artifact_digest=None,
    ros_artifact_run_id=None,
    ros_artifact_attempt=None,
    ros_artifact_sha=None,
    ros_evidence_folder=None,
    ros_evidence_attestation=None,
    ros_evidence_artifact_id=None,
    ros_evidence_artifact_digest=None,
    ros_evidence_run_id=None,
    ros_evidence_attempt=None,
    ros_evidence_sha=None,
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

    if (ros_recovery_report is None) != (ros_recovery_run_id is None):
        raise ValueError('ROS_RECOVERY_REPORT_AND_RUN_ID_REQUIRED_TOGETHER')
    if ros_recovery_run_id is not None and not _valid_run_id(ros_recovery_run_id):
        raise ValueError('INVALID_ROS_RECOVERY_RUN_ID')

    if (ros_bridge_report is None) != (ros_bridge_run_id is None):
        raise ValueError('ROS_BRIDGE_REPORT_AND_RUN_ID_REQUIRED_TOGETHER')
    if ros_bridge_run_id is not None and not _valid_run_id(ros_bridge_run_id):
        raise ValueError('INVALID_ROS_BRIDGE_RUN_ID')

    workflow_supplied = [ros_workflow_bundle, ros_workflow_run_id, ros_workflow_sha]
    if any(value is not None for value in workflow_supplied) and not all(
            value is not None for value in workflow_supplied):
        raise ValueError('ROS_WORKFLOW_BUNDLE_RUN_ID_AND_SHA_REQUIRED_TOGETHER')
    if ros_workflow_run_id is not None and not (
            isinstance(ros_workflow_run_id, str)
            and ros_workflow_run_id.isascii() and ros_workflow_run_id.isdigit()
            and 0 < int(ros_workflow_run_id) < 10**20):
        raise ValueError('INVALID_ROS_WORKFLOW_RUN_ID')
    if ros_workflow_sha is not None and not (
            isinstance(ros_workflow_sha, str) and len(ros_workflow_sha) == 40
            and all(ch in '0123456789abcdef' for ch in ros_workflow_sha)):
        raise ValueError('INVALID_ROS_WORKFLOW_SHA')

    artifact_supplied = [
        ros_artifact_attestation, ros_artifact_folder, ros_artifact_id,
        ros_artifact_digest, ros_artifact_run_id, ros_artifact_attempt,
        ros_artifact_sha,
    ]
    if any(value is not None for value in artifact_supplied) and not all(
            value is not None for value in artifact_supplied):
        raise ValueError('ROS_ARTIFACT_ATTESTATION_METADATA_REQUIRED_TOGETHER')

    evidence_set_supplied = [
        ros_evidence_folder, ros_evidence_attestation,
        ros_evidence_artifact_id, ros_evidence_artifact_digest,
        ros_evidence_run_id, ros_evidence_attempt, ros_evidence_sha,
    ]
    if any(value is not None for value in evidence_set_supplied) and not all(
            value is not None for value in evidence_set_supplied):
        raise ValueError('ROS_EVIDENCE_SET_METADATA_REQUIRED_TOGETHER')

    individual_ros_supplied = [
        ros_report, ros_run_id, ros_cancel_report, ros_cancel_run_id,
        ros_recovery_report, ros_recovery_run_id,
        ros_bridge_report, ros_bridge_run_id,
        ros_workflow_bundle, ros_workflow_run_id, ros_workflow_sha,
        ros_artifact_attestation, ros_artifact_folder, ros_artifact_id,
        ros_artifact_digest, ros_artifact_run_id, ros_artifact_attempt,
        ros_artifact_sha,
    ]
    if all(value is not None for value in evidence_set_supplied) and any(
            value is not None for value in individual_ros_supplied):
        raise ValueError('ROS_EVIDENCE_SET_CANNOT_MIX_INDIVIDUAL_ROS_ARGS')

    result = {
        'schema': 'alex.dev/runtime-acceptance-gate/v1',
        'read_only': True,
        'ros_runtime': 'not_run',
        'voice_real_provider': 'not_run',
        'nav2_fault_contract': 'not_run',
        'ros_cancel_runtime': 'not_run',
        'ros_recovery_runtime': 'not_run',
        'ros_bridge_runtime': 'not_run',
        'ros_workflow_bundle': 'not_run',
        'ros_artifact_attestation': 'not_run',
        'ros_evidence_set': 'not_run',
        'physical_safety_certified': False,
        'release_approved': False,
        'remaining': [
            'REAL_ASR_LLM_TTS_PROVIDER_E2E',
            'GAZEBO_NAV2_THREE_LEG_RUNTIME',
            'GAZEBO_NAV2_CANCEL_RUNTIME',
            'GAZEBO_NAV2_RECOVERY_RUNTIME',
            'GAZEBO_NODE_PYTHON_NAV2_BRIDGE_RUNTIME',
            'GAZEBO_NAV2_WORKFLOW_EVIDENCE_BUNDLE',
            'GAZEBO_ACTIONS_ARTIFACT_ATTESTATION',
            'GAZEBO_ROS_COHERENT_EVIDENCE_SET',
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

    if ros_recovery_report is not None:
        # 同一 Gazebo 会话的取消后恢复证据单独核验，不能由三段路线代替。
        validator = Path(__file__).with_name('verify-ros-recovery-report.py')
        ok = _run_validator([
            sys.executable, str(validator), '--report', str(ros_recovery_report),
            '--run-id', ros_recovery_run_id,
        ])
        result['ros_recovery_runtime'] = 'verified' if ok else 'invalid'
        if ok:
            result['remaining'].remove('GAZEBO_NAV2_RECOVERY_RUNTIME')

    if ros_bridge_report is not None:
        # 生产 Node 桥实际调用 Python/rclpy/Nav2 的 Gazebo 证据独立核验；
        # 不能替代三段路线中的独立 TF/odom 到达证明。
        validator = Path(__file__).with_name('verify-nav2-bridge-live-report.py')
        ok = _run_validator([
            sys.executable, str(validator), '--report', str(ros_bridge_report),
            '--run-id', ros_bridge_run_id,
        ])
        result['ros_bridge_runtime'] = 'verified' if ok else 'invalid'
        if ok:
            result['remaining'].remove('GAZEBO_NODE_PYTHON_NAV2_BRIDGE_RUNTIME')

    if ros_workflow_bundle is not None:
        # SHA-256 仅证明传入文件与报告清单一致；Runner 身份仍需外部核对。
        validator = Path(__file__).with_name('ros-workflow-evidence-bundle.py')
        ok = _run_validator([
            sys.executable, str(validator), '--verify',
            '--bundle', str(ros_workflow_bundle),
            '--expect-run-id', ros_workflow_run_id,
            '--expect-sha', ros_workflow_sha,
        ])
        result['ros_workflow_bundle'] = 'verified-structure' if ok else 'invalid'
        if ok:
            result['remaining'].remove('GAZEBO_NAV2_WORKFLOW_EVIDENCE_BUNDLE')

    if ros_artifact_attestation is not None:
        # 只有调用方同时提供 GitHub 外部读取到的 Artifact ID/Digest/Run 元数据，
        # 才能核对 attestation；本地 JSON 自称通过不够。
        validator = Path(__file__).with_name('verify-ros-artifact-attestation.py')
        ok = _run_validator([
            sys.executable, str(validator),
            '--attestation', str(ros_artifact_attestation),
            '--folder', str(ros_artifact_folder),
            '--artifact-id', str(ros_artifact_id),
            '--artifact-digest', str(ros_artifact_digest),
            '--run-id', str(ros_artifact_run_id),
            '--attempt', str(ros_artifact_attempt),
            '--commit-sha', str(ros_artifact_sha),
        ])
        result['ros_artifact_attestation'] = 'verified-metadata' if ok else 'invalid'
        if ok:
            result['remaining'].remove('GAZEBO_ACTIONS_ARTIFACT_ATTESTATION')

    if ros_evidence_folder is not None:
        # 发布级 ROS 证据必须作为一个集合验证，禁止跨 Run/Artifact 拼接单项 PASS。
        validator = Path(__file__).with_name('verify-ros-evidence-set.py')
        ok = _run_validator([
            sys.executable, str(validator),
            '--folder', str(ros_evidence_folder),
            '--attestation', str(ros_evidence_attestation),
            '--artifact-id', str(ros_evidence_artifact_id),
            '--artifact-digest', str(ros_evidence_artifact_digest),
            '--run-id', str(ros_evidence_run_id),
            '--attempt', str(ros_evidence_attempt),
            '--commit-sha', str(ros_evidence_sha),
        ])
        result['ros_evidence_set'] = 'verified-coherent' if ok else 'invalid'
        if ok:
            result['ros_runtime'] = 'verified-by-set'
            result['ros_cancel_runtime'] = 'verified-by-set'
            result['ros_recovery_runtime'] = 'verified-by-set'
            result['ros_bridge_runtime'] = 'verified-by-set'
            result['ros_workflow_bundle'] = 'verified-by-set'
            result['ros_artifact_attestation'] = 'verified-by-set'
            for item in (
                'GAZEBO_NAV2_THREE_LEG_RUNTIME',
                'GAZEBO_NAV2_CANCEL_RUNTIME',
                'GAZEBO_NAV2_RECOVERY_RUNTIME',
                'GAZEBO_NODE_PYTHON_NAV2_BRIDGE_RUNTIME',
                'GAZEBO_NAV2_WORKFLOW_EVIDENCE_BUNDLE',
                'GAZEBO_ACTIONS_ARTIFACT_ATTESTATION',
                'GAZEBO_ROS_COHERENT_EVIDENCE_SET',
            ):
                result['remaining'].remove(item)

    result['status'] = (
        'blocked'
        if result['ros_runtime'] == 'invalid'
        or result['voice_real_provider'] == 'invalid'
        or result['nav2_fault_contract'] == 'invalid'
        or result['ros_cancel_runtime'] == 'invalid'
        or result['ros_recovery_runtime'] == 'invalid'
        or result['ros_bridge_runtime'] == 'invalid'
        or result['ros_workflow_bundle'] == 'invalid'
        or result['ros_artifact_attestation'] == 'invalid'
        or result['ros_evidence_set'] == 'invalid'
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
    parser.add_argument('--ros-recovery-report', type=Path)
    parser.add_argument('--ros-recovery-run-id')
    parser.add_argument('--ros-bridge-report', type=Path)
    parser.add_argument('--ros-bridge-run-id')
    parser.add_argument('--ros-workflow-bundle', type=Path)
    parser.add_argument('--ros-workflow-run-id')
    parser.add_argument('--ros-workflow-sha')
    parser.add_argument('--ros-artifact-attestation', type=Path)
    parser.add_argument('--ros-artifact-folder', type=Path)
    parser.add_argument('--ros-artifact-id')
    parser.add_argument('--ros-artifact-digest')
    parser.add_argument('--ros-artifact-run-id')
    parser.add_argument('--ros-artifact-attempt', type=int)
    parser.add_argument('--ros-artifact-sha')
    parser.add_argument('--ros-evidence-folder', type=Path)
    parser.add_argument('--ros-evidence-attestation', type=Path)
    parser.add_argument('--ros-evidence-artifact-id')
    parser.add_argument('--ros-evidence-artifact-digest')
    parser.add_argument('--ros-evidence-run-id')
    parser.add_argument('--ros-evidence-attempt', type=int)
    parser.add_argument('--ros-evidence-sha')
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
            args.ros_recovery_report,
            args.ros_recovery_run_id,
            args.ros_bridge_report,
            args.ros_bridge_run_id,
            args.ros_workflow_bundle,
            args.ros_workflow_run_id,
            args.ros_workflow_sha,
            args.ros_artifact_attestation,
            args.ros_artifact_folder,
            args.ros_artifact_id,
            args.ros_artifact_digest,
            args.ros_artifact_run_id,
            args.ros_artifact_attempt,
            args.ros_artifact_sha,
            args.ros_evidence_folder,
            args.ros_evidence_attestation,
            args.ros_evidence_artifact_id,
            args.ros_evidence_artifact_digest,
            args.ros_evidence_run_id,
            args.ros_evidence_attempt,
            args.ros_evidence_sha,
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
