#!/usr/bin/env python3
"""R66：只读核对 GitHub Actions Run 与 ROS evidence Artifact 的真实 REST 记录。

生产 audit 模式只访问固定 api.github.com/repos/jlongguo/alex/actions/runs/... GET 接口。
不会修改 Workflow、Artifact、仓库或 Runner；不会打印 GITHUB_TOKEN。
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
from tempfile import NamedTemporaryFile
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

SCHEMA = 'alex.dev/github-actions-ros-readback/v1'
SOURCE = 'github-rest-api-actions-read'
REPO = 'jlongguo/alex'
WORKFLOW = '.github/workflows/ros-sim-acceptance.yml'
WORKFLOW_NAME = 'ROS Gazebo Nav2 Acceptance (manual)'
JOB = 'nav2-simulation'
ARTIFACT_NAME = 'alex-ros-gazebo-acceptance'
API_BASE = 'https://api.github.com'
SHA40 = re.compile(r'^[0-9a-f]{40}$')
SHA256 = re.compile(r'^[0-9a-f]{64}$')
DIGITS = re.compile(r'^[1-9][0-9]{0,19}$')
WORKFLOW_REF = re.compile(
    r'^jlongguo/alex/\.github/workflows/ros-sim-acceptance\.yml@refs/heads/[A-Za-z0-9_./-]+$')


def reject(condition, code):
    if not condition:
        raise ValueError(code)


def normalize_digest(value, code='GITHUB_READBACK_DIGEST_INVALID'):
    reject(isinstance(value, str), code)
    if value.startswith('sha256:'):
        value = value[7:]
    reject(SHA256.fullmatch(value) is not None, code)
    return value


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = None
    try:
        with NamedTemporaryFile(
            mode='w', encoding='utf8', dir=path.parent,
            prefix='.github-actions-readback-', suffix='.tmp', delete=False
        ) as stream:
            temp = Path(stream.name)
            os.chmod(stream.name, 0o600)
            json.dump(data, stream, ensure_ascii=False, sort_keys=True, indent=2)
            stream.write('\n')
        os.replace(temp, path)
    finally:
        if temp is not None:
            temp.unlink(missing_ok=True)


def read_json(path, max_bytes=128 * 1024):
    reject(path.is_file() and not path.is_symlink(),
           'GITHUB_READBACK_FILE_MISSING_OR_SYMLINK')
    size = path.stat().st_size
    reject(2 <= size <= max_bytes, 'GITHUB_READBACK_FILE_SIZE_INVALID')
    try:
        value = json.loads(path.read_text(encoding='utf8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError('GITHUB_READBACK_JSON_INVALID') from exc
    reject(isinstance(value, dict), 'GITHUB_READBACK_OBJECT_REQUIRED')
    return value


def environment_context(env):
    reject(env.get('GITHUB_ACTIONS') == 'true'
           and env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
           and env.get('GITHUB_REPOSITORY') == REPO
           and env.get('GITHUB_JOB') == JOB
           and env.get('RUNNER_ENVIRONMENT') == 'self-hosted',
           'GITHUB_READBACK_UNAPPROVED_CONTEXT')
    api_url = env.get('GITHUB_API_URL', API_BASE)
    reject(api_url == API_BASE, 'GITHUB_READBACK_API_BASE_UNAPPROVED')
    workflow_ref = env.get('GITHUB_WORKFLOW_REF')
    reject(isinstance(workflow_ref, str) and WORKFLOW_REF.fullmatch(workflow_ref),
           'GITHUB_READBACK_WORKFLOW_REF_INVALID')
    run_id = env.get('GITHUB_RUN_ID')
    attempt = env.get('GITHUB_RUN_ATTEMPT')
    commit = env.get('GITHUB_SHA')
    reject(isinstance(run_id, str) and DIGITS.fullmatch(run_id),
           'GITHUB_READBACK_RUN_ID_INVALID')
    reject(isinstance(attempt, str) and attempt.isascii() and attempt.isdigit()
           and 1 <= int(attempt) <= 10000,
           'GITHUB_READBACK_ATTEMPT_INVALID')
    reject(isinstance(commit, str) and SHA40.fullmatch(commit),
           'GITHUB_READBACK_COMMIT_INVALID')
    artifact_id = env.get('ALEX_ROS_ARTIFACT_ID')
    artifact_digest = normalize_digest(
        env.get('ALEX_ROS_ARTIFACT_DIGEST'),
        'GITHUB_READBACK_EXPECTED_DIGEST_INVALID')
    reject(isinstance(artifact_id, str) and DIGITS.fullmatch(artifact_id),
           'GITHUB_READBACK_ARTIFACT_ID_INVALID')
    token = env.get('GITHUB_TOKEN')
    reject(isinstance(token, str) and 20 <= len(token) <= 8192,
           'GITHUB_READBACK_TOKEN_MISSING')
    return {
        'workflow_ref': workflow_ref,
        'run_id': run_id,
        'attempt': int(attempt),
        'commit_sha': commit,
        'artifact_id': artifact_id,
        'artifact_digest': artifact_digest,
        'token': token,
    }


def github_get_json(url, token):
    reject(url.startswith(API_BASE + '/repos/jlongguo/alex/actions/runs/'),
           'GITHUB_READBACK_URL_UNAPPROVED')
    request = Request(url, method='GET', headers={
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + token,
        'User-Agent': 'alex-ros-evidence-readback',
        'X-GitHub-Api-Version': '2022-11-28',
    })
    try:
        with urlopen(request, timeout=15) as response:
            reject(response.status == 200, 'GITHUB_READBACK_HTTP_STATUS_INVALID')
            raw = response.read(1024 * 1024 + 1)
    except HTTPError as exc:
        raise ValueError('GITHUB_READBACK_HTTP_ERROR') from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise ValueError('GITHUB_READBACK_NETWORK_ERROR') from exc
    reject(len(raw) <= 1024 * 1024, 'GITHUB_READBACK_RESPONSE_TOO_LARGE')
    try:
        value = json.loads(raw)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError('GITHUB_READBACK_RESPONSE_JSON_INVALID') from exc
    reject(isinstance(value, dict), 'GITHUB_READBACK_RESPONSE_OBJECT_REQUIRED')
    return value


def validate_run(run, expected):
    repository = run.get('repository')
    reject(isinstance(repository, dict)
           and repository.get('full_name') == REPO,
           'GITHUB_READBACK_REPOSITORY_MISMATCH')
    reject(run.get('id') == int(expected['run_id'])
           and run.get('run_attempt') == expected['attempt']
           and run.get('head_sha') == expected['commit_sha'],
           'GITHUB_READBACK_RUN_CONTEXT_MISMATCH')
    reject(run.get('event') == 'workflow_dispatch'
           and run.get('name') == WORKFLOW_NAME
           and run.get('path') == WORKFLOW,
           'GITHUB_READBACK_WORKFLOW_MISMATCH')
    status = run.get('status')
    conclusion = run.get('conclusion')
    reject(status in ('in_progress', 'completed'),
           'GITHUB_READBACK_RUN_STATUS_INVALID')
    if status == 'completed':
        reject(conclusion == 'success', 'GITHUB_READBACK_RUN_NOT_SUCCESSFUL')
    else:
        reject(conclusion is None, 'GITHUB_READBACK_IN_PROGRESS_HAS_CONCLUSION')
    return {
        'id': expected['run_id'],
        'attempt': expected['attempt'],
        'commit_sha': expected['commit_sha'],
        'event': 'workflow_dispatch',
        'name': WORKFLOW_NAME,
        'path': WORKFLOW,
        'status_at_readback': status,
        'conclusion_at_readback': conclusion,
        'head_branch': run.get('head_branch'),
    }


def validate_artifacts(payload, expected):
    artifacts = payload.get('artifacts')
    reject(isinstance(artifacts, list),
           'GITHUB_READBACK_ARTIFACTS_INVALID')
    candidates = [
        item for item in artifacts
        if isinstance(item, dict) and item.get('name') == ARTIFACT_NAME
    ]
    reject(len(candidates) == 1,
           'GITHUB_READBACK_ARTIFACT_NOT_UNIQUE')
    artifact = candidates[0]
    reject(artifact.get('id') == int(expected['artifact_id']),
           'GITHUB_READBACK_ARTIFACT_ID_MISMATCH')
    digest = normalize_digest(
        artifact.get('digest'),
        'GITHUB_READBACK_API_DIGEST_INVALID')
    reject(digest == expected['artifact_digest'],
           'GITHUB_READBACK_ARTIFACT_DIGEST_MISMATCH')
    reject(artifact.get('expired') is False,
           'GITHUB_READBACK_ARTIFACT_EXPIRED')
    size = artifact.get('size_in_bytes')
    reject(type(size) is int and size > 0,
           'GITHUB_READBACK_ARTIFACT_SIZE_INVALID')
    workflow_run = artifact.get('workflow_run')
    reject(isinstance(workflow_run, dict)
           and workflow_run.get('id') == int(expected['run_id'])
           and workflow_run.get('head_sha') == expected['commit_sha'],
           'GITHUB_READBACK_ARTIFACT_RUN_MISMATCH')
    return {
        'id': expected['artifact_id'],
        'name': ARTIFACT_NAME,
        'digest_sha256': digest,
        'api_digest': artifact.get('digest'),
        'size_in_bytes': size,
        'expired': False,
        'created_at': artifact.get('created_at'),
        'updated_at': artifact.get('updated_at'),
    }


def create_readback(env, fetch_json=github_get_json):
    context = environment_context(env)
    base = f'{API_BASE}/repos/{REPO}/actions/runs/{context["run_id"]}'
    run = fetch_json(base, context['token'])
    artifacts = fetch_json(base + '/artifacts?per_page=100', context['token'])
    return {
        'schema': SCHEMA,
        'status': 'verified',
        'source': SOURCE,
        'read_only': True,
        'simulation_only': True,
        'physical_safety_certified': False,
        'release_approved': False,
        'context': {
            'repository': REPO,
            'workflow': WORKFLOW,
            'workflow_ref': context['workflow_ref'],
            'job': JOB,
            'runner_environment': 'self-hosted',
            **validate_run(run, context),
        },
        'artifact': validate_artifacts(artifacts, context),
        'api': {
            'base_url': API_BASE,
            'api_version': '2022-11-28',
            'actions_permission': 'read',
        },
        'created_at': datetime.now(timezone.utc).isoformat(),
    }


def expected_from_args(args):
    reject(isinstance(args.artifact_id, str) and DIGITS.fullmatch(args.artifact_id),
           'GITHUB_READBACK_EXPECTED_ARTIFACT_ID_INVALID')
    digest = normalize_digest(
        args.artifact_digest,
        'GITHUB_READBACK_EXPECTED_DIGEST_INVALID')
    reject(isinstance(args.run_id, str) and DIGITS.fullmatch(args.run_id),
           'GITHUB_READBACK_EXPECTED_RUN_ID_INVALID')
    reject(type(args.attempt) is int and 1 <= args.attempt <= 10000,
           'GITHUB_READBACK_EXPECTED_ATTEMPT_INVALID')
    reject(isinstance(args.commit_sha, str) and SHA40.fullmatch(args.commit_sha),
           'GITHUB_READBACK_EXPECTED_COMMIT_INVALID')
    return {
        'artifact_id': args.artifact_id,
        'artifact_digest': digest,
        'run_id': args.run_id,
        'attempt': args.attempt,
        'commit_sha': args.commit_sha,
    }


def verify_report(report, expected):
    reject(isinstance(report, dict)
           and report.get('schema') == SCHEMA
           and report.get('status') == 'verified'
           and report.get('source') == SOURCE
           and report.get('read_only') is True,
           'GITHUB_READBACK_REPORT_INVALID')
    reject(report.get('simulation_only') is True
           and report.get('physical_safety_certified') is False
           and report.get('release_approved') is False,
           'GITHUB_READBACK_OVERCLAIMED')
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
           and context.get('event') == 'workflow_dispatch'
           and context.get('name') == WORKFLOW_NAME
           and context.get('path') == WORKFLOW,
           'GITHUB_READBACK_REPORT_CONTEXT_MISMATCH')
    artifact = report.get('artifact')
    reject(isinstance(artifact, dict)
           and artifact.get('id') == expected['artifact_id']
           and artifact.get('name') == ARTIFACT_NAME
           and normalize_digest(
               artifact.get('digest_sha256'),
               'GITHUB_READBACK_REPORT_DIGEST_INVALID'
           ) == expected['artifact_digest']
           and artifact.get('expired') is False
           and type(artifact.get('size_in_bytes')) is int
           and artifact.get('size_in_bytes') > 0,
           'GITHUB_READBACK_REPORT_ARTIFACT_MISMATCH')
    api = report.get('api')
    reject(isinstance(api, dict)
           and api.get('base_url') == API_BASE
           and api.get('api_version') == '2022-11-28'
           and api.get('actions_permission') == 'read',
           'GITHUB_READBACK_REPORT_API_INVALID')
    return True


def main():
    parser = argparse.ArgumentParser(
        description='Read-only GitHub Actions ROS Artifact readback audit')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--audit', action='store_true')
    mode.add_argument('--verify', action='store_true')
    parser.add_argument('--out', type=Path,
                        default=Path('.local/ros/github-actions-readback.json'))
    parser.add_argument('--report', type=Path)
    parser.add_argument('--artifact-id')
    parser.add_argument('--artifact-digest')
    parser.add_argument('--run-id')
    parser.add_argument('--attempt', type=int)
    parser.add_argument('--commit-sha')
    args = parser.parse_args()
    try:
        if args.audit:
            report = create_readback(os.environ)
            atomic_write(args.out, report)
            print('GITHUB_ACTIONS_ROS_READBACK_VERIFIED:' + report['artifact']['id'])
        else:
            reject(args.report is not None,
                   'GITHUB_READBACK_VERIFY_REPORT_REQUIRED')
            expected = expected_from_args(args)
            verify_report(read_json(args.report), expected)
            print('GitHub Actions ROS readback report verified')
    except (OSError, ValueError, TypeError) as exc:
        code = str(exc)
        if not re.fullmatch(r'GITHUB_READBACK_[A-Z0-9_]+', code):
            code = 'GITHUB_READBACK_FAILED'
        print(code, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
