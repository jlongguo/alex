#!/usr/bin/env python3
"""R69：Full Voice Turn producer 结束后，由独立 GitHub-hosted Job 审计两个最终 Artifact。"""
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

SCHEMA = 'alex.dev/github-actions-full-voice-turn-publication-audit/v1'
SOURCE = 'github-rest-api-actions-read'
REPO = 'jlongguo/alex'
WORKFLOW = '.github/workflows/full-voice-turn-acceptance.yml'
WORKFLOW_NAME = 'Full Voice Turn Physical E2E (manual)'
PRODUCER_JOB = 'full-voice-turn'
AUDIT_JOB = 'publication-audit'
MAIN_ARTIFACT = 'alex-full-voice-turn-physical-e2e'
ATTESTATION_ARTIFACT = 'alex-full-voice-turn-physical-e2e-attestation'
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
            'User-Agent': 'alex-full-voice-turn-publication-audit',
        },
        method='GET',
    )
    try:
        with urlopen(request, timeout=12) as response:
            reject(response.status == 200,
                   'FULL_VOICE_TURN_PUBLICATION_API_STATUS_INVALID')
            raw = response.read(2 * 1024 * 1024 + 1)
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        raise ValueError('FULL_VOICE_TURN_PUBLICATION_API_REQUEST_FAILED') from exc
    reject(len(raw) <= 2 * 1024 * 1024,
           'FULL_VOICE_TURN_PUBLICATION_API_RESPONSE_TOO_LARGE')
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError) as exc:
        raise ValueError('FULL_VOICE_TURN_PUBLICATION_API_JSON_INVALID') from exc
    reject(isinstance(value, dict), 'FULL_VOICE_TURN_PUBLICATION_API_OBJECT_REQUIRED')
    return value


def environment_context(env):
    reject(env.get('GITHUB_ACTIONS') == 'true'
           and env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
           and env.get('GITHUB_REPOSITORY') == REPO
           and env.get('GITHUB_JOB') == AUDIT_JOB
           and env.get('RUNNER_ENVIRONMENT') == 'github-hosted',
           'FULL_VOICE_TURN_PUBLICATION_UNAPPROVED_CONTEXT')
    reject(env.get('GITHUB_API_URL') in (None, '', API_BASE),
           'FULL_VOICE_TURN_PUBLICATION_API_BASE_INVALID')
    workflow_ref = env.get('GITHUB_WORKFLOW_REF')
    reject(isinstance(workflow_ref, str) and WORKFLOW_REF.fullmatch(workflow_ref),
           'FULL_VOICE_TURN_PUBLICATION_WORKFLOW_REF_INVALID')
    run_id = env.get('GITHUB_RUN_ID')
    attempt = env.get('GITHUB_RUN_ATTEMPT')
    commit = env.get('GITHUB_SHA')
    main_id = env.get('ALEX_FULL_VOICE_TURN_ARTIFACT_ID')
    attest_id = env.get('ALEX_FULL_VOICE_TURN_ATTESTATION_ARTIFACT_ID')
    main_digest = normalize_digest(
        env.get('ALEX_FULL_VOICE_TURN_ARTIFACT_DIGEST'),
        'FULL_VOICE_TURN_PUBLICATION_MAIN_DIGEST_INVALID')
    attest_digest = normalize_digest(
        env.get('ALEX_FULL_VOICE_TURN_ATTESTATION_ARTIFACT_DIGEST'),
        'FULL_VOICE_TURN_PUBLICATION_ATTESTATION_DIGEST_INVALID')
    token = env.get('GITHUB_TOKEN')
    reject(isinstance(run_id, str) and DIGITS.fullmatch(run_id),
           'FULL_VOICE_TURN_PUBLICATION_RUN_ID_INVALID')
    reject(isinstance(attempt, str) and attempt.isascii() and attempt.isdigit()
           and 1 <= int(attempt) <= 10000,
           'FULL_VOICE_TURN_PUBLICATION_ATTEMPT_INVALID')
    reject(isinstance(commit, str) and SHA40.fullmatch(commit),
           'FULL_VOICE_TURN_PUBLICATION_COMMIT_INVALID')
    reject(isinstance(main_id, str) and DIGITS.fullmatch(main_id),
           'FULL_VOICE_TURN_PUBLICATION_MAIN_ID_INVALID')
    reject(isinstance(attest_id, str) and DIGITS.fullmatch(attest_id),
           'FULL_VOICE_TURN_PUBLICATION_ATTESTATION_ID_INVALID')
    reject(main_id != attest_id, 'FULL_VOICE_TURN_PUBLICATION_ARTIFACT_IDS_REUSED')
    reject(isinstance(token, str) and 20 <= len(token) <= 8192,
           'FULL_VOICE_TURN_PUBLICATION_TOKEN_MISSING')
    return {
        'workflow_ref': workflow_ref,
        'run_id': run_id,
        'attempt': int(attempt),
        'commit_sha': commit,
        'main_artifact_id': main_id,
        'main_artifact_digest': main_digest,
        'attestation_artifact_id': attest_id,
        'attestation_artifact_digest': attest_digest,
    }, token


def validate_run(run, expected):
    repository = run.get('repository')
    expected_branch = expected['workflow_ref'].split('@refs/heads/', 1)[1]
    reject(isinstance(repository, dict)
           and repository.get('full_name') == REPO,
           'FULL_VOICE_TURN_PUBLICATION_REPOSITORY_MISMATCH')
    reject(run.get('id') == int(expected['run_id'])
           and run.get('run_attempt') == expected['attempt']
           and run.get('head_sha') == expected['commit_sha'],
           'FULL_VOICE_TURN_PUBLICATION_RUN_CONTEXT_MISMATCH')
    reject(run.get('event') == 'workflow_dispatch'
           and run.get('name') == WORKFLOW_NAME
           and run.get('path') == WORKFLOW
           and run.get('head_branch') == expected_branch,
           'FULL_VOICE_TURN_PUBLICATION_WORKFLOW_MISMATCH')
    reject(run.get('status') == 'in_progress'
           and run.get('conclusion') is None,
           'FULL_VOICE_TURN_PUBLICATION_RUN_NOT_IN_PROGRESS')
    return {
        'repository': REPO,
        'workflow': WORKFLOW,
        'workflow_ref': expected['workflow_ref'],
        'id': expected['run_id'],
        'attempt': expected['attempt'],
        'commit_sha': expected['commit_sha'],
        'head_branch': expected_branch,
        'status_at_audit': 'in_progress',
        'conclusion_at_audit': None,
    }


def artifact_by_id(payload, artifact_id):
    items = payload.get('artifacts')
    reject(isinstance(items, list), 'FULL_VOICE_TURN_PUBLICATION_ARTIFACTS_INVALID')
    matches = [
        item for item in items
        if isinstance(item, dict) and item.get('id') == int(artifact_id)
    ]
    reject(len(matches) > 0, 'FULL_VOICE_TURN_PUBLICATION_ARTIFACT_MISSING')
    reject(len(matches) == 1,
           'FULL_VOICE_TURN_PUBLICATION_ARTIFACT_ID_NOT_UNIQUE')
    return matches[0]


def validate_artifact(item, *, name, artifact_id, digest, expected):
    reject(item.get('name') == name,
           'FULL_VOICE_TURN_PUBLICATION_ARTIFACT_NAME_MISMATCH')
    actual_digest = normalize_digest(
        item.get('digest'), 'FULL_VOICE_TURN_PUBLICATION_API_DIGEST_INVALID')
    reject(actual_digest == digest,
           'FULL_VOICE_TURN_PUBLICATION_ARTIFACT_DIGEST_MISMATCH')
    reject(item.get('expired') is False,
           'FULL_VOICE_TURN_PUBLICATION_ARTIFACT_EXPIRED')
    size = item.get('size_in_bytes')
    reject(type(size) is int and size > 0,
           'FULL_VOICE_TURN_PUBLICATION_ARTIFACT_SIZE_INVALID')
    workflow_run = item.get('workflow_run')
    reject(isinstance(workflow_run, dict)
           and workflow_run.get('id') == int(expected['run_id'])
           and workflow_run.get('head_sha') == expected['commit_sha'],
           'FULL_VOICE_TURN_PUBLICATION_ARTIFACT_RUN_MISMATCH')
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
    reject(isinstance(jobs, list), 'FULL_VOICE_TURN_PUBLICATION_JOBS_INVALID')
    producer = [
        item for item in jobs
        if isinstance(item, dict) and item.get('name') == PRODUCER_JOB
    ]
    auditor = [
        item for item in jobs
        if isinstance(item, dict) and item.get('name') == AUDIT_JOB
    ]
    reject(len(producer) > 0 and len(auditor) > 0,
           'FULL_VOICE_TURN_PUBLICATION_JOBS_MISSING')
    reject(len(producer) == 1 and len(auditor) == 1,
           'FULL_VOICE_TURN_PUBLICATION_JOBS_NOT_UNIQUE')
    producer = producer[0]
    auditor = auditor[0]

    reject(producer.get('run_id') == int(expected['run_id'])
           and producer.get('run_attempt') == expected['attempt']
           and producer.get('head_sha') == expected['commit_sha']
           and producer.get('status') == 'completed'
           and producer.get('conclusion') == 'success',
           'FULL_VOICE_TURN_PUBLICATION_PRODUCER_NOT_SUCCESSFUL')
    producer_labels = producer.get('labels')
    reject(isinstance(producer_labels, list)
           and all(label in producer_labels for label in ('self-hosted','linux','x64','alex-full_voice_turn')),
           'FULL_VOICE_TURN_PUBLICATION_PRODUCER_LABELS_MISMATCH')
    reject(isinstance(producer.get('runner_name'), str)
           and producer.get('runner_name').strip() != '',
           'FULL_VOICE_TURN_PUBLICATION_PRODUCER_RUNNER_NAME_MISSING')

    reject(auditor.get('run_id') == int(expected['run_id'])
           and auditor.get('run_attempt') == expected['attempt']
           and auditor.get('head_sha') == expected['commit_sha']
           and auditor.get('status') == 'in_progress'
           and auditor.get('conclusion') is None,
           'FULL_VOICE_TURN_PUBLICATION_AUDITOR_JOB_INVALID')
    audit_labels = auditor.get('labels')
    reject(isinstance(audit_labels, list)
           and 'ubuntu-latest' in audit_labels,
           'FULL_VOICE_TURN_PUBLICATION_AUDITOR_LABELS_MISMATCH')
    producer_completed = producer.get('completed_at')
    audit_started = auditor.get('started_at')
    reject(isinstance(producer_completed, str)
           and isinstance(audit_started, str)
           and producer_completed <= audit_started,
           'FULL_VOICE_TURN_PUBLICATION_JOB_ORDER_INVALID')
    return {
        'producer': {
            'id': producer.get('id'),
            'name': PRODUCER_JOB,
            'status': 'completed',
            'conclusion': 'success',
            'runner_name': producer.get('runner_name'),
            'runner_group_name': producer.get('runner_group_name'),
            'labels': sorted(producer_labels),
            'completed_at': producer_completed,
        },
        'auditor': {
            'id': auditor.get('id'),
            'name': AUDIT_JOB,
            'status': 'in_progress',
            'runner_name': auditor.get('runner_name'),
            'runner_group_name': auditor.get('runner_group_name'),
            'labels': sorted(audit_labels),
            'started_at': audit_started,
        },
    }


def create_audit(env, fetch_json=github_get_json, sleep_fn=sleep):
    expected, token = environment_context(env)
    base = f'{API_BASE}/repos/{REPO}/actions/runs/{expected["run_id"]}'
    run_record = validate_run(fetch_json(base, token), expected)
    main = attestation = jobs_record = None
    transient = {
        'FULL_VOICE_TURN_PUBLICATION_ARTIFACT_MISSING',
        'FULL_VOICE_TURN_PUBLICATION_API_DIGEST_INVALID',
        'FULL_VOICE_TURN_PUBLICATION_JOBS_MISSING',
        'FULL_VOICE_TURN_PUBLICATION_AUDITOR_JOB_INVALID',
    }
    for attempt_index in range(4):
        try:
            artifacts = fetch_json(
                base + '/artifacts?per_page=100', token)
            jobs = fetch_json(
                base + '/jobs?filter=latest&per_page=100', token)
            main = validate_artifact(
                artifact_by_id(artifacts, expected['main_artifact_id']),
                name=MAIN_ARTIFACT,
                artifact_id=expected['main_artifact_id'],
                digest=expected['main_artifact_digest'],
                expected=expected)
            attestation = validate_artifact(
                artifact_by_id(
                    artifacts, expected['attestation_artifact_id']),
                name=ATTESTATION_ARTIFACT,
                artifact_id=expected['attestation_artifact_id'],
                digest=expected['attestation_artifact_digest'],
                expected=expected)
            jobs_record = validate_jobs(jobs, expected)
            break
        except ValueError as exc:
            if str(exc) not in transient or attempt_index == 3:
                raise
            sleep_fn(2)
    reject(main is not None and attestation is not None
           and jobs_record is not None,
           'FULL_VOICE_TURN_PUBLICATION_PROPAGATION_TIMEOUT')
    reject(main['id'] != attestation['id'],
           'FULL_VOICE_TURN_PUBLICATION_ARTIFACT_IDS_REUSED')
    if isinstance(main.get('created_at'), str) and isinstance(
            attestation.get('created_at'), str):
        reject(main['created_at'] <= attestation['created_at'],
               'FULL_VOICE_TURN_PUBLICATION_ARTIFACT_ORDER_INVALID')
    return {
        'schema': SCHEMA,
        'status': 'verified',
        'source': SOURCE,
        'read_only': True,
        'audit_runner': 'github-hosted',
        'closure_strategy':
            'post-producer-dual-artifact-rest-readback-no-third-artifact',
        'release_approved': False,
        'physical_safety_certified': False,
        'context': run_record,
        'jobs': jobs_record,
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
           'FULL_VOICE_TURN_PUBLICATION_EXPECTED_RUN_INVALID')
    reject(type(args.attempt) is int and 1 <= args.attempt <= 10000,
           'FULL_VOICE_TURN_PUBLICATION_EXPECTED_ATTEMPT_INVALID')
    reject(isinstance(args.commit_sha, str) and SHA40.fullmatch(args.commit_sha),
           'FULL_VOICE_TURN_PUBLICATION_EXPECTED_COMMIT_INVALID')
    for value, code in (
        (args.main_artifact_id, 'FULL_VOICE_TURN_PUBLICATION_EXPECTED_MAIN_ID_INVALID'),
        (args.attestation_artifact_id,
         'FULL_VOICE_TURN_PUBLICATION_EXPECTED_ATTESTATION_ID_INVALID'),
    ):
        reject(isinstance(value, str) and DIGITS.fullmatch(value), code)
    reject(args.main_artifact_id != args.attestation_artifact_id,
           'FULL_VOICE_TURN_PUBLICATION_ARTIFACT_IDS_REUSED')
    return {
        'run_id': args.run_id,
        'attempt': args.attempt,
        'commit_sha': args.commit_sha,
        'main_artifact_id': args.main_artifact_id,
        'main_artifact_digest': normalize_digest(
            args.main_artifact_digest,
            'FULL_VOICE_TURN_PUBLICATION_EXPECTED_MAIN_DIGEST_INVALID'),
        'attestation_artifact_id': args.attestation_artifact_id,
        'attestation_artifact_digest': normalize_digest(
            args.attestation_artifact_digest,
            'FULL_VOICE_TURN_PUBLICATION_EXPECTED_ATTESTATION_DIGEST_INVALID'),
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
           'FULL_VOICE_TURN_PUBLICATION_REPORT_INVALID')
    reject(report.get('release_approved') is False
           and report.get('physical_safety_certified') is False,
           'FULL_VOICE_TURN_PUBLICATION_OVERCLAIMED')
    context = report.get('context')
    reject(isinstance(context, dict)
           and context.get('repository') == REPO
           and context.get('workflow') == WORKFLOW
           and isinstance(context.get('workflow_ref'), str)
           and WORKFLOW_REF.fullmatch(context['workflow_ref'])
           and context.get('id') == expected['run_id']
           and context.get('attempt') == expected['attempt']
           and context.get('commit_sha') == expected['commit_sha']
           and context.get('status_at_audit') == 'in_progress'
           and context.get('conclusion_at_audit') is None,
           'FULL_VOICE_TURN_PUBLICATION_REPORT_CONTEXT_MISMATCH')
    artifacts = report.get('artifacts')
    reject(isinstance(artifacts, dict),
           'FULL_VOICE_TURN_PUBLICATION_REPORT_ARTIFACTS_INVALID')
    for key, name, artifact_id, digest in (
        ('evidence', MAIN_ARTIFACT, expected['main_artifact_id'],
         expected['main_artifact_digest']),
        ('attestation', ATTESTATION_ARTIFACT,
         expected['attestation_artifact_id'],
         expected['attestation_artifact_digest']),
    ):
        item = artifacts.get(key)
        reject(isinstance(item, dict)
               and item.get('name') == name
               and item.get('id') == artifact_id
               and normalize_digest(
                   item.get('digest_sha256'),
                   'FULL_VOICE_TURN_PUBLICATION_REPORT_DIGEST_INVALID') == digest
               and normalize_digest(
                   item.get('api_digest'),
                   'FULL_VOICE_TURN_PUBLICATION_REPORT_API_DIGEST_INVALID') == digest
               and item.get('expired') is False
               and type(item.get('size_in_bytes')) is int
               and item.get('size_in_bytes') > 0,
               'FULL_VOICE_TURN_PUBLICATION_REPORT_ARTIFACT_MISMATCH')
    jobs = report.get('jobs')
    producer = jobs.get('producer') if isinstance(jobs, dict) else None
    auditor = jobs.get('auditor') if isinstance(jobs, dict) else None
    reject(isinstance(producer, dict)
           and producer.get('name') == PRODUCER_JOB
           and producer.get('status') == 'completed'
           and producer.get('conclusion') == 'success'
           and isinstance(producer.get('runner_name'), str)
           and producer.get('runner_name').strip() != ''
           and isinstance(producer.get('labels'), list)
           and all(label in producer['labels'] for label in ('self-hosted','linux','x64','alex-full_voice_turn'))
           and isinstance(auditor, dict)
           and auditor.get('name') == AUDIT_JOB
           and auditor.get('status') == 'in_progress'
           and isinstance(auditor.get('labels'), list)
           and 'ubuntu-latest' in auditor['labels'],
           'FULL_VOICE_TURN_PUBLICATION_REPORT_JOBS_INVALID')
    return True


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = None
    try:
        with NamedTemporaryFile(
            mode='w', encoding='utf8', dir=path.parent,
            prefix='.full_voice_turn-publication-audit-', suffix='.tmp', delete=False
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
           'FULL_VOICE_TURN_PUBLICATION_REPORT_FILE_INVALID')
    reject(2 <= path.stat().st_size <= 128 * 1024,
           'FULL_VOICE_TURN_PUBLICATION_REPORT_FILE_INVALID')
    try:
        value = json.loads(path.read_text(encoding='utf8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError('FULL_VOICE_TURN_PUBLICATION_REPORT_JSON_INVALID') from exc
    reject(isinstance(value, dict), 'FULL_VOICE_TURN_PUBLICATION_REPORT_OBJECT_REQUIRED')
    return value


def main():
    parser = argparse.ArgumentParser(description='Audit final Full Voice Turn GitHub Actions Artifacts')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--audit', action='store_true')
    mode.add_argument('--verify', action='store_true')
    parser.add_argument('--out', type=Path,
                        default=Path('.local/voice/full-turn/publication-audit.json'))
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
            print('GITHUB_FULL_VOICE_TURN_PUBLICATION_AUDIT_VERIFIED:'
                  + report['artifacts']['evidence']['id'] + ':'
                  + report['artifacts']['attestation']['id'])
        else:
            reject(args.report is not None,
                   'FULL_VOICE_TURN_PUBLICATION_VERIFY_REPORT_REQUIRED')
            expected = expected_from_args(args)
            verify_report(read_json(args.report), expected)
            print('GitHub Actions dual Full Voice Turn Artifact publication audit verified')
    except (OSError, ValueError, TypeError) as exc:
        code = str(exc)
        if not re.fullmatch(r'FULL_VOICE_TURN_PUBLICATION_[A-Z0-9_]+', code):
            code = 'FULL_VOICE_TURN_PUBLICATION_FAILED'
        print(code, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
