#!/usr/bin/env python3
"""R65：验证一个 ROS 发布证据集合内部完全一致。

复用 R60/R63 workflow bundle 与 R64 artifact attestation 的既有严格验证器，
不复制 route/cancel/recovery/bridge 的业务阈值。
"""
import argparse
import json
from pathlib import Path
import re
from runpy import run_path
import sys

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = Path(__file__).resolve().parent
BUNDLE_NAME = 'workflow-evidence-bundle.json'
REPORT_NAMES = (
    'acceptance-report.json',
    'cancel-acceptance-report.json',
    'recovery-acceptance-report.json',
    'bridge-acceptance-report.json',
)
SHA40 = re.compile(r'^[0-9a-f]{40}$')
SHA256 = re.compile(r'^[0-9a-f]{64}$')
DIGITS = re.compile(r'^[1-9][0-9]{0,19}$')


def reject(condition, code):
    if not condition:
        raise ValueError(code)


def bounded_json(path, max_bytes):
    reject(path.is_file() and not path.is_symlink(),
           'EVIDENCE_SET_FILE_MISSING_OR_SYMLINK')
    size = path.stat().st_size
    reject(2 <= size <= max_bytes, 'EVIDENCE_SET_FILE_SIZE_INVALID')
    try:
        data = json.loads(path.read_text(encoding='utf8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError('EVIDENCE_SET_JSON_INVALID') from exc
    reject(isinstance(data, dict), 'EVIDENCE_SET_OBJECT_REQUIRED')
    return data


def expected(args):
    reject(isinstance(args.run_id, str) and DIGITS.fullmatch(args.run_id),
           'EVIDENCE_SET_RUN_ID_INVALID')
    reject(type(args.attempt) is int and 1 <= args.attempt <= 10000,
           'EVIDENCE_SET_ATTEMPT_INVALID')
    reject(isinstance(args.commit_sha, str) and SHA40.fullmatch(args.commit_sha),
           'EVIDENCE_SET_COMMIT_INVALID')
    reject(isinstance(args.artifact_id, str) and DIGITS.fullmatch(args.artifact_id),
           'EVIDENCE_SET_ARTIFACT_ID_INVALID')
    reject(isinstance(args.artifact_digest, str)
           and SHA256.fullmatch(args.artifact_digest),
           'EVIDENCE_SET_ARTIFACT_DIGEST_INVALID')
    return {
        'run_id': args.run_id,
        'attempt': args.attempt,
        'commit_sha': args.commit_sha,
        'artifact_id': args.artifact_id,
        'artifact_digest': args.artifact_digest,
    }


def verify_set(folder, attestation_path, meta):
    reject(folder.is_dir() and not folder.is_symlink(),
           'EVIDENCE_SET_FOLDER_INVALID')

    # 固定文件名避免调用方把不同目录的单项证据拼接进同一发布判断。
    bundle_path = folder / BUNDLE_NAME
    for name in REPORT_NAMES:
        reject((folder / name).is_file() and not (folder / name).is_symlink(),
               'EVIDENCE_SET_REPORT_MISSING_OR_SYMLINK')

    bundle_module = run_path(str(SCRIPTS / 'ros-workflow-evidence-bundle.py'))
    bundle_module['verify_bundle'](
        bundle_path,
        meta['run_id'],
        meta['commit_sha'],
        meta['attempt'],
    )

    attestation_module = run_path(
        str(SCRIPTS / 'verify-ros-artifact-attestation.py'))
    attestation = bounded_json(attestation_path, 64 * 1024)
    attestation_module['verify_attestation'](
        attestation,
        folder,
        {
            'artifact_id': meta['artifact_id'],
            'artifact_digest': meta['artifact_digest'],
            'run_id': meta['run_id'],
            'attempt': meta['attempt'],
            'commit_sha': meta['commit_sha'],
        },
    )

    # 两个底层验证器均已独立通过；这里额外把它们的上下文做精确同值检查，
    # 使跨 Run/Attempt/Commit 的合法证据无法被拼成一个集合。
    bundle = bounded_json(bundle_path, 64 * 1024)
    bundle_ctx = bundle.get('context')
    attest_ctx = attestation.get('context')
    reject(isinstance(bundle_ctx, dict) and isinstance(attest_ctx, dict),
           'EVIDENCE_SET_CONTEXT_MISSING')

    context_keys = (
        'repository', 'workflow', 'workflow_ref', 'job',
        'workflow_run_id', 'workflow_run_attempt',
        'commit_sha', 'runner_environment',
    )
    reject(all(bundle_ctx.get(key) == attest_ctx.get(key)
               for key in context_keys),
           'EVIDENCE_SET_CONTEXT_MISMATCH')
    reject(bundle_ctx.get('workflow_run_id') == meta['run_id']
           and bundle_ctx.get('workflow_run_attempt') == meta['attempt']
           and bundle_ctx.get('commit_sha') == meta['commit_sha'],
           'EVIDENCE_SET_EXTERNAL_CONTEXT_MISMATCH')

    reports = bundle.get('reports')
    reject(isinstance(reports, list) and len(reports) == 4,
           'EVIDENCE_SET_REPORT_MANIFEST_INVALID')
    by_name = {
        item.get('filename'): item
        for item in reports if isinstance(item, dict)
    }
    reject(set(by_name) == set(REPORT_NAMES),
           'EVIDENCE_SET_REPORT_MANIFEST_INVALID')

    # Bundle 记录的每个 scenario run_id 必须等于对应报告内部 run_id。
    for name in REPORT_NAMES:
        report = bounded_json(folder / name, 512 * 1024)
        run_id = report.get('run_id')
        reject(isinstance(run_id, str) and by_name[name].get('run_id') == run_id,
               'EVIDENCE_SET_REPORT_RUN_ID_MISMATCH')

    artifact = attestation.get('artifact')
    reject(isinstance(artifact, dict)
           and artifact.get('id') == meta['artifact_id']
           and artifact.get('digest_sha256') == meta['artifact_digest'],
           'EVIDENCE_SET_ARTIFACT_CONTEXT_MISMATCH')
    return True


def main():
    parser = argparse.ArgumentParser(
        description='Verify one coherent ROS runtime evidence set')
    parser.add_argument('--folder', type=Path, required=True)
    parser.add_argument('--attestation', type=Path, required=True)
    parser.add_argument('--artifact-id', required=True)
    parser.add_argument('--artifact-digest', required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--attempt', type=int, required=True)
    parser.add_argument('--commit-sha', required=True)
    args = parser.parse_args()
    try:
        meta = expected(args)
        verify_set(args.folder, args.attestation, meta)
    except (OSError, ValueError, TypeError) as exc:
        code = str(exc)
        if not re.fullmatch(r'(EVIDENCE_SET|EVIDENCE|ARTIFACT_ATTESTATION)_[A-Z0-9_]+',
                            code):
            code = 'EVIDENCE_SET_VERIFY_FAILED'
        print(code, file=sys.stderr)
        return 1
    print('ROS runtime evidence set coherently verified')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
