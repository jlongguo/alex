#!/usr/bin/env python3
"""R69：从 GitHub Actions REST API 回读当前 Full Voice Turn Run 与主 Artifact。"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
from tempfile import NamedTemporaryFile
from time import sleep
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

SCHEMA = 'alex.dev/github-actions-full-voice-turn-readback/v1'
SOURCE = 'github-rest-api-actions-read'
REPO = 'jlongguo/alex'
WORKFLOW = '.github/workflows/full-voice-turn-acceptance.yml'
WORKFLOW_NAME = 'Full Voice Turn Physical E2E (manual)'
JOB = 'full-voice-turn'
ARTIFACT_NAME = 'alex-full-voice-turn-physical-e2e'
API_BASE = 'https://api.github.com'
SHA40 = re.compile(r'^[0-9a-f]{40}$')
SHA256 = re.compile(r'^[0-9a-f]{64}$')
DIGITS = re.compile(r'^[1-9][0-9]{0,19}$')
WORKFLOW_REF = re.compile(
    r'^jlongguo/alex/\.github/workflows/full-voice-turn-acceptance\.yml@refs/heads/[A-Za-z0-9_./-]+$')


def reject(condition, code):
    if not condition:
        raise ValueError(code)


def normalize_digest(value, code):
    if isinstance(value, str) and value.startswith('sha256:'):
        value = value[7:]
    reject(isinstance(value, str) and SHA256.fullmatch(value), code)
    return value


def github_get_json(url, token):
    request = Request(
        url,
        headers={
            'Accept': 'application/vnd.github+json',
            'Authorization': 'Bearer ' + token,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'alex-full-voice-turn-readback',
        },
        method='GET',
    )
    try:
        with urlopen(request, timeout=12) as response:
            reject(response.status == 200, 'FULL_VOICE_TURN_READBACK_API_STATUS_INVALID')
            raw = response.read(2 * 1024 * 1024 + 1)
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        raise ValueError('FULL_VOICE_TURN_READBACK_API_REQUEST_FAILED') from exc
    reject(len(raw) <= 2 * 1024 * 1024,
           'FULL_VOICE_TURN_READBACK_API_RESPONSE_TOO_LARGE')
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeError) as exc:
        raise ValueError('FULL_VOICE_TURN_READBACK_API_JSON_INVALID') from exc
    reject(isinstance(data, dict), 'FULL_VOICE_TURN_READBACK_API_OBJECT_REQUIRED')
    return data


def environment_context(env):
    reject(env.get('GITHUB_ACTIONS') == 'true'
           and env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
           and env.get('GITHUB_REPOSITORY') == REPO
           and env.get('GITHUB_JOB') == JOB
           and env.get('RUNNER_ENVIRONMENT') == 'self-hosted',
           'FULL_VOICE_TURN_READBACK_UNAPPROVED_CONTEXT')
    reject(env.get('GITHUB_API_URL') in (None, '', API_BASE),
           'FULL_VOICE_TURN_READBACK_API_BASE_INVALID')
    workflow_ref = env.get('GITHUB_WORKFLOW_REF')
    reject(isinstance(workflow_ref, str) and WORKFLOW_REF.fullmatch(workflow_ref),
           'FULL_VOICE_TURN_READBACK_WORKFLOW_REF_INVALID')
    run_id = env.get('GITHUB_RUN_ID')
    attempt = env.get('GITHUB_RUN_ATTEMPT')
    commit = env.get('GITHUB_SHA')
    artifact_id = env.get('ALEX_FULL_VOICE_TURN_ARTIFACT_ID')
    artifact_digest = normalize_digest(
        env.get('ALEX_FULL_VOICE_TURN_ARTIFACT_DIGEST'),
        'FULL_VOICE_TURN_READBACK_ARTIFACT_DIGEST_INVALID')
    token = env.get('GITHUB_TOKEN')
    reject(isinstance(run_id, str) and DIGITS.fullmatch(run_id),
           'FULL_VOICE_TURN_READBACK_RUN_ID_INVALID')
    reject(isinstance(attempt, str) and attempt.isascii() and attempt.isdigit()
           and 1 <= int(attempt) <= 10000,
           'FULL_VOICE_TURN_READBACK_ATTEMPT_INVALID')
    reject(isinstance(commit, str) and SHA40.fullmatch(commit),
           'FULL_VOICE_TURN_READBACK_COMMIT_INVALID')
    reject(isinstance(artifact_id, str) and DIGITS.fullmatch(artifact_id),
           'FULL_VOICE_TURN_READBACK_ARTIFACT_ID_INVALID')
    reject(isinstance(token, str) and 20 <= len(token) <= 8192,
           'FULL_VOICE_TURN_READBACK_TOKEN_MISSING')
    metadata = {
        'workflow_ref': workflow_ref,
        'run_id': run_id,
        'attempt': int(attempt),
        'commit_sha': commit,
        'artifact_id': artifact_id,
        'artifact_digest': artifact_digest,
    }
    return metadata, token


def validate_run(run, expected):
    repository = run.get('repository')
    expected_branch = expected['workflow_ref'].split('@refs/heads/', 1)[1]
    reject(isinstance(repository, dict)
           and repository.get('full_name') == REPO,
           'FULL_VOICE_TURN_READBACK_REPOSITORY_MISMATCH')
    reject(run.get('id') == int(expected['run_id'])
           and run.get('run_attempt') == expected['attempt']
           and run.get('head_sha') == expected['commit_sha'],
           'FULL_VOICE_TURN_READBACK_RUN_CONTEXT_MISMATCH')
    reject(run.get('event') == 'workflow_dispatch'
           and run.get('name') == WORKFLOW_NAME
           and run.get('path') == WORKFLOW
           and run.get('head_branch') == expected_branch,
           'FULL_VOICE_TURN_READBACK_WORKFLOW_MISMATCH')
    reject(run.get('status') == 'in_progress'
           and run.get('conclusion') is None,
           'FULL_VOICE_TURN_READBACK_RUN_NOT_IN_PROGRESS')
    return {
        'repository': REPO,
        'workflow': WORKFLOW,
        'workflow_ref': expected['workflow_ref'],
        'job': JOB,
        'runner_environment': 'self-hosted',
        'id': expected['run_id'],
        'attempt': expected['attempt'],
        'commit_sha': expected['commit_sha'],
        'event': 'workflow_dispatch',
        'name': WORKFLOW_NAME,
        'path': WORKFLOW,
        'status_at_readback': 'in_progress',
        'conclusion_at_readback': None,
        'head_branch': expected_branch,
    }


def artifact_by_id(payload, artifact_id):
    items = payload.get('artifacts')
    reject(isinstance(items, list), 'FULL_VOICE_TURN_READBACK_ARTIFACTS_INVALID')
    matches = [
        item for item in items
        if isinstance(item, dict) and item.get('id') == int(artifact_id)
    ]
    reject(len(matches) > 0, 'FULL_VOICE_TURN_READBACK_ARTIFACT_MISSING')
    reject(len(matches) == 1, 'FULL_VOICE_TURN_READBACK_ARTIFACT_ID_NOT_UNIQUE')
    return matches[0]


def validate_artifact(item, expected):
    reject(item.get('name') == ARTIFACT_NAME,
           'FULL_VOICE_TURN_READBACK_ARTIFACT_NAME_MISMATCH')
    actual_digest = normalize_digest(
        item.get('digest'), 'FULL_VOICE_TURN_READBACK_API_DIGEST_INVALID')
    reject(actual_digest == expected['artifact_digest'],
           'FULL_VOICE_TURN_READBACK_ARTIFACT_DIGEST_MISMATCH')
    reject(item.get('expired') is False,
           'FULL_VOICE_TURN_READBACK_ARTIFACT_EXPIRED')
    size = item.get('size_in_bytes')
    reject(type(size) is int and size > 0,
           'FULL_VOICE_TURN_READBACK_ARTIFACT_SIZE_INVALID')
    workflow_run = item.get('workflow_run')
    reject(isinstance(workflow_run, dict)
           and workflow_run.get('id') == int(expected['run_id'])
           and workflow_run.get('head_sha') == expected['commit_sha'],
           'FULL_VOICE_TURN_READBACK_ARTIFACT_RUN_MISMATCH')
    return {
        'id': expected['artifact_id'],
        'name': ARTIFACT_NAME,
        'digest_sha256': actual_digest,
        'api_digest': item.get('digest'),
        'size_in_bytes': size,
        'expired': False,
        'created_at': item.get('created_at'),
        'updated_at': item.get('updated_at'),
    }


def create_audit(env, fetch_json=github_get_json, sleep_fn=sleep):
    expected, github_token = environment_context(env)
    base = f'{API_BASE}/repos/{REPO}/actions/runs/{expected["run_id"]}'
    run = validate_run(fetch_json(base, github_token), expected)
    artifact = None
    transient = {
        'FULL_VOICE_TURN_READBACK_ARTIFACT_MISSING',
        'FULL_VOICE_TURN_READBACK_API_DIGEST_INVALID',
    }
    for attempt_index in range(4):
        try:
            payload = fetch_json(base + '/artifacts?per_page=100', github_token)
            artifact = validate_artifact(
                artifact_by_id(payload, expected['artifact_id']), expected)
            break
        except ValueError as exc:
            if str(exc) not in transient or attempt_index == 3:
                raise
            sleep_fn(2)
    reject(artifact is not None, 'FULL_VOICE_TURN_READBACK_PROPAGATION_TIMEOUT')
    return {
        'schema': SCHEMA,
        'status': 'verified',
        'source': SOURCE,
        'read_only': True,
        'release_approved': False,
        'physical_safety_certified': False,
        'context': run,
        'artifact': artifact,
        'api': {
            'base_url': API_BASE,
            'api_version': '2022-11-28',
            'actions_permission': 'read',
        },
        'created_at': datetime.now(timezone.utc).isoformat(),
    }


def expected_from_args(args):
    reject(isinstance(args.run_id, str) and DIGITS.fullmatch(args.run_id),
           'FULL_VOICE_TURN_READBACK_EXPECTED_RUN_INVALID')
    reject(type(args.attempt) is int and 1 <= args.attempt <= 10000,
           'FULL_VOICE_TURN_READBACK_EXPECTED_ATTEMPT_INVALID')
    reject(isinstance(args.commit_sha, str) and SHA40.fullmatch(args.commit_sha),
           'FULL_VOICE_TURN_READBACK_EXPECTED_COMMIT_INVALID')
    reject(isinstance(args.artifact_id, str) and DIGITS.fullmatch(args.artifact_id),
           'FULL_VOICE_TURN_READBACK_EXPECTED_ID_INVALID')
    return {
        'run_id': args.run_id,
        'attempt': args.attempt,
        'commit_sha': args.commit_sha,
        'artifact_id': args.artifact_id,
        'artifact_digest': normalize_digest(
            args.artifact_digest, 'FULL_VOICE_TURN_READBACK_EXPECTED_DIGEST_INVALID'),
    }


def verify_report(report, expected):
    reject(isinstance(report, dict)
           and report.get('schema') == SCHEMA
           and report.get('status') == 'verified'
           and report.get('source') == SOURCE
           and report.get('read_only') is True,
           'FULL_VOICE_TURN_READBACK_REPORT_INVALID')
    reject(report.get('release_approved') is False
           and report.get('physical_safety_certified') is False,
           'FULL_VOICE_TURN_READBACK_OVERCLAIMED')
    context = report.get('context')
    reject(isinstance(context, dict)
           and context.get('repository') == REPO
           and context.get('workflow') == WORKFLOW
           and context.get('job') == JOB
           and context.get('runner_environment') == 'self-hosted'
           and isinstance(context.get('workflow_ref'), str)
           and WORKFLOW_REF.fullmatch(context['workflow_ref'])
           and context.get('id') == expected['run_id']
           and context.get('attempt') == expected['attempt']
           and context.get('commit_sha') == expected['commit_sha']
           and context.get('status_at_readback') == 'in_progress'
           and context.get('conclusion_at_readback') is None,
           'FULL_VOICE_TURN_READBACK_REPORT_CONTEXT_MISMATCH')
    artifact = report.get('artifact')
    reject(isinstance(artifact, dict)
           and artifact.get('name') == ARTIFACT_NAME
           and artifact.get('id') == expected['artifact_id']
           and normalize_digest(
               artifact.get('digest_sha256'),
               'FULL_VOICE_TURN_READBACK_REPORT_DIGEST_INVALID')
               == expected['artifact_digest']
           and normalize_digest(
               artifact.get('api_digest'),
               'FULL_VOICE_TURN_READBACK_REPORT_API_DIGEST_INVALID')
               == expected['artifact_digest']
           and artifact.get('expired') is False
           and type(artifact.get('size_in_bytes')) is int
           and artifact.get('size_in_bytes') > 0,
           'FULL_VOICE_TURN_READBACK_REPORT_ARTIFACT_MISMATCH')
    api = report.get('api')
    reject(isinstance(api, dict)
           and api.get('base_url') == API_BASE
           and api.get('api_version') == '2022-11-28'
           and api.get('actions_permission') == 'read',
           'FULL_VOICE_TURN_READBACK_REPORT_API_INVALID')
    return True


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = None
    try:
        with NamedTemporaryFile(
            mode='w', encoding='utf8', dir=path.parent,
            prefix='.full_voice_turn-actions-readback-', suffix='.tmp', delete=False
        ) as stream:
            temporary = Path(stream.name)
            os.chmod(stream.name, 0o600)
            json.dump(data, stream, ensure_ascii=False, sort_keys=True, indent=2)
            stream.write('\n')
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def read_json(path):
    reject(path.is_file() and not path.is_symlink(),
           'FULL_VOICE_TURN_READBACK_REPORT_FILE_INVALID')
    reject(2 <= path.stat().st_size <= 128 * 1024,
           'FULL_VOICE_TURN_READBACK_REPORT_FILE_INVALID')
    try:
        value = json.loads(path.read_text(encoding='utf8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError('FULL_VOICE_TURN_READBACK_REPORT_JSON_INVALID') from exc
    reject(isinstance(value, dict), 'FULL_VOICE_TURN_READBACK_REPORT_OBJECT_REQUIRED')
    return value


def main():
    parser = argparse.ArgumentParser(description='Read back Full Voice Turn GitHub Actions Artifact')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--audit', action='store_true')
    mode.add_argument('--verify', action='store_true')
    parser.add_argument('--out', type=Path,
                        default=Path('.local/voice/full-turn/github-actions-readback.json'))
    parser.add_argument('--report', type=Path)
    parser.add_argument('--artifact-id')
    parser.add_argument('--artifact-digest')
    parser.add_argument('--run-id')
    parser.add_argument('--attempt', type=int)
    parser.add_argument('--commit-sha')
    args = parser.parse_args()
    try:
        if args.audit:
            report = create_audit(os.environ)
            atomic_write(args.out, report)
            print('GITHUB_FULL_VOICE_TURN_READBACK_VERIFIED:' + report['artifact']['id'])
        else:
            reject(args.report is not None,
                   'FULL_VOICE_TURN_READBACK_VERIFY_REPORT_REQUIRED')
            expected = expected_from_args(args)
            verify_report(read_json(args.report), expected)
            print('GitHub Actions Full Voice Turn Artifact readback verified')
    except (OSError, ValueError, TypeError) as exc:
        code = str(exc)
        if not re.fullmatch(r'FULL_VOICE_TURN_READBACK_[A-Z0-9_]+', code):
            code = 'FULL_VOICE_TURN_READBACK_FAILED'
        print(code, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
