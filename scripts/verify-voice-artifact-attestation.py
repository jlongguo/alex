#!/usr/bin/env python3
"""R69：验证 Voice Artifact attestation 与下载后的关键证据文件。"""
import argparse
from hashlib import sha256
import json
from pathlib import Path
import re
import sys

SCHEMA = 'alex.dev/voice-artifact-attestation/v1'
SOURCE = 'github-actions-upload-artifact'
REPO = 'jlongguo/alex'
WORKFLOW = '.github/workflows/voice-provider-acceptance.yml'
JOB = 'voice-provider'
ARTIFACT_NAME = 'alex-voice-provider-runtime-evidence'
FILES = ('runtime-report.json', 'workflow-evidence.json')
SHA40 = re.compile(r'^[0-9a-f]{40}$')
SHA256 = re.compile(r'^[0-9a-f]{64}$')
DIGITS = re.compile(r'^[1-9][0-9]{0,19}$')
WORKFLOW_REF = re.compile(
    r'^jlongguo/alex/\.github/workflows/voice-provider-acceptance\.yml@refs/heads/[A-Za-z0-9_./-]+$')


def reject(condition, code):
    if not condition:
        raise ValueError(code)


def read_bounded(path, max_bytes):
    reject(path.is_file() and not path.is_symlink(),
           'VOICE_ATTESTATION_FILE_MISSING_OR_SYMLINK')
    size = path.stat().st_size
    reject(2 <= size <= max_bytes, 'VOICE_ATTESTATION_FILE_SIZE_INVALID')
    return path.read_bytes()


def normalize_digest(value):
    if isinstance(value, str) and value.startswith('sha256:'):
        value = value[7:]
    reject(isinstance(value, str) and SHA256.fullmatch(value),
           'VOICE_ATTESTATION_EXPECTED_DIGEST_INVALID')
    return value


def expected_metadata(args):
    reject(isinstance(args.artifact_id, str) and DIGITS.fullmatch(args.artifact_id),
           'VOICE_ATTESTATION_EXPECTED_ID_INVALID')
    reject(isinstance(args.run_id, str) and DIGITS.fullmatch(args.run_id),
           'VOICE_ATTESTATION_EXPECTED_RUN_INVALID')
    reject(type(args.attempt) is int and 1 <= args.attempt <= 10000,
           'VOICE_ATTESTATION_EXPECTED_ATTEMPT_INVALID')
    reject(isinstance(args.commit_sha, str) and SHA40.fullmatch(args.commit_sha),
           'VOICE_ATTESTATION_EXPECTED_COMMIT_INVALID')
    return {
        'artifact_id': args.artifact_id,
        'artifact_digest': normalize_digest(args.artifact_digest),
        'run_id': args.run_id,
        'attempt': args.attempt,
        'commit_sha': args.commit_sha,
    }


def verify_attestation(attestation, folder, expected):
    reject(isinstance(attestation, dict)
           and attestation.get('schema') == SCHEMA
           and attestation.get('status') == 'attested'
           and attestation.get('source') == SOURCE,
           'VOICE_ATTESTATION_SCHEMA_INVALID')
    reject(attestation.get('release_approved') is False
           and attestation.get('physical_safety_certified') is False,
           'VOICE_ATTESTATION_OVERCLAIMED')
    context = attestation.get('context')
    reject(isinstance(context, dict)
           and context.get('repository') == REPO
           and context.get('workflow') == WORKFLOW
           and context.get('job') == JOB
           and context.get('runner_environment') == 'github-hosted'
           and isinstance(context.get('workflow_ref'), str)
           and WORKFLOW_REF.fullmatch(context['workflow_ref'])
           and context.get('workflow_run_id') == expected['run_id']
           and context.get('workflow_run_attempt') == expected['attempt']
           and context.get('commit_sha') == expected['commit_sha'],
           'VOICE_ATTESTATION_RUN_CONTEXT_MISMATCH')
    artifact = attestation.get('artifact')
    reject(isinstance(artifact, dict)
           and artifact.get('name') == ARTIFACT_NAME
           and artifact.get('id') == expected['artifact_id']
           and artifact.get('digest_sha256') == expected['artifact_digest']
           and artifact.get('immutable') is True,
           'VOICE_ATTESTATION_UPLOAD_METADATA_MISMATCH')

    records = attestation.get('files')
    reject(isinstance(records, list) and len(records) == len(FILES),
           'VOICE_ATTESTATION_FILES_INCOMPLETE')
    by_name = {}
    for item in records:
        reject(isinstance(item, dict)
               and set(item) == {'filename', 'size_bytes', 'sha256'}
               and item.get('filename') in FILES
               and type(item.get('size_bytes')) is int
               and 2 <= item['size_bytes'] <= 128 * 1024
               and isinstance(item.get('sha256'), str)
               and SHA256.fullmatch(item['sha256']),
               'VOICE_ATTESTATION_FILE_RECORD_INVALID')
        reject(item['filename'] not in by_name,
               'VOICE_ATTESTATION_FILE_RECORD_DUPLICATED')
        by_name[item['filename']] = item
    reject(set(by_name) == set(FILES), 'VOICE_ATTESTATION_FILES_INCOMPLETE')

    for name in FILES:
        raw = read_bounded(folder / name, 128 * 1024)
        record = by_name[name]
        reject(len(raw) == record['size_bytes']
               and sha256(raw).hexdigest() == record['sha256'],
               'VOICE_ATTESTATION_DOWNLOADED_FILE_MISMATCH')
    reject(attestation.get('workflow_evidence_sha256')
           == by_name['workflow-evidence.json']['sha256'],
           'VOICE_ATTESTATION_WORKFLOW_DIGEST_MISMATCH')
    return True


def main():
    parser = argparse.ArgumentParser(description='Verify Voice Actions Artifact attestation')
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
        data = json.loads(read_bounded(args.attestation, 64 * 1024))
        verify_attestation(data, args.folder, expected)
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        code = str(exc)
        if not re.fullmatch(r'VOICE_ATTESTATION_[A-Z0-9_]+', code):
            code = 'VOICE_ATTESTATION_VERIFY_FAILED'
        print(code, file=sys.stderr)
        return 1
    print('Voice GitHub Actions Artifact attestation verified')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
