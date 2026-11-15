#!/usr/bin/env python3
"""R69：把真实 Voice Provider 运行报告绑定到一次 GitHub Actions 手动执行。

这里只做运行上下文、报告结构与文件哈希一致性验证；不会读取供应商凭据。
"""
import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from tempfile import NamedTemporaryFile
from time import time_ns

ROOT = Path(__file__).resolve().parent.parent
DEFAULT = ROOT / '.local/voice/workflow-evidence.json'
REPORT = ROOT / '.local/voice/runtime-report.json'
VERIFIER = ROOT / 'scripts/verify-voice-runtime-report.mjs'
SCHEMA = 'alex.dev/voice-workflow-evidence/v1'
SOURCE = 'github-actions-manual-github-hosted'
REPO = 'jlongguo/alex'
WORKFLOW = '.github/workflows/voice-provider-acceptance.yml'
JOB = 'voice-provider'
SHA40 = re.compile(r'^[0-9a-f]{40}$')
DIGITS = re.compile(r'^[1-9][0-9]{0,19}$')
RUN_ID = re.compile(r'^[0-9a-f-]{36}$')
WORKFLOW_REF = re.compile(
    r'^jlongguo/alex/\.github/workflows/voice-provider-acceptance\.yml@refs/heads/[A-Za-z0-9_./-]+$')


def reject(condition, code):
    if not condition:
        raise ValueError(code)


def read_bounded(path, max_bytes):
    reject(path.is_file() and not path.is_symlink(),
           'VOICE_EVIDENCE_FILE_MISSING_OR_SYMLINK')
    size = path.stat().st_size
    reject(2 <= size <= max_bytes, 'VOICE_EVIDENCE_FILE_SIZE_INVALID')
    return path.read_bytes()


def read_json(path, max_bytes):
    raw = read_bounded(path, max_bytes)
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError) as exc:
        raise ValueError('VOICE_EVIDENCE_JSON_INVALID') from exc
    reject(isinstance(value, dict), 'VOICE_EVIDENCE_OBJECT_REQUIRED')
    return raw, value


def verify_runtime_report(path, run_id):
    try:
        checked = subprocess.run(
            ['node', str(VERIFIER), '--report', str(path), '--run-id', run_id],
            cwd=ROOT, capture_output=True, text=True, timeout=20, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError('VOICE_EVIDENCE_REPORT_VERIFIER_FAILED') from exc
    reject(checked.returncode == 0,
           'VOICE_EVIDENCE_RUNTIME_REPORT_INVALID')


def action_context(env):
    reject(env.get('GITHUB_ACTIONS') == 'true'
           and env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
           and env.get('GITHUB_REPOSITORY') == REPO
           and env.get('GITHUB_JOB') == JOB
           and env.get('RUNNER_ENVIRONMENT') == 'github-hosted',
           'VOICE_EVIDENCE_UNAPPROVED_CONTEXT')
    workflow_ref = env.get('GITHUB_WORKFLOW_REF')
    reject(isinstance(workflow_ref, str) and WORKFLOW_REF.fullmatch(workflow_ref),
           'VOICE_EVIDENCE_WORKFLOW_REF_INVALID')
    run_id = env.get('GITHUB_RUN_ID')
    attempt = env.get('GITHUB_RUN_ATTEMPT')
    commit = env.get('GITHUB_SHA')
    reject(isinstance(run_id, str) and DIGITS.fullmatch(run_id),
           'VOICE_EVIDENCE_WORKFLOW_RUN_INVALID')
    reject(isinstance(attempt, str) and attempt.isascii() and attempt.isdigit()
           and 1 <= int(attempt) <= 10000,
           'VOICE_EVIDENCE_WORKFLOW_ATTEMPT_INVALID')
    reject(isinstance(commit, str) and SHA40.fullmatch(commit),
           'VOICE_EVIDENCE_COMMIT_INVALID')
    return {
        'repository': REPO,
        'workflow': WORKFLOW,
        'workflow_ref': workflow_ref,
        'job': JOB,
        'runner_environment': 'github-hosted',
        'workflow_run_id': run_id,
        'workflow_run_attempt': int(attempt),
        'commit_sha': commit,
    }


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = None
    try:
        with NamedTemporaryFile(
            mode='w', encoding='utf8', dir=path.parent,
            prefix='.voice-workflow-evidence-', suffix='.tmp', delete=False
        ) as stream:
            temporary = Path(stream.name)
            os.chmod(stream.name, 0o600)
            json.dump(data, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write('\n')
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def reset(output, env):
    context = action_context(env)
    atomic_write(output, {
        'schema': SCHEMA,
        'status': 'blocked',
        'source': SOURCE,
        'reason': 'VOICE_PROVIDER_ACCEPTANCE_PENDING',
        'release_approved': False,
        'physical_safety_certified': False,
        'context': context,
        'report': None,
        'started_at_ns': time_ns(),
    })


def collect(output, report_path, env):
    context = action_context(env)
    _, prior = read_json(output, 64 * 1024)
    reject(prior.get('schema') == SCHEMA
           and prior.get('status') == 'blocked'
           and prior.get('reason') == 'VOICE_PROVIDER_ACCEPTANCE_PENDING'
           and prior.get('context') == context
           and type(prior.get('started_at_ns')) is int
           and prior['started_at_ns'] > 0,
           'VOICE_EVIDENCE_WORKFLOW_NOT_RESET')
    reject(report_path.is_file() and not report_path.is_symlink()
           and report_path.stat().st_mtime_ns > prior['started_at_ns'],
           'VOICE_EVIDENCE_STALE_RUNTIME_REPORT')
    raw, report = read_json(report_path, 64 * 1024)
    run_id = report.get('run_id')
    reject(isinstance(run_id, str) and RUN_ID.fullmatch(run_id),
           'VOICE_EVIDENCE_RUNTIME_RUN_ID_INVALID')
    verify_runtime_report(report_path, run_id)
    entry = {
        'filename': report_path.name,
        'run_id': run_id,
        'size_bytes': len(raw),
        'sha256': sha256(raw).hexdigest(),
    }
    assembled = {
        'schema': SCHEMA,
        'status': 'assembled',
        'source': SOURCE,
        'release_approved': False,
        'physical_safety_certified': False,
        'context': context,
        'report': entry,
        'collected_at': datetime.now(timezone.utc).isoformat(),
    }
    atomic_write(output, assembled)
    return assembled


def verify_evidence(output, report_path, expected_run, expected_attempt,
                    expected_sha):
    reject(isinstance(expected_run, str) and DIGITS.fullmatch(expected_run),
           'VOICE_EVIDENCE_EXPECTED_RUN_INVALID')
    reject(type(expected_attempt) is int and 1 <= expected_attempt <= 10000,
           'VOICE_EVIDENCE_EXPECTED_ATTEMPT_INVALID')
    reject(isinstance(expected_sha, str) and SHA40.fullmatch(expected_sha),
           'VOICE_EVIDENCE_EXPECTED_SHA_INVALID')
    _, assembled = read_json(output, 64 * 1024)
    reject(assembled.get('schema') == SCHEMA
           and assembled.get('status') == 'assembled'
           and assembled.get('source') == SOURCE
           and assembled.get('release_approved') is False
           and assembled.get('physical_safety_certified') is False,
           'VOICE_EVIDENCE_NOT_ASSEMBLED')
    context = assembled.get('context')
    reject(isinstance(context, dict)
           and context.get('repository') == REPO
           and context.get('workflow') == WORKFLOW
           and context.get('job') == JOB
           and context.get('runner_environment') == 'github-hosted'
           and isinstance(context.get('workflow_ref'), str)
           and WORKFLOW_REF.fullmatch(context['workflow_ref'])
           and context.get('workflow_run_id') == expected_run
           and context.get('workflow_run_attempt') == expected_attempt
           and context.get('commit_sha') == expected_sha,
           'VOICE_EVIDENCE_CONTEXT_MISMATCH')
    raw, report = read_json(report_path, 64 * 1024)
    voice_run_id = report.get('run_id')
    reject(isinstance(voice_run_id, str) and RUN_ID.fullmatch(voice_run_id),
           'VOICE_EVIDENCE_RUNTIME_RUN_ID_INVALID')
    verify_runtime_report(report_path, voice_run_id)
    expected_entry = {
        'filename': report_path.name,
        'run_id': voice_run_id,
        'size_bytes': len(raw),
        'sha256': sha256(raw).hexdigest(),
    }
    reject(assembled.get('report') == expected_entry,
           'VOICE_EVIDENCE_REPORT_HASH_OR_RUN_MISMATCH')
    return True


def main():
    parser = argparse.ArgumentParser(description='Voice provider workflow evidence binder')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--reset', action='store_true')
    mode.add_argument('--collect', action='store_true')
    mode.add_argument('--verify', action='store_true')
    parser.add_argument('--out', type=Path, default=DEFAULT)
    parser.add_argument('--report', type=Path, default=REPORT)
    parser.add_argument('--expect-run-id')
    parser.add_argument('--expect-attempt', type=int)
    parser.add_argument('--expect-sha')
    args = parser.parse_args()
    try:
        if args.reset:
            reset(args.out, os.environ)
            print('VOICE_WORKFLOW_EVIDENCE_BLOCKED')
        elif args.collect:
            reject(args.expect_run_id is None and args.expect_attempt is None
                   and args.expect_sha is None,
                   'VOICE_EVIDENCE_COLLECT_UNEXPECTED_EXPECTATION')
            result = collect(args.out, args.report, os.environ)
            print('VOICE_WORKFLOW_EVIDENCE_ASSEMBLED:' + result['report']['run_id'])
        else:
            verify_evidence(
                args.out, args.report, args.expect_run_id,
                args.expect_attempt, args.expect_sha
            )
            print('Voice workflow evidence verified')
    except (OSError, ValueError, TypeError) as exc:
        code = str(exc)
        if not re.fullmatch(r'VOICE_EVIDENCE_[A-Z0-9_]+', code):
            code = 'VOICE_EVIDENCE_FAILED'
        print(code, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
