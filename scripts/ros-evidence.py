#!/usr/bin/env python3
"""Fail-closed startup evidence for ROS acceptance (never reports success).

The live ros_smoke.py is the ONLY component allowed to mark an acceptance as
'passed' after checking Nav2, robot motion and independently observed TF.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
from uuid import uuid4

STATUSES = {'blocked', 'running', 'failed'}


def write_status(path, status, reason, *, only_if=None):
    if status not in STATUSES:
        raise ValueError('Only actual ROS acceptance may write passed')
    dest = Path(path)
    prior = None
    try:
        prior = json.loads(dest.read_text(encoding='utf8'))
    except (FileNotFoundError, ValueError):
        pass
    if only_if is not None and (not isinstance(prior, dict) or prior.get('status') != only_if):
        return False
    # New preflight resets previous PASS data. Never copy old checks/legs.
    preserve_run = only_if is not None and isinstance(prior, dict)
    now = datetime.now(timezone.utc).isoformat()
    report = {
        'schema': 'alex.dev/ros-acceptance/v1',
        'status': status, 'simulation_only': True,
        'reason': reason, 'runtime_validation': 'NOT_PASSED',
        'checks': [], 'legs': [],
        'run_id': (prior.get('run_id') or str(uuid4())) if preserve_run else str(uuid4()),
        'created_at': prior.get('created_at') if preserve_run else now,
        'updated_at': now,
    }
    dest.parent.mkdir(parents=True, exist_ok=True)
    temp = dest.with_name(f'.{dest.name}.{os.getpid()}.tmp')
    try:
        temp.write_text(json.dumps(report, indent=2, sort_keys=True) + '\n', encoding='utf8')
        os.replace(temp, dest)
    finally:
        temp.unlink(missing_ok=True)
    return True


def main():
    parser = argparse.ArgumentParser(description='Write non-successful ROS acceptance evidence')
    parser.add_argument('--report', required=True)
    parser.add_argument('--status', choices=sorted(STATUSES), required=True)
    parser.add_argument('--reason', required=True)
    parser.add_argument('--if-status', choices=sorted(STATUSES | {'passed'}))
    args = parser.parse_args()
    changed = write_status(args.report, args.status, args.reason, only_if=args.if_status)
    print('ROS acceptance evidence:', 'updated' if changed else 'unchanged', args.status)


if __name__ == '__main__':
    main()
