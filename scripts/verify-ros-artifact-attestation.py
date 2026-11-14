#!/usr/bin/env python3
"""R64：验证 GitHub Actions ROS Artifact attestation 与下载后的关键证据文件。

必须由调用方提供 GitHub API/UI 读取到的 Artifact ID、Digest、Run ID、Attempt 和 Commit SHA。
本地文件哈希一致只证明下载内容与 attestation 一致，不认证自托管 Runner 本身。
"""
import argparse
from hashlib import sha256
import json
from pathlib import Path
import re
import sys

SCHEMA = 'alex.dev/ros-artifact-attestation/v1'
SOURCE = 'github-actions-upload-artifact'
REPO = 'jlongguo/alex'
WORKFLOW = '.github/workflows/ros-sim-acceptance.yml'
JOB = 'nav2-simulation'
ARTIFACT_NAME = 'alex-ros-gazebo-acceptance'
SHA40 = re.compile(r'^[0-9a-f]{40}$')
SHA256 = re.compile(r'^[0-9a-f]{64}$')
DIGITS = re.compile(r'^[1-9][0-9]{0,19}$')
WORKFLOW_REF = re.compile(
    r'^jlongguo/alex/\.github/workflows/ros-sim-acceptance\.yml@refs/heads/[A-Za-z0-9_./-]+$')
FILES = (
    'acceptance-report.json',
    'cancel-acceptance-report.json',
    'recovery-acceptance-report.json',
    'bridge-acceptance-report.json',
    'workflow-evidence-bundle.json',
)


def reject(condition, code):
    if not condition:
        raise ValueError(code)


def read_bounded(path, max_bytes):
    reject(path.is_file() and not path.is_symlink(),
           'ARTIFACT_ATTESTATION_FILE_MISSING_OR_SYMLINK')
    size = path.stat().st_size
    reject(2 <= size <= max_bytes, 'ARTIFACT_ATTESTATION_FILE_SIZE_INVALID')
    return path.read_bytes()


def normalize_digest(value):
    if isinstance(value, str) and value.startswith('sha256:'):
        value = value[7:]
    reject(isinstance(value, str) and SHA256.fullmatch(value),
           'ARTIFACT_ATTESTATION_EXPECTED_DIGEST_INVALID')
    return value


def expected_metadata(args):
    reject(isinstance(args.artifact_id, str) and DIGITS.fullmatch(args.artifact_id),
           'ARTIFACT_ATTESTATION_EXPECTED_ID_INVALID')
    digest = normalize_digest(args.artifact_digest)
    reject(isinstance(args.run_id, str) and DIGITS.fullmatch(args.run_id),
           'ARTIFACT_ATTESTATION_EXPECTED_RUN_INVALID')
    reject(type(args.attempt) is int and 1 <= args.attempt <= 10000,
           'ARTIFACT_ATTESTATION_EXPECTED_ATTEMPT_INVALID')
    reject(isinstance(args.commit_sha, str) and SHA40.fullmatch(args.commit_sha),
           'ARTIFACT_ATTESTATION_EXPECTED_COMMIT_INVALID')
    return {
        'artifact_id': args.artifact_id,
        'artifact_digest': digest,
        'run_id': args.run_id,
        'attempt': args.attempt,
        'commit_sha': args.commit_sha,
    }


def verify_attestation(attestation, folder, expected):
    reject(isinstance(attestation, dict)
           and attestation.get('schema') == SCHEMA
           and attestation.get('status') == 'attested'
           and attestation.get('source') == SOURCE,
           'ARTIFACT_ATTESTATION_SCHEMA_INVALID')
    reject(attestation.get('simulation_only') is True
           and attestation.get('physical_safety_certified') is False
           and attestation.get('release_approved') is False,
           'ARTIFACT_ATTESTATION_OVERCLAIMED')

    context = attestation.get('context')
    reject(isinstance(context, dict)
           and context.get('repository') == REPO
           and context.get('workflow') == WORKFLOW
           and context.get('job') == JOB
           and context.get('runner_environment') == 'self-hosted'
           and isinstance(context.get('workflow_ref'), str)
           and WORKFLOW_REF.fullmatch(context['workflow_ref'])
           and context.get('workflow_run_id') == expected['run_id']
           and context.get('workflow_run_attempt') == expected['attempt']
           and context.get('commit_sha') == expected['commit_sha'],
           'ARTIFACT_ATTESTATION_RUN_CONTEXT_MISMATCH')

    artifact = attestation.get('artifact')
    reject(isinstance(artifact, dict)
           and artifact.get('name') == ARTIFACT_NAME
           and artifact.get('id') == expected['artifact_id']
           and artifact.get('digest_sha256') == expected['artifact_digest']
           and artifact.get('immutable') is True,
           'ARTIFACT_ATTESTATION_UPLOAD_METADATA_MISMATCH')

    records = attestation.get('files')
    reject(isinstance(records, list) and len(records) == len(FILES),
           'ARTIFACT_ATTESTATION_FILES_INCOMPLETE')
    by_name = {}
    for item in records:
        reject(isinstance(item, dict)
               and set(item) == {'filename', 'size_bytes', 'sha256'}
               and isinstance(item.get('filename'), str)
               and item['filename'] in FILES
               and type(item.get('size_bytes')) is int
               and 2 <= item['size_bytes'] <= 512 * 1024
               and isinstance(item.get('sha256'), str)
               and SHA256.fullmatch(item['sha256']),
               'ARTIFACT_ATTESTATION_FILE_RECORD_INVALID')
        reject(item['filename'] not in by_name,
               'ARTIFACT_ATTESTATION_FILE_RECORD_DUPLICATED')
        by_name[item['filename']] = item
    reject(set(by_name) == set(FILES), 'ARTIFACT_ATTESTATION_FILES_INCOMPLETE')

    for name in FILES:
        raw = read_bounded(folder / name, 512 * 1024)
        record = by_name[name]
        reject(len(raw) == record['size_bytes']
               and sha256(raw).hexdigest() == record['sha256'],
               'ARTIFACT_ATTESTATION_DOWNLOADED_FILE_MISMATCH')

    bundle = by_name['workflow-evidence-bundle.json']['sha256']
    reject(attestation.get('workflow_bundle_sha256') == bundle,
           'ARTIFACT_ATTESTATION_BUNDLE_DIGEST_MISMATCH')
    return True


def main():
    parser = argparse.ArgumentParser(description='Verify ROS Actions artifact attestation')
    parser.add_argument('--attestation', type=Path, required=True)
    parser.add_argument('--folder', type=Path, required=True)
    parser.add_argument('--artifact-id', required=True)
    parser.add_argument('--artifact-digest', required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--attempt', type=int, required=True)
    parser.add_argument('--commit-sha', required=True)
    args = parser.parse_args()
    try:
        expected = expected_metadata(args)
        raw = read_bounded(args.attestation, 64 * 1024)
        data = json.loads(raw)
        verify_attestation(data, args.folder, expected)
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        code = str(exc)
        if not re.fullmatch(r'ARTIFACT_ATTESTATION_[A-Z0-9_]+', code):
            code = 'ARTIFACT_ATTESTATION_VERIFY_FAILED'
        print(code, file=sys.stderr)
        return 1
    print('GitHub Actions ROS artifact attestation structurally verified')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
