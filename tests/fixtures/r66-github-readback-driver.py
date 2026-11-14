#!/usr/bin/env python3
"""R66 测试驱动：注入 GitHub REST JSON，实际调用生产 readback 校验函数。"""
import json
from pathlib import Path
from runpy import run_path
import sys

ROOT = Path(__file__).resolve().parents[2]
module = run_path(str(ROOT / 'scripts/github-actions-ros-readback.py'))
create_readback = module['create_readback']

scenario = sys.argv[1]
digest = 'a' * 64
run_id = '987654321'
commit = '0123456789abcdef0123456789abcdef01234567'
env = {
    'GITHUB_ACTIONS': 'true',
    'GITHUB_EVENT_NAME': 'workflow_dispatch',
    'GITHUB_REPOSITORY': 'jlongguo/alex',
    'GITHUB_JOB': 'nav2-simulation',
    'RUNNER_ENVIRONMENT': 'self-hosted',
    'GITHUB_WORKFLOW_REF':
        'jlongguo/alex/.github/workflows/ros-sim-acceptance.yml@refs/heads/main',
    'GITHUB_RUN_ID': run_id,
    'GITHUB_RUN_ATTEMPT': '2',
    'GITHUB_SHA': commit,
    'GITHUB_API_URL': 'https://api.github.com',
    'GITHUB_TOKEN': 'x' * 40,
    'ALEX_ROS_ARTIFACT_ID': '123456789',
    'ALEX_ROS_ARTIFACT_DIGEST': digest,
}
run = {
    'id': int(run_id),
    'run_attempt': 2,
    'head_sha': commit,
    'event': 'workflow_dispatch',
    'status': 'in_progress',
    'conclusion': None,
    'name': 'ROS Gazebo Nav2 Acceptance (manual)',
    'path': '.github/workflows/ros-sim-acceptance.yml',
    'head_branch': 'main',
    'repository': {'full_name': 'jlongguo/alex'},
}
artifact = {
    'id': 123456789,
    'name': 'alex-ros-gazebo-acceptance',
    'size_in_bytes': 4096,
    'expired': False,
    'digest': 'sha256:' + digest,
    'created_at': '2026-11-14T00:00:00Z',
    'updated_at': '2026-11-14T00:00:01Z',
    'workflow_run': {
        'id': int(run_id),
        'head_sha': commit,
        'head_branch': 'main',
    },
}
artifact_payloads = [{'artifacts': [artifact]}]

if scenario == 'wrong-run':
    run['id'] += 1
elif scenario == 'wrong-attempt':
    run['run_attempt'] = 3
elif scenario == 'wrong-sha':
    run['head_sha'] = 'f' * 40
elif scenario == 'wrong-event':
    run['event'] = 'pull_request'
elif scenario == 'wrong-workflow':
    run['path'] = '.github/workflows/ci.yml'
elif scenario == 'completed-failure':
    run['status'] = 'completed'
    run['conclusion'] = 'failure'
elif scenario == 'expired':
    artifact['expired'] = True
elif scenario == 'wrong-digest':
    artifact['digest'] = 'sha256:' + ('b' * 64)
elif scenario == 'wrong-artifact-run':
    artifact['workflow_run']['id'] += 1
elif scenario == 'duplicate':
    artifact_payloads = [{'artifacts': [artifact, dict(artifact, id=123456788)]}]
elif scenario == 'propagation-delay':
    artifact_payloads = [
        {'artifacts': []},
        {'artifacts': []},
        {'artifacts': [artifact]},
    ]
elif scenario == 'missing-token':
    env.pop('GITHUB_TOKEN')
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
    return run

try:
    result = create_readback(env, fetch_json=fetch, sleep_fn=lambda _seconds: None)
except Exception as exc:
    print(str(exc), file=sys.stderr)
    raise SystemExit(1)

result['_test_artifact_fetches'] = calls['artifacts']
print(json.dumps(result, sort_keys=True))
