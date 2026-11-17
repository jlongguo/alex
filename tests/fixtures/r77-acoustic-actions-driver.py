#!/usr/bin/env python3
"""R69 测试驱动：向 Acoustic GitHub Actions readback/publication audit 注入 REST 数据。"""
import json
from pathlib import Path
from runpy import run_path
import sys

ROOT = Path(__file__).resolve().parents[2]
readback_module = run_path(str(ROOT / 'scripts/github-actions-acoustic-readback.py'))
publication_module = run_path(str(ROOT / 'scripts/github-actions-acoustic-publication-audit.py'))

kind = sys.argv[1]
scenario = sys.argv[2]
run_id = '876543210'
attempt = 2
commit = '0123456789abcdef0123456789abcdef01234567'
main_digest = 'a' * 64
attest_digest = 'b' * 64

run_payload = {
    'id': int(run_id),
    'run_attempt': attempt,
    'head_sha': commit,
    'event': 'workflow_dispatch',
    'status': 'in_progress',
    'conclusion': None,
    'name': 'Real Acoustic I/O Acceptance (manual)',
    'path': '.github/workflows/acoustic-io-acceptance.yml',
    'head_branch': 'main',
    'repository': {'full_name': 'jlongguo/alex'},
}
main_artifact = {
    'id': 111111111,
    'name': 'alex-real-acoustic-io-evidence',
    'size_in_bytes': 4096,
    'expired': False,
    'digest': 'sha256:' + main_digest,
    'created_at': '2026-11-15T10:00:00Z',
    'updated_at': '2026-11-15T10:00:01Z',
    'workflow_run': {
        'id': int(run_id), 'head_sha': commit, 'head_branch': 'main'
    },
}
attest_artifact = {
    'id': 222222222,
    'name': 'alex-real-acoustic-io-attestation',
    'size_in_bytes': 2048,
    'expired': False,
    'digest': 'sha256:' + attest_digest,
    'created_at': '2026-11-15T10:00:02Z',
    'updated_at': '2026-11-15T10:00:03Z',
    'workflow_run': {
        'id': int(run_id), 'head_sha': commit, 'head_branch': 'main'
    },
}
producer = {
    'id': 7001,
    'name': 'acoustic-io',
    'run_id': int(run_id),
    'run_attempt': attempt,
    'head_sha': commit,
    'status': 'completed',
    'conclusion': 'success',
    'runner_name': 'alex-acoustic-lab-01',
    'runner_group_name': 'Default',
    'labels': ['self-hosted','linux','x64','alex-acoustic'],
    'started_at': '2026-11-15T09:50:00Z',
    'completed_at': '2026-11-15T10:00:04Z',
}
auditor = {
    'id': 7002,
    'name': 'publication-audit',
    'run_id': int(run_id),
    'run_attempt': attempt,
    'head_sha': commit,
    'status': 'in_progress',
    'conclusion': None,
    'runner_name': 'GitHub Actions 2001',
    'runner_group_name': 'GitHub Actions',
    'labels': ['ubuntu-latest'],
    'started_at': '2026-11-15T10:00:05Z',
    'completed_at': None,
}

if kind == 'readback':
    env = {
        'GITHUB_ACTIONS': 'true',
        'GITHUB_EVENT_NAME': 'workflow_dispatch',
        'GITHUB_REPOSITORY': 'jlongguo/alex',
        'GITHUB_JOB': 'acoustic-io',
        'RUNNER_ENVIRONMENT': 'self-hosted',
        'GITHUB_WORKFLOW_REF':
            'jlongguo/alex/.github/workflows/acoustic-io-acceptance.yml@refs/heads/main',
        'GITHUB_RUN_ID': run_id,
        'GITHUB_RUN_ATTEMPT': str(attempt),
        'GITHUB_SHA': commit,
        'GITHUB_API_URL': 'https://api.github.com',
        'GITHUB_TOKEN': 'x' * 40,
        'ALEX_ACOUSTIC_ARTIFACT_ID': '111111111',
        'ALEX_ACOUSTIC_ARTIFACT_DIGEST': main_digest,
    }
    artifact_payloads = [{'artifacts': [main_artifact]}]
    if scenario == 'wrong-digest':
        main_artifact['digest'] = 'sha256:' + ('c' * 64)
    elif scenario == 'expired':
        main_artifact['expired'] = True
    elif scenario == 'wrong-run':
        main_artifact['workflow_run']['id'] += 1
    elif scenario == 'historical-same-name':
        old = dict(main_artifact)
        old['id'] = 999999999
        artifact_payloads = [{'artifacts': [old, main_artifact]}]
    elif scenario == 'propagation-delay':
        artifact_payloads = [{'artifacts': []}, {'artifacts': [main_artifact]}]
    elif scenario == 'wrong-context':
        env['GITHUB_JOB'] = 'other-job'
    elif scenario != 'success':
        print('UNKNOWN_SCENARIO', file=sys.stderr)
        raise SystemExit(64)

    calls = {'artifacts': 0}

    def fetch(url, _token):
        if url.endswith('/artifacts?per_page=100'):
            index = min(calls['artifacts'], len(artifact_payloads) - 1)
            calls['artifacts'] += 1
            return artifact_payloads[index]
        return run_payload

    try:
        result = readback_module['create_audit'](
            env, fetch_json=fetch, sleep_fn=lambda _seconds: None)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
    result['_test_artifact_fetches'] = calls['artifacts']
    print(json.dumps(result, sort_keys=True))
    raise SystemExit(0)

if kind == 'publication':
    env = {
        'GITHUB_ACTIONS': 'true',
        'GITHUB_EVENT_NAME': 'workflow_dispatch',
        'GITHUB_REPOSITORY': 'jlongguo/alex',
        'GITHUB_JOB': 'publication-audit',
        'RUNNER_ENVIRONMENT': 'github-hosted',
        'GITHUB_WORKFLOW_REF':
            'jlongguo/alex/.github/workflows/acoustic-io-acceptance.yml@refs/heads/main',
        'GITHUB_RUN_ID': run_id,
        'GITHUB_RUN_ATTEMPT': str(attempt),
        'GITHUB_SHA': commit,
        'GITHUB_API_URL': 'https://api.github.com',
        'GITHUB_TOKEN': 'x' * 40,
        'ALEX_ACOUSTIC_ARTIFACT_ID': '111111111',
        'ALEX_ACOUSTIC_ARTIFACT_DIGEST': main_digest,
        'ALEX_ACOUSTIC_ATTESTATION_ARTIFACT_ID': '222222222',
        'ALEX_ACOUSTIC_ATTESTATION_ARTIFACT_DIGEST': attest_digest,
    }
    artifact_payloads = [{'artifacts': [main_artifact, attest_artifact]}]
    job_payloads = [{'jobs': [producer, auditor]}]
    if scenario == 'wrong-attest-digest':
        attest_artifact['digest'] = 'sha256:' + ('c' * 64)
    elif scenario == 'producer-failed':
        producer['conclusion'] = 'failure'
    elif scenario == 'producer-labels':
        producer['labels'] = ['self-hosted','linux','x64']
    elif scenario == 'auditor-labels':
        auditor['labels'] = ['ubuntu-24.04']
    elif scenario == 'job-order':
        auditor['started_at'] = '2026-11-15T10:00:03Z'
    elif scenario == 'historical-same-name':
        old = dict(attest_artifact)
        old['id'] = 999999999
        artifact_payloads = [{
            'artifacts': [main_artifact, old, attest_artifact]
        }]
    elif scenario == 'propagation-delay':
        artifact_payloads = [
            {'artifacts': [main_artifact]},
            {'artifacts': [main_artifact, attest_artifact]},
        ]
    elif scenario == 'jobs-delay':
        job_payloads = [
            {'jobs': [producer]},
            {'jobs': [producer, auditor]},
        ]
    elif scenario == 'same-ids':
        env['ALEX_ACOUSTIC_ATTESTATION_ARTIFACT_ID'] = '111111111'
    elif scenario == 'wrong-context':
        env['RUNNER_ENVIRONMENT'] = 'self-hosted-bad'
    elif scenario != 'success':
        print('UNKNOWN_SCENARIO', file=sys.stderr)
        raise SystemExit(64)

    calls = {'artifacts': 0, 'jobs': 0}

    def fetch(url, _token):
        if url.endswith('/artifacts?per_page=100'):
            index = min(calls['artifacts'], len(artifact_payloads) - 1)
            calls['artifacts'] += 1
            return artifact_payloads[index]
        if url.endswith('/jobs?filter=latest&per_page=100'):
            index = min(calls['jobs'], len(job_payloads) - 1)
            calls['jobs'] += 1
            return job_payloads[index]
        return run_payload

    try:
        result = publication_module['create_audit'](
            env, fetch_json=fetch, sleep_fn=lambda _seconds: None)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
    result['_test_artifact_fetches'] = calls['artifacts']
    result['_test_job_fetches'] = calls['jobs']
    print(json.dumps(result, sort_keys=True))
    raise SystemExit(0)

print('UNKNOWN_KIND', file=sys.stderr)
raise SystemExit(64)
