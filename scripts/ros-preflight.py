#!/usr/bin/env python3
"""Read-only ROS simulation preflight. Never calls Nav2 actions or motors."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess


def probe():
    required = ('ros2', 'gz', 'colcon', 'python3', 'setsid')
    tools = {name: shutil.which(name) is not None for name in required}
    flags = {
        'ros_distro_jazzy': os.environ.get('ROS_DISTRO') == 'jazzy',
        'simulation_only': os.environ.get('ALEX_ROS_SIMULATION_ONLY') == '1',
        'integration_opt_in': os.environ.get('ALEX_RUN_ROS_INTEGRATION') == '1',
        'isolated_domain': os.environ.get('ROS_DOMAIN_ID') == '77',
        'local_discovery': os.environ.get('ROS_AUTOMATIC_DISCOVERY_RANGE') == 'LOCALHOST',
    }
    packages = {}
    if tools['ros2']:
        for name in ('ros_gz_sim', 'ros_gz_bridge', 'nav2_bringup', 'nav2_common',
                     'robot_state_publisher', 'nav2_msgs', 'tf2_ros'):
            try:
                result = subprocess.run(['ros2','pkg','prefix',name], capture_output=True,
                                        text=True, timeout=6, check=False)
                packages[name] = result.returncode == 0
            except (OSError, subprocess.TimeoutExpired):
                packages[name] = False
    missing = ([f'executable:{name}' for name, available in tools.items() if not available]
               + [f'config:{name}' for name, enabled in flags.items() if not enabled]
               + [f'package:{name}' for name, available in packages.items() if not available])
    return {'schema': 'alex.dev/ros-preflight/v1', 'status': 'ready_to_attempt' if not missing else 'blocked',
            'runtime_validation': 'NOT_RUN', 'tools': tools, 'flags': flags,
            'ros_packages': packages, 'blockers': missing}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--json', help='Write a machine-readable report file')
    parser.add_argument('--require', action='store_true', help='Fail if preflight is blocked')
    args = parser.parse_args()
    report = probe()
    if args.json:
        target = Path(args.json)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(report, indent=2, sort_keys=True) + '\n', encoding='utf8')
    print(json.dumps(report, indent=2, sort_keys=True))
    if args.require and report['status'] != 'ready_to_attempt':
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
