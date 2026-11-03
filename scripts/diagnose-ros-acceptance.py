#!/usr/bin/env python3
"""Summarize failure evidence; never infer that navigation passed.

Runs after every acceptance attempt (even when ROS is absent). Does not issue
commands to ROS, Gazebo, or a physical robot. Includes only short log excerpts.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path

PATTERNS = (
    ('python_overlay', ('ModuleNotFoundError: No module named \'alex_sim\'', 'No module named alex_sim')),
    ('launch_configuration', ('NameError:', 'LaunchConfigurationError', 'NAV2_BRINGUP_LAUNCH_MISSING')),
    ('gazebo_rendering', ('EGL_NOT_INITIALIZED', 'EGL_BAD_DISPLAY', 'libEGL', 'Failed to create scene')),
    ('missing_ros_package', ('PackageNotFoundError', 'package not found', 'Missing ROS package')),
    ('map_localization', ('AMCL', 'initial pose', 'map->odom', 'MAP_TF')),
    ('sensor_bridge', ('/scan', 'LIDAR', 'laser', 'ros_gz_bridge')),
    ('collision_monitor_tf', ('base_footprint" passed to lookupTransform',
                              'Failed to get "lidar_link"->"base_footprint" frame transform')),
    ('collision_monitor_intervention', ('Robot to approach for', 'Robot to continue normal operation')),
    ('controller_rate_jitter', ('Control loop missed its desired rate',)),
    ('controller_progress', ('Failed to make progress',
                             'Timed out while waiting for action server to acknowledge goal')),
    ('nav2_action', ('NavigateToPose', 'NAV2_GOAL', 'planner_server', 'controller_server')),
)


def diagnose(report, preflight, log):
    try:
        state = json.loads(Path(report).read_text(encoding='utf8'))
    except (OSError, ValueError):
        state = {}
    try:
        check = json.loads(Path(preflight).read_text(encoding='utf8'))
    except (OSError, ValueError):
        check = {}
    try:
        # Cap input length to avoid massive artifacts or leaking large logs.
        lines = Path(log).read_text(encoding='utf8', errors='replace').splitlines()[-3000:]
    except OSError:
        lines = []
    detected = []
    for stage, terms in PATTERNS:
        matches = [line.strip()[:250] for line in lines if any(term.lower() in line.lower() for term in terms)]
        if matches:
            detected.append({'stage': stage, 'log_matches': matches[-3:]})
    return {
        'schema': 'alex.dev/ros-diagnostics/v1',
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'acceptance_status': state.get('status', 'unknown'),
        'acceptance_reason': state.get('reason', state.get('error', 'unavailable')),
        'run_id': state.get('run_id'),
        'preflight_status': check.get('status', 'not_run'),
        'preflight_blockers': check.get('blockers', []),
        'graph': state.get('graph', {}),
        'last_goal': state.get('last_goal', {}),
        'suspected_stages': detected,
        'runtime_validation': 'SEE_ACCEPTANCE_REPORT',
        'note': 'Diagnostic hints only. Real navigation success requires the validated three-leg report.',
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', required=True)
    parser.add_argument('--preflight', required=True)
    parser.add_argument('--log', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    data = diagnose(args.report, args.preflight, args.log)
    path = Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf8')
    print('ROS diagnostic evidence:', path, '; status:', data['acceptance_status'])


if __name__ == '__main__':
    main()
