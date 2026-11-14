#!/usr/bin/env python3
"""R67 测试驱动：向生产 publication audit 注入 GitHub REST 数据。"""
import json
from pathlib import Path
from runpy import run_path
import sys

ROOT = Path(__file__).resolve().parents[2]
module = run_path(str(ROOT / 'scripts/github-actions-ros-publication-audit.py'))
create_audit = module['create_audit']

scenario = sys.argv[1]
main_digest = 'a' * 64
attest_digest = 'b' * 64
run_id = '987654321'
commit = '0123456789abcdef0123456789abcdef01234567'
env = {
    'GITHUB_ACTIONS': 'true',
    'GITHUB_EVENT_NAME': 'workflow_dispatch',
    'GITHUB_REPOSITORY': 'jlongguo/alex',
    'GITHUB_JOB': 'publication-audit',
    'RUNNER_ENVIRONMENT': 'github-hosted',
    'GITHUB_WORKFLOW_REF':
        'jlongguo/alex/.github/workflows/ros-sim-acceptance.yml@refs/heads/main',
    'GITHUB_RUN_ID': run_id,
    'GITHUB_RUN_ATTEMPT': '3',
    'GITHUB_SHA': commit,
    'GITHUB_API_URL': 'https://api.github.com',
    'GITHUB_TOKEN': 'x' * 40,
    'ALEX_ROS_ARTIFACT_ID': '111111111',
    'ALEX_ROS_ARTIFACT_DIGEST': main_digest,
    'ALEX_ROS_ATTESTATION_ARTIFACT_ID': '222222222',
    'ALEX_ROS_ATTESTATION_ARTIFACT_DIGEST': attest_digest,
}
run = {
    'id': int(run_id),
    'run_attempt': 3,
    'head_sha': commit,
    'event': 'workflow_dispatch',
    'status': 'in_progress',
    'conclusion': None,
    'name': 'ROS Gazebo Nav2 Acceptance (manual)',
    'path': '.github/workflows/ros-sim-acceptance.yml',
    'head_branch': 'main',
    'repository': {'full_name': 'jlongguo/alex'},
}
main_artifact = {
    'id': 111111111,
    'name': 'alex-ros-gazebo-acceptance',
    'size_in_bytes': 8192,
    'expired': False,
    'digest': 'sha256:' + main_digest,
    'created_at': '2026-11-14T10:00:00Z',
    'updated_at': '2026-11-14T10:00:01Z',
    'workflow_run': {'id': int(run_id), 'head_sha': commit, 'head_branch': 'main'},
}
attest_artifact = {
    'id': 222222222,
    'name': 'alex-ros-gazebo-attestation',
    'size_in_bytes': 2048,
    'expired': False,
    'digest': 'sha256:' + attest_digest,
    'created_at': '2026-11-14T10:00:02Z',
    'updated_at': '2026-11-14T10:00:03Z',
    'workflow_run': {'id': int(run_id), 'head_sha': commit, 'head_branch': 'main'},
}
producer = {
    'id': 9001,
    'name': 'nav2-simulation',
    'run_id': int(run_id),
    'run_attempt': 3,
    'head_sha': commit,
    'status': 'completed',
    'conclusion': 'success',
    'runner_name': 'alex-ros-runner-01',
    'runner_group_name': 'Default',
    'labels': ['self-hosted', 'linux', 'x64', 'alex-ros-sim'],
    'started_at': '2026-11-14T09:00:00Z',
    'completed_at': '2026-11-14T10:00:04Z',
}
auditor = {
    'id': 9002,
    'name': 'publication-audit',
    'run_id': int(run_id),
    'run_attempt': 3,
    'head_sha': commit,
    'status': 'in_progress',
    'conclusion': None,
    'runner_name': 'GitHub Actions 1000',
    'runner_group_name': 'GitHub Actions',
    'labels': ['ubuntu-latest'],
    'started_at': '2026-11-14T10:00:05Z',
    'completed_at': None,
}

artifact_payloads = [{'artifacts': [main_artifact, attest_artifact]}]
job_payloads = [{'jobs': [producer, auditor]}]

if scenario == 'wrong-main-digest':
    main_artifact['digest'] = 'sha256:' + ('c' * 64)
elif scenario == 'wrong-attest-digest':
    attest_artifact['digest'] = 'sha256:' + ('c' * 64)
elif scenario == 'expired-attestation':
    attest_artifact['expired'] = True
elif scenario == 'wrong-attestation-run':
    attest_artifact['workflow_run']['id'] += 1
elif scenario == 'historical-attestation':
    duplicate = dict(attest_artifact)
    duplicate['id'] = 333333333
    artifact_payloads = [{'artifacts': [main_artifact, attest_artifact, duplicate]}]
elif scenario == 'duplicate-attestation-id':
    artifact_payloads = [{'artifacts': [main_artifact, attest_artifact, dict(attest_artifact)]}]
elif scenario == 'producer-failed':
    producer['conclusion'] = 'failure'
elif scenario == 'producer-labels':
    producer['labels'] = ['self-hosted', 'linux', 'x64']
elif scenario == 'producer-runner-name':
    producer['runner_name'] = ''
elif scenario == 'auditor-status':
    auditor['status'] = 'queued'
elif scenario == 'auditor-label':
    auditor['labels'] = ['ubuntu-24.04']
elif scenario == 'job-order':
    auditor['started_at'] = '2026-11-14T09:59:59Z'
elif scenario == 'wrong-attempt':
    producer['run_attempt'] = 2
elif scenario == 'same-artifact-ids':
    env['ALEX_ROS_ATTESTATION_ARTIFACT_ID'] = env['ALEX_ROS_ARTIFACT_ID']
elif scenario == 'wrong-context':
    env['RUNNER_ENVIRONMENT'] = 'self-hosted'
elif scenario == 'artifact-propagation':
    artifact_payloads = [
        {'artifacts': [main_artifact]},
        {'artifacts': [main_artifact, attest_artifact]},
    ]
elif scenario == 'jobs-propagation':
    job_payloads = [
        {'jobs': [producer]},
        {'jobs': [producer, auditor]},
    ]
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
    return run

try:
    result = create_audit(env, fetch_json=fetch, sleep_fn=lambda _seconds: None)
except Exception as exc:
    print(str(exc), file=sys.stderr)
    raise SystemExit(1)

result['_test_artifact_fetches'] = calls['artifacts']
result['_test_job_fetches'] = calls['jobs']
print(json.dumps(result, sort_keys=True))
