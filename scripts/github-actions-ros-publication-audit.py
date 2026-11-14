#!/usr/bin/env python3
"""R67：由独立 GitHub-hosted Job 对 ROS 双 Artifact 做最终只读发布审计。

它验证 self-hosted producer Job 已成功结束、Runner labels 符合仿真约束，
并从 GitHub REST API 核对主 evidence Artifact 与 attestation Artifact 的
ID/Digest/Run/SHA。不会创建第三个 Artifact，避免证明链无限递归。
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
from runpy import run_path
import sys
from tempfile import NamedTemporaryFile

SCRIPTS = Path(__file__).resolve().parent
READBACK = run_path(str(SCRIPTS / 'github-actions-ros-readback.py'))
github_get_json = READBACK['github_get_json']
normalize_digest = READBACK['normalize_digest']

SCHEMA = 'alex.dev/github-actions-ros-publication-audit/v1'
SOURCE = 'github-rest-api-dual-artifact-post-job-read'
REPO = 'jlongguo/alex'
WORKFLOW = '.github/workflows/ros-sim-acceptance.yml'
WORKFLOW_NAME = 'ROS Gazebo Nav2 Acceptance (manual)'
PRODUCER_JOB = 'nav2-simulation'
AUDIT_JOB = 'publication-audit'
MAIN_ARTIFACT = 'alex-ros-gazebo-acceptance'
ATTESTATION_ARTIFACT = 'alex-ros-gazebo-attestation'
API_BASE = 'https://api.github.com'
PRODUCER_LABELS = {'self-hosted', 'linux', 'x64', 'alex-ros-sim'}
SHA40 = re.compile(r'^[0-9a-f]{40}$')
DIGITS = re.compile(r'^[1-9][0-9]{0,19}$')
WORKFLOW_REF = re.compile(
    r'^jlongguo/alex/\.github/workflows/ros-sim-acceptance\.yml@refs/heads/[A-Za-z0-9_./-]+$')


def reject(condition, code):
    if not condition:
        raise ValueError(code)


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = None
    try:
        with NamedTemporaryFile(
            mode='w', encoding='utf8', dir=path.parent,
            prefix='.ros-publication-audit-', suffix='.tmp', delete=False
        ) as stream:
            temporary = Path(stream.name)
            os.chmod(stream.name, 0o600)
            json.dump(data, stream, ensure_ascii=False, sort_keys=True, indent=2)
            stream.write('\n')
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def read_json(path, max_bytes=128 * 1024):
    reject(path.is_file() and not path.is_symlink(),
           'PUBLICATION_AUDIT_FILE_MISSING_OR_SYMLINK')
    size = path.stat().st_size
    reject(2 <= size <= max_bytes, 'PUBLICATION_AUDIT_FILE_SIZE_INVALID')
    try:
        value = json.loads(path.read_text(encoding='utf8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError('PUBLICATION_AUDIT_JSON_INVALID') from exc
    reject(isinstance(value, dict), 'PUBLICATION_AUDIT_OBJECT_REQUIRED')
    return value


def environment_context(env):
    reject(env.get('GITHUB_ACTIONS') == 'true'
           and env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
           and env.get('GITHUB_REPOSITORY') == REPO
           and env.get('GITHUB_JOB') == AUDIT_JOB
           and env.get('RUNNER_ENVIRONMENT') == 'github-hosted',
           'PUBLICATION_AUDIT_UNAPPROVED_CONTEXT')
    reject(env.get('GITHUB_API_URL', API_BASE) == API_BASE,
           'PUBLICATION_AUDIT_API_BASE_UNAPPROVED')
    workflow_ref = env.get('GITHUB_WORKFLOW_REF')
    reject(isinstance(workflow_ref, str) and WORKFLOW_REF.fullmatch(workflow_ref),
           'PUBLICATION_AUDIT_WORKFLOW_REF_INVALID')

    run_id = env.get('GITHUB_RUN_ID')
    attempt = env.get('GITHUB_RUN_ATTEMPT')
    commit = env.get('GITHUB_SHA')
    reject(isinstance(run_id, str) and DIGITS.fullmatch(run_id),
           'PUBLICATION_AUDIT_RUN_ID_INVALID')
    reject(isinstance(attempt, str) and attempt.isascii() and attempt.isdigit()
           and 1 <= int(attempt) <= 10000,
           'PUBLICATION_AUDIT_ATTEMPT_INVALID')
    reject(isinstance(commit, str) and SHA40.fullmatch(commit),
           'PUBLICATION_AUDIT_COMMIT_INVALID')

    main_id = env.get('ALEX_ROS_ARTIFACT_ID')
    attest_id = env.get('ALEX_ROS_ATTESTATION_ARTIFACT_ID')
    reject(isinstance(main_id, str) and DIGITS.fullmatch(main_id),
           'PUBLICATION_AUDIT_MAIN_ARTIFACT_ID_INVALID')
    reject(isinstance(attest_id, str) and DIGITS.fullmatch(attest_id),
           'PUBLICATION_AUDIT_ATTESTATION_ARTIFACT_ID_INVALID')
    reject(main_id != attest_id, 'PUBLICATION_AUDIT_ARTIFACT_IDS_REUSED')

    main_digest = normalize_digest(
        env.get('ALEX_ROS_ARTIFACT_DIGEST'),
        'PUBLICATION_AUDIT_MAIN_DIGEST_INVALID')
    attest_digest = normalize_digest(
        env.get('ALEX_ROS_ATTESTATION_ARTIFACT_DIGEST'),
        'PUBLICATION_AUDIT_ATTESTATION_DIGEST_INVALID')
    token = env.get('GITHUB_TOKEN')
    reject(isinstance(token, str) and 20 <= len(token) <= 8192,
           'PUBLICATION_AUDIT_TOKEN_MISSING')

    return {
        'workflow_ref': workflow_ref,
        'run_id': run_id,
        'attempt': int(attempt),
        'commit_sha': commit,
        'main_artifact_id': main_id,
        'main_artifact_digest': main_digest,
        'attestation_artifact_id': attest_id,
        'attestation_artifact_digest': attest_digest,
        'token': token,
    }


def validate_run(run, expected):
    repository = run.get('repository')
    reject(isinstance(repository, dict)
           and repository.get('full_name') == REPO,
           'PUBLICATION_AUDIT_REPOSITORY_MISMATCH')
    expected_branch = expected['workflow_ref'].split('@refs/heads/', 1)[1]
    reject(run.get('id') == int(expected['run_id'])
           and run.get('run_attempt') == expected['attempt']
           and run.get('head_sha') == expected['commit_sha'],
           'PUBLICATION_AUDIT_RUN_CONTEXT_MISMATCH')
    reject(run.get('event') == 'workflow_dispatch'
           and run.get('name') == WORKFLOW_NAME
           and run.get('path') == WORKFLOW
           and run.get('head_branch') == expected_branch,
           'PUBLICATION_AUDIT_WORKFLOW_MISMATCH')
    # 当前 audit job 正在运行，所以整个 workflow 此刻应仍是 in_progress。
    reject(run.get('status') == 'in_progress' and run.get('conclusion') is None,
           'PUBLICATION_AUDIT_RUN_NOT_IN_PROGRESS')
    return {
        'id': expected['run_id'],
        'attempt': expected['attempt'],
        'commit_sha': expected['commit_sha'],
        'head_branch': expected_branch,
        'status_at_audit': 'in_progress',
        'conclusion_at_audit': None,
    }


def artifact_by_name(payload, name):
    items = payload.get('artifacts')
    reject(isinstance(items, list), 'PUBLICATION_AUDIT_ARTIFACTS_INVALID')
    matches = [x for x in items if isinstance(x, dict) and x.get('name') == name]
    reject(len(matches) == 1, 'PUBLICATION_AUDIT_ARTIFACT_NOT_UNIQUE')
    return matches[0]


def validate_artifact(item, *, name, artifact_id, digest, expected):
    reject(item.get('id') == int(artifact_id),
           'PUBLICATION_AUDIT_ARTIFACT_ID_MISMATCH')
    actual_digest = normalize_digest(
        item.get('digest'), 'PUBLICATION_AUDIT_API_DIGEST_INVALID')
    reject(actual_digest == digest,
           'PUBLICATION_AUDIT_ARTIFACT_DIGEST_MISMATCH')
    reject(item.get('expired') is False,
           'PUBLICATION_AUDIT_ARTIFACT_EXPIRED')
    size = item.get('size_in_bytes')
    reject(type(size) is int and size > 0,
           'PUBLICATION_AUDIT_ARTIFACT_SIZE_INVALID')
    workflow_run = item.get('workflow_run')
    reject(isinstance(workflow_run, dict)
           and workflow_run.get('id') == int(expected['run_id'])
           and workflow_run.get('head_sha') == expected['commit_sha'],
           'PUBLICATION_AUDIT_ARTIFACT_RUN_MISMATCH')
    return {
        'id': artifact_id,
        'name': name,
        'digest_sha256': actual_digest,
        'api_digest': item.get('digest'),
        'size_in_bytes': size,
        'expired': False,
        'created_at': item.get('created_at'),
        'updated_at': item.get('updated_at'),
    }


def validate_jobs(payload, expected):
    jobs = payload.get('jobs')
    reject(isinstance(jobs, list), 'PUBLICATION_AUDIT_JOBS_INVALID')
    producer = [x for x in jobs if isinstance(x, dict) and x.get('name') == PRODUCER_JOB]
    audit = [x for x in jobs if isinstance(x, dict) and x.get('name') == AUDIT_JOB]
    reject(len(producer) == 1 and len(audit) == 1,
           'PUBLICATION_AUDIT_JOBS_NOT_UNIQUE')
    producer = producer[0]
    audit = audit[0]

    reject(producer.get('run_id') == int(expected['run_id'])
           and producer.get('run_attempt') == expected['attempt']
           and producer.get('head_sha') == expected['commit_sha']
           and producer.get('status') == 'completed'
           and producer.get('conclusion') == 'success',
           'PUBLICATION_AUDIT_PRODUCER_NOT_SUCCESSFUL')
    labels = producer.get('labels')
    reject(isinstance(labels, list)
           and PRODUCER_LABELS.issubset(set(labels)),
           'PUBLICATION_AUDIT_PRODUCER_LABELS_MISMATCH')
    reject(isinstance(producer.get('runner_name'), str)
           and producer.get('runner_name').strip() != '',
           'PUBLICATION_AUDIT_PRODUCER_RUNNER_NAME_MISSING')

    reject(audit.get('run_id') == int(expected['run_id'])
           and audit.get('run_attempt') == expected['attempt']
           and audit.get('head_sha') == expected['commit_sha']
           and audit.get('status') == 'in_progress'
           and audit.get('conclusion') is None,
           'PUBLICATION_AUDIT_AUDITOR_JOB_INVALID')
    audit_labels = audit.get('labels')
    reject(isinstance(audit_labels, list) and 'ubuntu-latest' in audit_labels,
           'PUBLICATION_AUDIT_AUDITOR_LABELS_MISMATCH')

    producer_completed = producer.get('completed_at')
    audit_started = audit.get('started_at')
    reject(isinstance(producer_completed, str)
           and isinstance(audit_started, str)
           and producer_completed <= audit_started,
           'PUBLICATION_AUDIT_JOB_ORDER_INVALID')
    return {
        'producer': {
            'id': producer.get('id'),
            'name': PRODUCER_JOB,
            'status': 'completed',
            'conclusion': 'success',
            'runner_name': producer.get('runner_name'),
            'runner_group_name': producer.get('runner_group_name'),
            'labels': sorted(labels),
            'completed_at': producer_completed,
        },
        'auditor': {
            'id': audit.get('id'),
            'name': AUDIT_JOB,
            'status': 'in_progress',
            'runner_name': audit.get('runner_name'),
            'runner_group_name': audit.get('runner_group_name'),
            'labels': sorted(audit_labels),
            'started_at': audit_started,
        },
    }


def create_audit(env, fetch_json=github_get_json):
    expected = environment_context(env)
    base = f'{API_BASE}/repos/{REPO}/actions/runs/{expected["run_id"]}'
    run = fetch_json(base, expected['token'])
    artifacts = fetch_json(base + '/artifacts?per_page=100', expected['token'])
    jobs = fetch_json(
        base + '/jobs?filter=latest&per_page=100', expected['token'])

    run_record = validate_run(run, expected)
    main = validate_artifact(
        artifact_by_name(artifacts, MAIN_ARTIFACT),
        name=MAIN_ARTIFACT,
        artifact_id=expected['main_artifact_id'],
        digest=expected['main_artifact_digest'],
        expected=expected,
    )
    attestation = validate_artifact(
        artifact_by_name(artifacts, ATTESTATION_ARTIFACT),
        name=ATTESTATION_ARTIFACT,
        artifact_id=expected['attestation_artifact_id'],
        digest=expected['attestation_artifact_digest'],
        expected=expected,
    )
    reject(main['id'] != attestation['id'],
           'PUBLICATION_AUDIT_ARTIFACT_IDS_REUSED')
    if isinstance(main.get('created_at'), str) and isinstance(attestation.get('created_at'), str):
        reject(main['created_at'] <= attestation['created_at'],
               'PUBLICATION_AUDIT_ARTIFACT_ORDER_INVALID')

    return {
        'schema': SCHEMA,
        'status': 'verified',
        'source': SOURCE,
        'read_only': True,
        'audit_runner': 'github-hosted',
        'closure_strategy': 'post-producer-dual-artifact-rest-readback-no-third-artifact',
        'simulation_only': True,
        'physical_safety_certified': False,
        'release_approved': False,
        'context': {
            'repository': REPO,
            'workflow': WORKFLOW,
            'workflow_ref': expected['workflow_ref'],
            **run_record,
        },
        'jobs': validate_jobs(jobs, expected),
        'artifacts': {
            'evidence': main,
            'attestation': attestation,
        },
        'api': {
            'base_url': API_BASE,
            'api_version': '2022-11-28',
            'actions_permission': 'read',
        },
        'created_at': datetime.now(timezone.utc).isoformat(),
    }


def expected_from_args(args):
    reject(isinstance(args.run_id, str) and DIGITS.fullmatch(args.run_id),
           'PUBLICATION_AUDIT_EXPECTED_RUN_INVALID')
    reject(type(args.attempt) is int and 1 <= args.attempt <= 10000,
           'PUBLICATION_AUDIT_EXPECTED_ATTEMPT_INVALID')
    reject(isinstance(args.commit_sha, str) and SHA40.fullmatch(args.commit_sha),
           'PUBLICATION_AUDIT_EXPECTED_COMMIT_INVALID')
    for value, code in (
        (args.main_artifact_id, 'PUBLICATION_AUDIT_EXPECTED_MAIN_ID_INVALID'),
        (args.attestation_artifact_id, 'PUBLICATION_AUDIT_EXPECTED_ATTESTATION_ID_INVALID'),
    ):
        reject(isinstance(value, str) and DIGITS.fullmatch(value), code)
    reject(args.main_artifact_id != args.attestation_artifact_id,
           'PUBLICATION_AUDIT_ARTIFACT_IDS_REUSED')
    return {
        'run_id': args.run_id,
        'attempt': args.attempt,
        'commit_sha': args.commit_sha,
        'main_artifact_id': args.main_artifact_id,
        'main_artifact_digest': normalize_digest(
            args.main_artifact_digest,
            'PUBLICATION_AUDIT_EXPECTED_MAIN_DIGEST_INVALID'),
        'attestation_artifact_id': args.attestation_artifact_id,
        'attestation_artifact_digest': normalize_digest(
            args.attestation_artifact_digest,
            'PUBLICATION_AUDIT_EXPECTED_ATTESTATION_DIGEST_INVALID'),
    }


def verify_report(report, expected):
    reject(isinstance(report, dict)
           and report.get('schema') == SCHEMA
           and report.get('status') == 'verified'
           and report.get('source') == SOURCE
           and report.get('read_only') is True
           and report.get('audit_runner') == 'github-hosted'
           and report.get('closure_strategy')
               == 'post-producer-dual-artifact-rest-readback-no-third-artifact',
           'PUBLICATION_AUDIT_REPORT_INVALID')
    reject(report.get('simulation_only') is True
           and report.get('physical_safety_certified') is False
           and report.get('release_approved') is False,
           'PUBLICATION_AUDIT_OVERCLAIMED')
    context = report.get('context')
    reject(isinstance(context, dict)
           and context.get('repository') == REPO
           and context.get('workflow') == WORKFLOW
           and context.get('id') == expected['run_id']
           and context.get('attempt') == expected['attempt']
           and context.get('commit_sha') == expected['commit_sha'],
           'PUBLICATION_AUDIT_REPORT_CONTEXT_MISMATCH')
    artifacts = report.get('artifacts')
    reject(isinstance(artifacts, dict),
           'PUBLICATION_AUDIT_REPORT_ARTIFACTS_INVALID')
    pairs = (
        ('evidence', MAIN_ARTIFACT, expected['main_artifact_id'],
         expected['main_artifact_digest']),
        ('attestation', ATTESTATION_ARTIFACT, expected['attestation_artifact_id'],
         expected['attestation_artifact_digest']),
    )
    for key, name, artifact_id, digest in pairs:
        item = artifacts.get(key)
        reject(isinstance(item, dict)
               and item.get('name') == name
               and item.get('id') == artifact_id
               and normalize_digest(
                   item.get('digest_sha256'),
                   'PUBLICATION_AUDIT_REPORT_DIGEST_INVALID') == digest
               and item.get('expired') is False
               and type(item.get('size_in_bytes')) is int
               and item.get('size_in_bytes') > 0,
               'PUBLICATION_AUDIT_REPORT_ARTIFACT_MISMATCH')
    jobs = report.get('jobs')
    reject(isinstance(jobs, dict)
           and isinstance(jobs.get('producer'), dict)
           and jobs['producer'].get('name') == PRODUCER_JOB
           and jobs['producer'].get('status') == 'completed'
           and jobs['producer'].get('conclusion') == 'success'
           and isinstance(jobs.get('auditor'), dict)
           and jobs['auditor'].get('name') == AUDIT_JOB
           and jobs['auditor'].get('status') == 'in_progress',
           'PUBLICATION_AUDIT_REPORT_JOBS_INVALID')
    return True


def main():
    parser = argparse.ArgumentParser(
        description='Audit both final ROS GitHub Actions Artifacts after producer job')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--audit', action='store_true')
    mode.add_argument('--verify', action='store_true')
    parser.add_argument('--out', type=Path,
                        default=Path('.local/ros/publication-audit.json'))
    parser.add_argument('--report', type=Path)
    parser.add_argument('--run-id')
    parser.add_argument('--attempt', type=int)
    parser.add_argument('--commit-sha')
    parser.add_argument('--main-artifact-id')
    parser.add_argument('--main-artifact-digest')
    parser.add_argument('--attestation-artifact-id')
    parser.add_argument('--attestation-artifact-digest')
    args = parser.parse_args()
    try:
        if args.audit:
            report = create_audit(os.environ)
            atomic_write(args.out, report)
            print(
                'GITHUB_ROS_PUBLICATION_AUDIT_VERIFIED:'
                + report['artifacts']['evidence']['id'] + ':'
                + report['artifacts']['attestation']['id'])
        else:
            reject(args.report is not None,
                   'PUBLICATION_AUDIT_VERIFY_REPORT_REQUIRED')
            expected = expected_from_args(args)
            verify_report(read_json(args.report), expected)
            print('GitHub Actions dual ROS Artifact publication audit verified')
    except (OSError, ValueError, TypeError) as exc:
        code = str(exc)
        if not re.fullmatch(r'PUBLICATION_AUDIT_[A-Z0-9_]+', code):
            code = 'PUBLICATION_AUDIT_FAILED'
        print(code, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
