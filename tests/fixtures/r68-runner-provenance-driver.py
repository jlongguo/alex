#!/usr/bin/env python3
"""R68 测试驱动：向生产 runner provenance capture 注入系统/命令结果。"""
from pathlib import Path
from runpy import run_path
import json
import sys

ROOT = Path(__file__).resolve().parents[2]
module = run_path(str(ROOT / 'scripts/ros-runner-provenance.py'))
capture = module['capture']

scenario = sys.argv[1]
sha = '0123456789abcdef0123456789abcdef01234567'
env = {
    'GITHUB_ACTIONS': 'true',
    'GITHUB_EVENT_NAME': 'workflow_dispatch',
    'GITHUB_REPOSITORY': 'jlongguo/alex',
    'GITHUB_JOB': 'nav2-simulation',
    'RUNNER_ENVIRONMENT': 'self-hosted',
    'RUNNER_OS': 'Linux',
    'RUNNER_ARCH': 'X64',
    'GITHUB_WORKFLOW_REF':
        'jlongguo/alex/.github/workflows/ros-sim-acceptance.yml@refs/heads/main',
    'GITHUB_RUN_ID': '76543210',
    'GITHUB_RUN_ATTEMPT': '2',
    'GITHUB_SHA': sha,
    'ALEX_ROS_SIMULATION_ONLY': '1',
    'ALEX_RUN_ROS_INTEGRATION': '1',
    'ALEX_GZ_HEADLESS_RENDERING': '1',
    'ROS_DOMAIN_ID': '77',
    'ROS_AUTOMATIC_DISCOVERY_RANGE': 'LOCALHOST',
    'ROS_DISTRO': 'jazzy',
    'GITHUB_TOKEN': 'must-never-appear',
}
os_release = 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n'
kernel = '6.8.0-101-generic'
machine = 'x86_64'

APT = {
    'ros-jazzy-ros-base': '0.11.0-1noble.20261114.010101',
    'ros-jazzy-ros-gz': '0.254.2-1noble.20261114.010102',
    'ros-jazzy-navigation2': '1.3.10-1noble.20261114.010103',
    'ros-jazzy-nav2-bringup': '1.3.10-1noble.20261114.010104',
    'ros-jazzy-robot-state-publisher': '3.3.3-1noble.20261114.010105',
    'ros-jazzy-tf2-ros': '0.36.8-1noble.20261114.010106',
    'python3-colcon-common-extensions': '0.3.0-1',
}
ROS = {
    'ros_gz_sim': '/opt/ros/jazzy',
    'ros_gz_bridge': '/opt/ros/jazzy',
    'nav2_bringup': '/opt/ros/jazzy',
    'nav2_common': '/opt/ros/jazzy',
    'robot_state_publisher': '/opt/ros/jazzy',
    'nav2_msgs': '/opt/ros/jazzy',
    'tf2_ros': '/opt/ros/jazzy',
}
COMMANDS = {
    ('node', '--version'): 'v22.16.0',
    ('npm', '--version'): '10.9.2',
    ('python3', '--version'): 'Python 3.12.3',
    ('git', '--version'): 'git version 2.43.0',
    ('gz', 'sim', '--versions'): 'Gazebo Sim, version 8.9.0',
    ('git', 'rev-parse', 'HEAD'): sha,
    ('git', 'status', '--porcelain=v1', '--untracked-files=no'): '',
}
for name, version in APT.items():
    COMMANDS[('dpkg-query', '-W', '-f=${Version}', name)] = version
for name, prefix in ROS.items():
    COMMANDS[('ros2', 'pkg', 'prefix', name)] = prefix

if scenario == 'wrong-os':
    os_release = 'ID=ubuntu\nVERSION_ID="22.04"\nVERSION_CODENAME=jammy\n'
elif scenario == 'wrong-machine':
    machine = 'aarch64'
elif scenario == 'wrong-runner-arch':
    env['RUNNER_ARCH'] = 'ARM64'
elif scenario == 'wrong-node':
    COMMANDS[('node', '--version')] = 'v20.19.0'
elif scenario == 'wrong-python':
    COMMANDS[('python3', '--version')] = 'Python 3.11.9'
elif scenario == 'wrong-gazebo':
    COMMANDS[('gz', 'sim', '--versions')] = 'Gazebo Sim, version 7.9.0'
elif scenario == 'dirty-tree':
    COMMANDS[('git', 'status', '--porcelain=v1', '--untracked-files=no')] = ' M scripts/server.mjs'
elif scenario == 'wrong-sha':
    COMMANDS[('git', 'rev-parse', 'HEAD')] = 'f' * 40
elif scenario == 'wrong-ros-prefix':
    COMMANDS[('ros2', 'pkg', 'prefix', 'nav2_bringup')] = '/tmp/fake'
elif scenario == 'missing-apt':
    COMMANDS.pop(('dpkg-query', '-W', '-f=${Version}', 'ros-jazzy-navigation2'))
elif scenario == 'wrong-isolation':
    env['ROS_DOMAIN_ID'] = '0'
elif scenario == 'wrong-context':
    env['GITHUB_JOB'] = 'other-job'
elif scenario != 'success':
    print('UNKNOWN_SCENARIO', file=sys.stderr)
    raise SystemExit(64)


def fake_run(argv):
    key = tuple(argv)
    if key not in COMMANDS:
        raise ValueError('RUNNER_PROVENANCE_COMMAND_FAILED')
    return COMMANDS[key]


try:
    report = capture(
        env=env,
        run=fake_run,
        os_release_text=os_release,
        kernel_release=kernel,
        machine=machine,
    )
except Exception as exc:
    print(str(exc), file=sys.stderr)
    raise SystemExit(1)

print(json.dumps(report, sort_keys=True))
