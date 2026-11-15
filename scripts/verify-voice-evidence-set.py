#!/usr/bin/env python3
"""R69：统一验证一个 Voice Provider 发布证据集合，禁止跨 Run/Artifact 拼接。"""
import argparse
import json
from pathlib import Path
import re
from runpy import run_path
import sys

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = Path(__file__).resolve().parent
REPORT_NAME = 'runtime-report.json'
WORKFLOW_NAME = 'workflow-evidence.json'
SHA40 = re.compile(r'^[0-9a-f]{40}$')
SHA256 = re.compile(r'^[0-9a-f]{64}$')
DIGITS = re.compile(r'^[1-9][0-9]{0,19}$')


def reject(condition, code):
    if not condition:
        raise ValueError(code)


def bounded_json(path, max_bytes):
    reject(path.is_file() and not path.is_symlink(),
           'VOICE_SET_FILE_MISSING_OR_SYMLINK')
    size = path.stat().st_size
    reject(2 <= size <= max_bytes, 'VOICE_SET_FILE_SIZE_INVALID')
    try:
        value = json.loads(path.read_text(encoding='utf8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError('VOICE_SET_JSON_INVALID') from exc
    reject(isinstance(value, dict), 'VOICE_SET_OBJECT_REQUIRED')
    return value


def normalize_digest(value):
    if isinstance(value, str) and value.startswith('sha256:'):
        value = value[7:]
    reject(isinstance(value, str) and SHA256.fullmatch(value),
           'VOICE_SET_ARTIFACT_DIGEST_INVALID')
    return value


def expected(args):
    reject(isinstance(args.run_id, str) and DIGITS.fullmatch(args.run_id),
           'VOICE_SET_RUN_ID_INVALID')
    reject(type(args.attempt) is int and 1 <= args.attempt <= 10000,
           'VOICE_SET_ATTEMPT_INVALID')
    reject(isinstance(args.commit_sha, str) and SHA40.fullmatch(args.commit_sha),
           'VOICE_SET_COMMIT_INVALID')
    reject(isinstance(args.artifact_id, str) and DIGITS.fullmatch(args.artifact_id),
           'VOICE_SET_ARTIFACT_ID_INVALID')
    return {
        'run_id': args.run_id,
        'attempt': args.attempt,
        'commit_sha': args.commit_sha,
        'artifact_id': args.artifact_id,
        'artifact_digest': normalize_digest(args.artifact_digest),
    }


def verify_set(folder, attestation_path, github_readback_path, meta):
    reject(folder.is_dir() and not folder.is_symlink(),
           'VOICE_SET_FOLDER_INVALID')
    report_path = folder / REPORT_NAME
    workflow_path = folder / WORKFLOW_NAME
    for path in (report_path, workflow_path):
        reject(path.is_file() and not path.is_symlink(),
               'VOICE_SET_FILE_MISSING_OR_SYMLINK')

    workflow_module = run_path(str(SCRIPTS / 'voice-workflow-evidence.py'))
    workflow_module['verify_evidence'](
        workflow_path, report_path,
        meta['run_id'], meta['attempt'], meta['commit_sha'])

    attestation_module = run_path(
        str(SCRIPTS / 'verify-voice-artifact-attestation.py'))
    attestation = bounded_json(attestation_path, 64 * 1024)
    expected_meta = {
        'artifact_id': meta['artifact_id'],
        'artifact_digest': meta['artifact_digest'],
        'run_id': meta['run_id'],
        'attempt': meta['attempt'],
        'commit_sha': meta['commit_sha'],
    }
    attestation_module['verify_attestation'](
        attestation, folder, expected_meta)

    readback_module = run_path(
        str(SCRIPTS / 'github-actions-voice-readback.py'))
    readback = bounded_json(github_readback_path, 128 * 1024)
    readback_module['verify_report'](readback, expected_meta)

    workflow = bounded_json(workflow_path, 64 * 1024)
    workflow_ctx = workflow.get('context')
    attest_ctx = attestation.get('context')
    readback_ctx = readback.get('context')
    reject(isinstance(workflow_ctx, dict)
           and isinstance(attest_ctx, dict)
           and isinstance(readback_ctx, dict),
           'VOICE_SET_CONTEXT_MISSING')
    common_keys = (
        'repository', 'workflow', 'workflow_ref', 'job',
        'runner_environment',
    )
    reject(all(workflow_ctx.get(key) == attest_ctx.get(key)
               for key in common_keys),
           'VOICE_SET_ATTESTATION_CONTEXT_MISMATCH')
    reject(
        all(workflow_ctx.get(key) == readback_ctx.get(key)
            for key in common_keys)
        and readback_ctx.get('id') == workflow_ctx.get('workflow_run_id')
        and readback_ctx.get('attempt') == workflow_ctx.get('workflow_run_attempt')
        and readback_ctx.get('commit_sha') == workflow_ctx.get('commit_sha'),
        'VOICE_SET_READBACK_CONTEXT_MISMATCH')

    reject(workflow_ctx.get('workflow_run_id') == meta['run_id']
           and workflow_ctx.get('workflow_run_attempt') == meta['attempt']
           and workflow_ctx.get('commit_sha') == meta['commit_sha'],
           'VOICE_SET_EXTERNAL_CONTEXT_MISMATCH')

    runtime = bounded_json(report_path, 64 * 1024)
    report_manifest = workflow.get('report')
    reject(isinstance(report_manifest, dict)
           and report_manifest.get('filename') == REPORT_NAME
           and report_manifest.get('run_id') == runtime.get('run_id'),
           'VOICE_SET_RUNTIME_MANIFEST_MISMATCH')

    artifact = attestation.get('artifact')
    readback_artifact = readback.get('artifact')
    reject(isinstance(artifact, dict)
           and artifact.get('id') == meta['artifact_id']
           and artifact.get('digest_sha256') == meta['artifact_digest']
           and isinstance(readback_artifact, dict)
           and readback_artifact.get('id') == meta['artifact_id']
           and normalize_digest(readback_artifact.get('digest_sha256'))
               == meta['artifact_digest'],
           'VOICE_SET_ARTIFACT_CONTEXT_MISMATCH')
    return True


def main():
    parser = argparse.ArgumentParser(description='Verify coherent Voice provider evidence set')
    parser.add_argument('--folder', type=Path, required=True)
    parser.add_argument('--attestation', type=Path, required=True)
    parser.add_argument('--github-readback', type=Path, required=True)
    parser.add_argument('--artifact-id', required=True)
    parser.add_argument('--artifact-digest', required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--attempt', type=int, required=True)
    parser.add_argument('--commit-sha', required=True)
    args = parser.parse_args()
    try:
        verify_set(
            args.folder, args.attestation, args.github_readback,
            expected(args))
    except (OSError, ValueError, TypeError) as exc:
        code = str(exc)
        if not re.fullmatch(
                r'(VOICE_SET|VOICE_EVIDENCE|VOICE_ATTESTATION|VOICE_READBACK)_[A-Z0-9_]+',
                code):
            code = 'VOICE_SET_VERIFY_FAILED'
        print(code, file=sys.stderr)
        return 1
    print('Voice provider evidence set coherently verified')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
