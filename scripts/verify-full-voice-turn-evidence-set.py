#!/usr/bin/env python3
"""R77：统一验证一个 Full Voice Turn 发布证据集合，禁止跨 Run/Artifact/Commit 拼接。"""
import argparse
import json
from pathlib import Path
import re
from runpy import run_path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = Path(__file__).resolve().parent
REPORT_NAME = 'report.json'
SHA40 = re.compile(r'^[0-9a-f]{40}$')
SHA256 = re.compile(r'^[0-9a-f]{64}$')
DIGITS = re.compile(r'^[1-9][0-9]{0,19}$')


def reject(condition, code):
    if not condition:
        raise ValueError(code)


def bounded_json(path, max_bytes):
    reject(path.is_file() and not path.is_symlink(),
           'FULL_VOICE_TURN_SET_FILE_MISSING_OR_SYMLINK')
    size = path.stat().st_size
    reject(2 <= size <= max_bytes, 'FULL_VOICE_TURN_SET_FILE_SIZE_INVALID')
    try:
        value = json.loads(path.read_text(encoding='utf8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError('FULL_VOICE_TURN_SET_JSON_INVALID') from exc
    reject(isinstance(value, dict), 'FULL_VOICE_TURN_SET_OBJECT_REQUIRED')
    return value


def normalize_digest(value):
    if isinstance(value, str) and value.startswith('sha256:'):
        value = value[7:]
    reject(isinstance(value, str) and SHA256.fullmatch(value),
           'FULL_VOICE_TURN_SET_ARTIFACT_DIGEST_INVALID')
    return value


def expected(args):
    reject(isinstance(args.run_id, str) and DIGITS.fullmatch(args.run_id),
           'FULL_VOICE_TURN_SET_RUN_ID_INVALID')
    reject(type(args.attempt) is int and 1 <= args.attempt <= 10000,
           'FULL_VOICE_TURN_SET_ATTEMPT_INVALID')
    reject(isinstance(args.commit_sha, str) and SHA40.fullmatch(args.commit_sha),
           'FULL_VOICE_TURN_SET_COMMIT_INVALID')
    reject(isinstance(args.artifact_id, str) and DIGITS.fullmatch(args.artifact_id),
           'FULL_VOICE_TURN_SET_ARTIFACT_ID_INVALID')
    return {
        'run_id': args.run_id,
        'attempt': args.attempt,
        'commit_sha': args.commit_sha,
        'artifact_id': args.artifact_id,
        'artifact_digest': normalize_digest(args.artifact_digest),
    }


def verify_set(folder, attestation_path, github_readback_path, meta):
    reject(folder.is_dir() and not folder.is_symlink(),
           'FULL_VOICE_TURN_SET_FOLDER_INVALID')
    report_path = folder / REPORT_NAME
    reject(report_path.is_file() and not report_path.is_symlink(),
           'FULL_VOICE_TURN_SET_FILE_MISSING_OR_SYMLINK')

    runtime = bounded_json(report_path, 128 * 1024)
    context = runtime.get('context')
    reject(isinstance(context, dict)
           and context.get('source') == 'github-actions-self-hosted'
           and context.get('runId') == meta['run_id']
           and context.get('attempt') == meta['attempt']
           and context.get('commitSha') == meta['commit_sha'],
           'FULL_VOICE_TURN_SET_RUNTIME_CONTEXT_MISMATCH')
    checked = subprocess.run(
        ['node', str(SCRIPTS / 'full-voice-turn-acceptance.mjs'), 'verify',
         '--report', str(report_path), '--run-id', meta['run_id'],
         '--commit', meta['commit_sha']],
        cwd=ROOT, capture_output=True, text=True, timeout=20, check=False)
    reject(checked.returncode == 0, 'FULL_VOICE_TURN_SET_RUNTIME_REPORT_INVALID')

    attestation_module = run_path(
        str(SCRIPTS / 'verify-full-voice-turn-artifact-attestation.py'))
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
        str(SCRIPTS / 'github-actions-full-voice-turn-readback.py'))
    readback = bounded_json(github_readback_path, 128 * 1024)
    readback_module['verify_report'](readback, expected_meta)

    attest_ctx = attestation.get('context')
    readback_ctx = readback.get('context')
    common_keys = (
        'repository', 'workflow', 'workflow_ref', 'job',
        'runner_environment',
    )
    reject(isinstance(attest_ctx, dict) and isinstance(readback_ctx, dict),
           'FULL_VOICE_TURN_SET_CONTEXT_MISSING')
    reject(all(attest_ctx.get(key) == readback_ctx.get(key)
               for key in common_keys)
           and readback_ctx.get('id') == attest_ctx.get('workflow_run_id')
           and readback_ctx.get('attempt') == attest_ctx.get('workflow_run_attempt')
           and readback_ctx.get('commit_sha') == attest_ctx.get('commit_sha'),
           'FULL_VOICE_TURN_SET_READBACK_CONTEXT_MISMATCH')
    reject(attest_ctx.get('workflow_run_id') == meta['run_id']
           and attest_ctx.get('workflow_run_attempt') == meta['attempt']
           and attest_ctx.get('commit_sha') == meta['commit_sha'],
           'FULL_VOICE_TURN_SET_EXTERNAL_CONTEXT_MISMATCH')

    artifact = attestation.get('artifact')
    readback_artifact = readback.get('artifact')
    reject(isinstance(artifact, dict) and isinstance(readback_artifact, dict)
           and artifact.get('id') == readback_artifact.get('id') == meta['artifact_id']
           and artifact.get('digest_sha256') == readback_artifact.get('digest_sha256')
           == meta['artifact_digest'],
           'FULL_VOICE_TURN_SET_ARTIFACT_METADATA_MISMATCH')

    report_hash = attestation.get('runtime_report_sha256')
    records = attestation.get('files')
    reject(isinstance(report_hash, str) and SHA256.fullmatch(report_hash)
           and isinstance(records, list) and len(records) == 1
           and records[0].get('filename') == REPORT_NAME
           and records[0].get('sha256') == report_hash,
           'FULL_VOICE_TURN_SET_REPORT_ATTESTATION_MISMATCH')
    return True


def main():
    parser = argparse.ArgumentParser(description='Verify coherent Full Voice Turn evidence set')
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
        meta = expected(args)
        verify_set(args.folder, args.attestation, args.github_readback, meta)
    except (OSError, ValueError, TypeError, subprocess.TimeoutExpired) as exc:
        code = str(exc)
        if not re.fullmatch(r'FULL_VOICE_TURN_SET_[A-Z0-9_]+', code):
            code = 'FULL_VOICE_TURN_SET_FAILED'
        print(code, file=sys.stderr)
        return 1
    print('Full Voice Turn coherent evidence set verified')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
