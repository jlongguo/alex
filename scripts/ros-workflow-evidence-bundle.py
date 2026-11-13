#!/usr/bin/env python3
"""R60/R63：将四份独立 Gazebo/Nav2 验收结果绑定到一次手动 CI 执行。

这里只做文件内容、运行 ID 与工作流上下文的一致性验证。
JSON 和普通 SHA-256 不能证明执行者可信，必须结合 GitHub Actions 记录审核。
"""
import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import re
from runpy import run_path
import sys
from tempfile import NamedTemporaryFile
from time import time_ns

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = Path(__file__).resolve().parent
DEFAULT = ROOT / '.local/ros/workflow-evidence-bundle.json'
SCHEMA = 'alex.dev/ros-workflow-evidence-bundle/v1'
SOURCE = 'github-actions-manual-self-hosted'
REPO = 'jlongguo/alex'
WORKFLOW = '.github/workflows/ros-sim-acceptance.yml'
SHA = re.compile(r'^[0-9a-f]{40}$')
RUN = re.compile(r'^[A-Za-z0-9_-]{1,128}$')
WORKFLOW_REF = re.compile(
    r'^jlongguo/alex/\.github/workflows/ros-sim-acceptance\.yml@refs/heads/[A-Za-z0-9_./-]+$')
CASES = (
    ('route', 'acceptance-report.json', 'route', 'verify-ros-report.py',
     'verify_report', 256 * 1024),
    ('cancel', 'cancel-acceptance-report.json', 'cancel-probe',
     'verify-ros-cancel-report.py', 'verify_cancel_report', 192 * 1024),
    ('recovery', 'recovery-acceptance-report.json', 'recover-probe',
     'verify-ros-recovery-report.py', 'verify_recovery_report', 256 * 1024),
    ('bridge', 'bridge-acceptance-report.json', 'bridge-probe',
     'verify-nav2-bridge-live-report.py', 'verify_bridge_report', 192 * 1024),
)


def reject(condition, code):
    if not condition:
        raise ValueError(code)


def read_bounded(path, max_bytes):
    # 不接受软链接，避免把外部文件或设备路径误装入发布证据。
    reject(path.is_file() and not path.is_symlink(), 'EVIDENCE_FILE_MISSING_OR_SYMLINK')
    size = path.stat().st_size
    reject(2 <= size <= max_bytes, 'EVIDENCE_FILE_SIZE_INVALID')
    return path.read_bytes()


def json_object(raw):
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeError) as exc:
        raise ValueError('EVIDENCE_JSON_INVALID') from exc
    reject(isinstance(data, dict), 'EVIDENCE_OBJECT_REQUIRED')
    return data


def verifier_for(filename, name):
    # 已有三套门槛保持唯一权威；不在 Bundle 内复制阈值。
    return run_path(str(SCRIPTS / filename))[name]


def validate_report(case, folder):
    kind, filename, mode, verifier_name, function_name, max_bytes = case
    raw = read_bounded(folder / filename, max_bytes)
    data = json_object(raw)
    run_id = data.get('run_id')
    reject(isinstance(run_id, str) and RUN.fullmatch(run_id),
           'EVIDENCE_RUN_ID_INVALID')
    reject(data.get('status') == 'passed' and data.get('mode') == mode
           and data.get('simulation_only') is True,
           'EVIDENCE_REPORT_NOT_PASSED')
    verifier = verifier_for(verifier_name, function_name)
    if kind == 'recovery':
        verifier(data, run_id)
    else:
        verifier(data, run_id)
    return {
        'kind': kind,
        'filename': filename,
        'mode': mode,
        'run_id': run_id,
        'size_bytes': len(raw),
        'sha256': sha256(raw).hexdigest(),
    }


def action_context(env):
    # 只能由手动调度的自托管 Runner 声明上下文；本字段仍是可伪造的环境输入，
    # 不能代替 GitHub API 对 Workflow Run 与 Artifact 的外部确认。
    reject(env.get('GITHUB_ACTIONS') == 'true'
           and env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
           and env.get('GITHUB_REPOSITORY') == REPO
           and env.get('GITHUB_JOB') == 'nav2-simulation'
           and env.get('RUNNER_ENVIRONMENT') == 'self-hosted',
           'EVIDENCE_UNAPPROVED_WORKFLOW_CONTEXT')
    workflow_ref = env.get('GITHUB_WORKFLOW_REF')
    reject(isinstance(workflow_ref, str) and WORKFLOW_REF.fullmatch(workflow_ref),
           'EVIDENCE_UNTRUSTED_WORKFLOW_REF')
    commit = env.get('GITHUB_SHA')
    reject(isinstance(commit, str) and SHA.fullmatch(commit),
           'EVIDENCE_INVALID_COMMIT_SHA')
    run_id = env.get('GITHUB_RUN_ID')
    attempt = env.get('GITHUB_RUN_ATTEMPT')
    reject(isinstance(run_id, str) and run_id.isascii() and run_id.isdigit()
           and 0 < int(run_id) < 10**20,
           'EVIDENCE_INVALID_WORKFLOW_RUN')
    reject(isinstance(attempt, str) and attempt.isascii() and attempt.isdigit()
           and 1 <= int(attempt) <= 10000,
           'EVIDENCE_INVALID_WORKFLOW_ATTEMPT')
    return {
        'repository': REPO,
        'workflow': WORKFLOW,
        'workflow_ref': workflow_ref,
        'workflow_run_id': run_id,
        'workflow_run_attempt': int(attempt),
        'commit_sha': commit,
        'job': 'nav2-simulation',
        'runner_environment': 'self-hosted',
    }


def atomically_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = None
    try:
        with NamedTemporaryFile(
            mode='w', encoding='utf8', dir=path.parent,
            prefix='.ros-evidence-bundle-', suffix='.tmp', delete=False,
        ) as stream:
            temporary = Path(stream.name)
            os.chmod(stream.name, 0o600)
            json.dump(data, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write('\n')
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def reset(bundle, env):
    # 在测试启动前绑定具体 Actions Run，而不是收尾时才读取可变的环境信息。
    context = action_context(env)
    atomically_write(bundle, {
        'schema': SCHEMA, 'status': 'blocked',
        'source': SOURCE, 'simulation_only': True,
        'release_approved': False, 'physical_safety_certified': False,
        'reason': 'WORKFLOW_ACCEPTANCE_PENDING', 'reports': [],
        'context': context, 'started_at_ns': time_ns(),
    })


def collect(bundle, env):
    context = action_context(env)
    prior = json_object(read_bounded(bundle, 32 * 1024))
    reject(prior.get('schema') == SCHEMA and prior.get('status') == 'blocked'
           and prior.get('reason') == 'WORKFLOW_ACCEPTANCE_PENDING'
           and prior.get('context') == context
           and type(prior.get('started_at_ns')) is int
           and prior['started_at_ns'] > 0,
           'EVIDENCE_WORKFLOW_NOT_RESET')
    # 自托管 Runner 工作区可持久化：必须排除上一个 Workflow Run 遗留的 PASS。
    for _, filename, _, _, _, _ in CASES:
        reject((bundle.parent / filename).is_file()
               and (bundle.parent / filename).stat().st_mtime_ns > prior['started_at_ns'],
               'EVIDENCE_STALE_SCENARIO_REPORT')
    entries = [validate_report(case, bundle.parent) for case in CASES]
    ids = [entry['run_id'] for entry in entries]
    reject(len(set(ids)) == len(CASES), 'EVIDENCE_REUSED_SCENARIO_RUN_ID')
    assembled = {
        'schema': SCHEMA, 'status': 'assembled', 'source': SOURCE,
        'simulation_only': True,
        'release_approved': False, 'physical_safety_certified': False,
        'context': context, 'reports': entries,
        'collected_at': datetime.now(timezone.utc).isoformat(),
    }
    atomically_write(bundle, assembled)
    return assembled


def verify_bundle(bundle, expected_run_id, expected_sha, expected_attempt=None):
    reject(isinstance(expected_run_id, str) and expected_run_id.isascii()
           and expected_run_id.isdigit() and 0 < int(expected_run_id) < 10**20,
           'EVIDENCE_EXPECTED_RUN_INVALID')
    reject(isinstance(expected_sha, str) and SHA.fullmatch(expected_sha),
           'EVIDENCE_EXPECTED_SHA_INVALID')
    assembled = json_object(read_bounded(bundle, 32 * 1024))
    reject(assembled.get('schema') == SCHEMA
           and assembled.get('status') == 'assembled'
           and assembled.get('source') == SOURCE
           and assembled.get('simulation_only') is True
           and assembled.get('physical_safety_certified') is False
           and assembled.get('release_approved') is False,
           'EVIDENCE_BUNDLE_NOT_ASSEMBLED')
    ctx = assembled.get('context')
    reject(isinstance(ctx, dict)
           and ctx.get('repository') == REPO
           and ctx.get('workflow') == WORKFLOW
           and ctx.get('job') == 'nav2-simulation'
           and ctx.get('runner_environment') == 'self-hosted'
           and isinstance(ctx.get('workflow_ref'), str)
           and WORKFLOW_REF.fullmatch(ctx['workflow_ref'])
           and ctx.get('workflow_run_id') == expected_run_id
           and ctx.get('commit_sha') == expected_sha
           and type(ctx.get('workflow_run_attempt')) is int
           and 1 <= ctx['workflow_run_attempt'] <= 10000,
           'EVIDENCE_WORKFLOW_MISMATCH')
    if expected_attempt is not None:
        reject(type(expected_attempt) is int
               and ctx['workflow_run_attempt'] == expected_attempt,
               'EVIDENCE_WORKFLOW_ATTEMPT_MISMATCH')
    actual = assembled.get('reports')
    reject(isinstance(actual, list) and len(actual) == len(CASES),
           'EVIDENCE_SCENARIOS_INCOMPLETE')
    recomputed = [validate_report(case, bundle.parent) for case in CASES]
    reject(actual == recomputed, 'EVIDENCE_REPORT_HASH_OR_ID_MISMATCH')
    ids = [entry['run_id'] for entry in recomputed]
    reject(len(set(ids)) == len(CASES), 'EVIDENCE_REUSED_SCENARIO_RUN_ID')
    return True


def main():
    parser = argparse.ArgumentParser(description='R60 ROS 手动工作流证据对账')
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument('--reset', action='store_true')
    operation.add_argument('--collect', action='store_true')
    operation.add_argument('--verify', action='store_true')
    parser.add_argument('--bundle', type=Path, default=DEFAULT)
    parser.add_argument('--expect-run-id')
    parser.add_argument('--expect-sha')
    parser.add_argument('--expect-attempt', type=int)
    args = parser.parse_args()
    try:
        if args.reset:
            reset(args.bundle, os.environ)
            print('ROS_WORKFLOW_BUNDLE_BLOCKED')
        elif args.collect:
            reject(args.expect_run_id is None and args.expect_sha is None,
                   'EVIDENCE_COLLECT_UNEXPECTED_EXPECTATION')
            data = collect(args.bundle, os.environ)
            print('ROS_WORKFLOW_BUNDLE_ASSEMBLED:' +
                  data['context']['workflow_run_id'])
        else:
            verify_bundle(args.bundle, args.expect_run_id, args.expect_sha,
                          args.expect_attempt)
            print('ROS_WORKFLOW_BUNDLE_VERIFIED_STRUCTURE_ONLY')
    except (OSError, ValueError, TypeError) as exc:
        code = str(exc)
        if not re.fullmatch(r'EVIDENCE_[A-Z0-9_]+', code):
            code = 'EVIDENCE_INTERNAL_VALIDATION_FAILED'
        print(code, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
