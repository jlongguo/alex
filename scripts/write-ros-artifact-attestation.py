#!/usr/bin/env python3
"""R64：在 GitHub Actions 上传 ROS 证据 Artifact 后生成不可变上传元数据证明。

本文件只绑定 GitHub Actions upload-artifact 返回的 ID/Digest 与本地关键证据文件哈希。
它不会认证自托管 Runner 身份，也不会把仿真证据升级为物理安全认证。
"""
import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import re
from tempfile import NamedTemporaryFile

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


def read_bounded(path, max_bytes=512 * 1024):
    reject(path.is_file() and not path.is_symlink(), 'ARTIFACT_ATTESTATION_FILE_MISSING_OR_SYMLINK')
    size = path.stat().st_size
    reject(2 <= size <= max_bytes, 'ARTIFACT_ATTESTATION_FILE_SIZE_INVALID')
    return path.read_bytes()


def hash_file(path):
    raw = read_bounded(path)
    return {
        'filename': path.name,
        'size_bytes': len(raw),
        'sha256': sha256(raw).hexdigest(),
    }


def action_context(env):
    reject(env.get('GITHUB_ACTIONS') == 'true'
           and env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
           and env.get('GITHUB_REPOSITORY') == REPO
           and env.get('GITHUB_JOB') == JOB
           and env.get('RUNNER_ENVIRONMENT') == 'self-hosted',
           'ARTIFACT_ATTESTATION_UNAPPROVED_CONTEXT')
    workflow_ref = env.get('GITHUB_WORKFLOW_REF')
    reject(isinstance(workflow_ref, str) and WORKFLOW_REF.fullmatch(workflow_ref),
           'ARTIFACT_ATTESTATION_WORKFLOW_REF_INVALID')
    run_id = env.get('GITHUB_RUN_ID')
    attempt = env.get('GITHUB_RUN_ATTEMPT')
    commit = env.get('GITHUB_SHA')
    reject(isinstance(run_id, str) and DIGITS.fullmatch(run_id),
           'ARTIFACT_ATTESTATION_RUN_ID_INVALID')
    reject(isinstance(attempt, str) and attempt.isascii() and attempt.isdigit()
           and 1 <= int(attempt) <= 10000,
           'ARTIFACT_ATTESTATION_ATTEMPT_INVALID')
    reject(isinstance(commit, str) and SHA40.fullmatch(commit),
           'ARTIFACT_ATTESTATION_COMMIT_INVALID')
    return {
        'repository': REPO,
        'workflow': WORKFLOW,
        'workflow_ref': workflow_ref,
        'job': JOB,
        'workflow_run_id': run_id,
        'workflow_run_attempt': int(attempt),
        'commit_sha': commit,
        'runner_environment': 'self-hosted',
    }


def artifact_context(env):
    artifact_id = env.get('ALEX_ROS_ARTIFACT_ID')
    digest = env.get('ALEX_ROS_ARTIFACT_DIGEST')
    reject(isinstance(artifact_id, str) and DIGITS.fullmatch(artifact_id),
           'ARTIFACT_ATTESTATION_ARTIFACT_ID_INVALID')
    reject(isinstance(digest, str) and SHA256.fullmatch(digest),
           'ARTIFACT_ATTESTATION_DIGEST_INVALID')
    return {
        'name': ARTIFACT_NAME,
        'id': artifact_id,
        'digest_sha256': digest,
        'immutable': True,
    }


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = None
    try:
        with NamedTemporaryFile(
            mode='w', encoding='utf8', dir=path.parent,
            prefix='.ros-artifact-attestation-', suffix='.tmp', delete=False
        ) as stream:
            temp = Path(stream.name)
            os.chmod(stream.name, 0o600)
            json.dump(data, stream, ensure_ascii=False, sort_keys=True, indent=2)
            stream.write('\n')
        os.replace(temp, path)
    finally:
        if temp is not None:
            temp.unlink(missing_ok=True)


def create_attestation(folder, output, env):
    context = action_context(env)
    artifact = artifact_context(env)
    files = [hash_file(folder / name) for name in FILES]
    reject(len({item['filename'] for item in files}) == len(FILES),
           'ARTIFACT_ATTESTATION_FILES_DUPLICATED')
    bundle = next(item for item in files if item['filename'] == 'workflow-evidence-bundle.json')
    data = {
        'schema': SCHEMA,
        'status': 'attested',
        'source': SOURCE,
        'simulation_only': True,
        'physical_safety_certified': False,
        'release_approved': False,
        'context': context,
        'artifact': artifact,
        'files': files,
        'workflow_bundle_sha256': bundle['sha256'],
        'created_at': datetime.now(timezone.utc).isoformat(),
    }
    atomic_write(output, data)
    return data


def main():
    parser = argparse.ArgumentParser(description='Write ROS Actions artifact attestation')
    parser.add_argument('--folder', type=Path, default=Path('.local/ros'))
    parser.add_argument('--out', type=Path,
                        default=Path('.local/ros/artifact-attestation.json'))
    args = parser.parse_args()
    try:
        data = create_attestation(args.folder, args.out, os.environ)
    except (OSError, ValueError, TypeError) as exc:
        code = str(exc)
        if not re.fullmatch(r'ARTIFACT_ATTESTATION_[A-Z0-9_]+', code):
            code = 'ARTIFACT_ATTESTATION_CREATE_FAILED'
        print(code, file=__import__('sys').stderr)
        return 1
    print('ROS_ARTIFACT_ATTESTATION_CREATED:' + data['artifact']['id'])
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
