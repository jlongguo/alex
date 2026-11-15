#!/usr/bin/env python3
"""R68：捕获并严格验证 self-hosted ROS/Gazebo Runner 的环境 provenance。

只读取系统/工具/包/源码状态，不修改系统，不访问网络，不记录 hostname、token 或用户目录。
"""
import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
from tempfile import NamedTemporaryFile

SCHEMA = 'alex.dev/ros-runner-provenance/v1'
SOURCE = 'github-actions-self-hosted-runtime'
REPO = 'jlongguo/alex'
WORKFLOW = '.github/workflows/ros-sim-acceptance.yml'
JOB = 'nav2-simulation'
ROOT = Path(__file__).resolve().parent.parent
DEFAULT = ROOT / '.local/ros/runner-provenance.json'

SHA40 = re.compile(r'^[0-9a-f]{40}$')
SHA256 = re.compile(r'^[0-9a-f]{64}$')
DIGITS = re.compile(r'^[1-9][0-9]{0,19}$')
VERSION = re.compile(r'^[A-Za-z0-9.+:~_-]{1,128}$')
NODE22 = re.compile(r'^v22\.[0-9]+\.[0-9]+$')
PY312 = re.compile(r'^Python 3\.12\.[0-9]+$')
NPM_VERSION = re.compile(r'^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$')
GIT_VERSION = re.compile(r'^git version [0-9]+\.[0-9]+(?:\.[0-9]+)*(?:[ .A-Za-z0-9_-]*)$')
WORKFLOW_REF = re.compile(
    r'^jlongguo/alex/\.github/workflows/ros-sim-acceptance\.yml@refs/heads/[A-Za-z0-9_./-]+$')

APT_PACKAGES = (
    'ros-jazzy-ros-base',
    'ros-jazzy-ros-gz',
    'ros-jazzy-navigation2',
    'ros-jazzy-nav2-bringup',
    'ros-jazzy-robot-state-publisher',
    'ros-jazzy-tf2-ros',
    'python3-colcon-common-extensions',
)
ROS_PACKAGES = (
    'ros_gz_sim',
    'ros_gz_bridge',
    'nav2_bringup',
    'nav2_common',
    'robot_state_publisher',
    'nav2_msgs',
    'tf2_ros',
)


def reject(condition, code):
    if not condition:
        raise ValueError(code)


def command(argv, cwd=ROOT, timeout=8):
    try:
        checked = subprocess.run(
            argv, cwd=cwd, capture_output=True, text=True,
            timeout=timeout, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError('RUNNER_PROVENANCE_COMMAND_FAILED') from exc
    reject(checked.returncode == 0, 'RUNNER_PROVENANCE_COMMAND_FAILED')
    output = ((checked.stdout or '') + (checked.stderr or '')).strip()
    reject(len(output.encode('utf8')) <= 16 * 1024,
           'RUNNER_PROVENANCE_COMMAND_OUTPUT_TOO_LARGE')
    return output


def parse_os_release(text):
    values = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        if value.startswith('"') and value.endswith('"'):
            value = value[1:-1]
        values[key] = value
    return values


def action_context(env):
    reject(env.get('GITHUB_ACTIONS') == 'true'
           and env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
           and env.get('GITHUB_REPOSITORY') == REPO
           and env.get('GITHUB_JOB') == JOB
           and env.get('RUNNER_ENVIRONMENT') == 'self-hosted',
           'RUNNER_PROVENANCE_UNAPPROVED_CONTEXT')
    workflow_ref = env.get('GITHUB_WORKFLOW_REF')
    reject(isinstance(workflow_ref, str) and WORKFLOW_REF.fullmatch(workflow_ref),
           'RUNNER_PROVENANCE_WORKFLOW_REF_INVALID')
    run_id = env.get('GITHUB_RUN_ID')
    attempt = env.get('GITHUB_RUN_ATTEMPT')
    commit = env.get('GITHUB_SHA')
    reject(isinstance(run_id, str) and DIGITS.fullmatch(run_id),
           'RUNNER_PROVENANCE_RUN_ID_INVALID')
    reject(isinstance(attempt, str) and attempt.isascii() and attempt.isdigit()
           and 1 <= int(attempt) <= 10000,
           'RUNNER_PROVENANCE_ATTEMPT_INVALID')
    reject(isinstance(commit, str) and SHA40.fullmatch(commit),
           'RUNNER_PROVENANCE_COMMIT_INVALID')
    reject(env.get('RUNNER_OS') == 'Linux' and env.get('RUNNER_ARCH') == 'X64',
           'RUNNER_PROVENANCE_RUNNER_PLATFORM_INVALID')
    return {
        'repository': REPO,
        'workflow': WORKFLOW,
        'workflow_ref': workflow_ref,
        'job': JOB,
        'workflow_run_id': run_id,
        'workflow_run_attempt': int(attempt),
        'commit_sha': commit,
        'runner_environment': 'self-hosted',
        'runner_os': 'Linux',
        'runner_arch': 'X64',
    }


def isolation_context(env):
    values = {
        'simulation_only': env.get('ALEX_ROS_SIMULATION_ONLY'),
        'integration_opt_in': env.get('ALEX_RUN_ROS_INTEGRATION'),
        'headless_rendering': env.get('ALEX_GZ_HEADLESS_RENDERING'),
        'ros_domain_id': env.get('ROS_DOMAIN_ID'),
        'ros_discovery_range': env.get('ROS_AUTOMATIC_DISCOVERY_RANGE'),
        'ros_distro': env.get('ROS_DISTRO'),
    }
    reject(values == {
        'simulation_only': '1',
        'integration_opt_in': '1',
        'headless_rendering': '1',
        'ros_domain_id': '77',
        'ros_discovery_range': 'LOCALHOST',
        'ros_distro': 'jazzy',
    }, 'RUNNER_PROVENANCE_ISOLATION_INVALID')
    return values


def capture(env=os.environ, run=command, os_release_text=None,
            kernel_release=None, machine=None):
    actions = action_context(env)
    isolation = isolation_context(env)

    if os_release_text is None:
        try:
            os_release_text = Path('/etc/os-release').read_text(
                encoding='utf8', errors='strict')
        except (OSError, UnicodeError) as exc:
            raise ValueError('RUNNER_PROVENANCE_OS_RELEASE_UNREADABLE') from exc
    os_release = parse_os_release(os_release_text)
    os_info = {
        'id': os_release.get('ID'),
        'version_id': os_release.get('VERSION_ID'),
        'version_codename': os_release.get('VERSION_CODENAME'),
    }
    reject(os_info == {
        'id': 'ubuntu', 'version_id': '24.04', 'version_codename': 'noble',
    }, 'RUNNER_PROVENANCE_OS_UNSUPPORTED')

    kernel = kernel_release if kernel_release is not None else platform.release()
    architecture = machine if machine is not None else platform.machine()
    reject(isinstance(kernel, str) and 1 <= len(kernel) <= 128,
           'RUNNER_PROVENANCE_KERNEL_INVALID')
    reject(architecture == 'x86_64',
           'RUNNER_PROVENANCE_MACHINE_INVALID')

    node = run(['node', '--version']).strip()
    npm = run(['npm', '--version']).strip()
    python = run(['python3', '--version']).strip()
    git = run(['git', '--version']).strip()
    gazebo = run(['gz', 'sim', '--versions']).strip()
    reject(NODE22.fullmatch(node), 'RUNNER_PROVENANCE_NODE_INVALID')
    reject(NPM_VERSION.fullmatch(npm), 'RUNNER_PROVENANCE_NPM_INVALID')
    reject(PY312.fullmatch(python), 'RUNNER_PROVENANCE_PYTHON_INVALID')
    reject(GIT_VERSION.fullmatch(git), 'RUNNER_PROVENANCE_GIT_INVALID')
    reject('Gazebo Sim' in gazebo
           and re.search(r'\b8\.[0-9]+\.[0-9]+\b', gazebo),
           'RUNNER_PROVENANCE_GAZEBO_INVALID')

    head = run(['git', 'rev-parse', 'HEAD']).strip()
    reject(head == actions['commit_sha'],
           'RUNNER_PROVENANCE_GIT_HEAD_MISMATCH')
    tracked_status = run([
        'git', 'status', '--porcelain=v1', '--untracked-files=no'
    ])
    reject(tracked_status == '', 'RUNNER_PROVENANCE_TRACKED_WORKTREE_DIRTY')

    apt_versions = {}
    for package in APT_PACKAGES:
        value = run([
            'dpkg-query', '-W', '-f=${Version}', package
        ]).strip()
        reject(VERSION.fullmatch(value) is not None,
               'RUNNER_PROVENANCE_APT_VERSION_INVALID')
        apt_versions[package] = value

    ros_prefixes = {}
    for package in ROS_PACKAGES:
        prefix = run(['ros2', 'pkg', 'prefix', package]).strip()
        reject(prefix == '/opt/ros/jazzy',
               'RUNNER_PROVENANCE_ROS_PREFIX_INVALID')
        ros_prefixes[package] = prefix

    payload = {
        'actions': actions,
        'isolation': isolation,
        'platform': {
            **os_info,
            'kernel_release': kernel,
            'machine': architecture,
        },
        'tools': {
            'node': node,
            'npm': npm,
            'python3': python,
            'git': git,
            'gazebo_sim_versions': gazebo,
        },
        'apt_packages': apt_versions,
        'ros_package_prefixes': ros_prefixes,
        'source': {
            'git_head': head,
            'tracked_worktree_clean': True,
        },
    }
    fingerprint = sha256(json.dumps(
        payload, sort_keys=True, separators=(',', ':'), ensure_ascii=True
    ).encode('utf8')).hexdigest()
    report = {
        'schema': SCHEMA,
        'status': 'verified',
        'source_type': SOURCE,
        'simulation_only': True,
        'physical_safety_certified': False,
        'release_approved': False,
        **payload,
        'fingerprint_sha256': fingerprint,
        'captured_at': datetime.now(timezone.utc).isoformat(),
    }
    verify_report(report, actions['workflow_run_id'],
                  actions['workflow_run_attempt'], actions['commit_sha'])
    return report


def verify_report(report, expected_run_id, expected_attempt, expected_sha):
    reject(isinstance(report, dict)
           and set(report) == {
               'schema', 'status', 'source_type', 'simulation_only',
               'physical_safety_certified', 'release_approved',
               'actions', 'isolation', 'platform', 'tools',
               'apt_packages', 'ros_package_prefixes', 'source',
               'fingerprint_sha256', 'captured_at',
           },
           'RUNNER_PROVENANCE_REPORT_SHAPE_INVALID')
    reject(report.get('schema') == SCHEMA
           and report.get('status') == 'verified'
           and report.get('source_type') == SOURCE,
           'RUNNER_PROVENANCE_REPORT_INVALID')
    reject(report.get('simulation_only') is True
           and report.get('physical_safety_certified') is False
           and report.get('release_approved') is False,
           'RUNNER_PROVENANCE_OVERCLAIMED')

    actions = report.get('actions')
    reject(isinstance(actions, dict)
           and set(actions) == {
               'repository', 'workflow', 'workflow_ref', 'job',
               'workflow_run_id', 'workflow_run_attempt', 'commit_sha',
               'runner_environment', 'runner_os', 'runner_arch',
           }
           and actions.get('repository') == REPO
           and actions.get('workflow') == WORKFLOW
           and actions.get('job') == JOB
           and actions.get('runner_environment') == 'self-hosted'
           and actions.get('runner_os') == 'Linux'
           and actions.get('runner_arch') == 'X64'
           and isinstance(actions.get('workflow_ref'), str)
           and WORKFLOW_REF.fullmatch(actions['workflow_ref'])
           and actions.get('workflow_run_id') == expected_run_id
           and actions.get('workflow_run_attempt') == expected_attempt
           and actions.get('commit_sha') == expected_sha,
           'RUNNER_PROVENANCE_ACTIONS_CONTEXT_INVALID')

    reject(report.get('isolation') == {
        'simulation_only': '1',
        'integration_opt_in': '1',
        'headless_rendering': '1',
        'ros_domain_id': '77',
        'ros_discovery_range': 'LOCALHOST',
        'ros_distro': 'jazzy',
    }, 'RUNNER_PROVENANCE_ISOLATION_INVALID')

    platform_info = report.get('platform')
    reject(isinstance(platform_info, dict)
           and set(platform_info) == {
               'id', 'version_id', 'version_codename',
               'kernel_release', 'machine',
           }
           and platform_info.get('id') == 'ubuntu'
           and platform_info.get('version_id') == '24.04'
           and platform_info.get('version_codename') == 'noble'
           and platform_info.get('machine') == 'x86_64'
           and isinstance(platform_info.get('kernel_release'), str)
           and 1 <= len(platform_info['kernel_release']) <= 128,
           'RUNNER_PROVENANCE_PLATFORM_INVALID')

    tools = report.get('tools')
    reject(isinstance(tools, dict)
           and set(tools) == {
               'node', 'npm', 'python3', 'git', 'gazebo_sim_versions',
           }
           and isinstance(tools.get('node'), str)
           and NODE22.fullmatch(tools['node'])
           and isinstance(tools.get('npm'), str)
           and NPM_VERSION.fullmatch(tools['npm'])
           and isinstance(tools.get('python3'), str)
           and PY312.fullmatch(tools['python3'])
           and isinstance(tools.get('git'), str)
           and GIT_VERSION.fullmatch(tools['git'])
           and isinstance(tools.get('gazebo_sim_versions'), str)
           and len(tools['gazebo_sim_versions'].encode('utf8')) <= 16 * 1024
           and 'Gazebo Sim' in tools['gazebo_sim_versions']
           and re.search(r'\b8\.[0-9]+\.[0-9]+\b',
                         tools['gazebo_sim_versions']),
           'RUNNER_PROVENANCE_TOOLS_INVALID')

    apt = report.get('apt_packages')
    reject(isinstance(apt, dict) and set(apt) == set(APT_PACKAGES)
           and all(isinstance(value, str) and VERSION.fullmatch(value)
                   for value in apt.values()),
           'RUNNER_PROVENANCE_APT_PACKAGES_INVALID')

    prefixes = report.get('ros_package_prefixes')
    reject(isinstance(prefixes, dict) and set(prefixes) == set(ROS_PACKAGES)
           and all(value == '/opt/ros/jazzy' for value in prefixes.values()),
           'RUNNER_PROVENANCE_ROS_PACKAGES_INVALID')

    source = report.get('source')
    reject(source == {
        'git_head': expected_sha,
        'tracked_worktree_clean': True,
    }, 'RUNNER_PROVENANCE_SOURCE_INVALID')

    payload = {
        'actions': actions,
        'isolation': report['isolation'],
        'platform': platform_info,
        'tools': tools,
        'apt_packages': apt,
        'ros_package_prefixes': prefixes,
        'source': source,
    }
    fingerprint = sha256(json.dumps(
        payload, sort_keys=True, separators=(',', ':'), ensure_ascii=True
    ).encode('utf8')).hexdigest()
    reject(isinstance(report.get('fingerprint_sha256'), str)
           and SHA256.fullmatch(report['fingerprint_sha256'])
           and report['fingerprint_sha256'] == fingerprint,
           'RUNNER_PROVENANCE_FINGERPRINT_MISMATCH')
    reject(isinstance(report.get('captured_at'), str)
           and 20 <= len(report['captured_at']) <= 64,
           'RUNNER_PROVENANCE_CAPTURE_TIME_INVALID')
    return True


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = None
    try:
        with NamedTemporaryFile(
            mode='w', encoding='utf8', dir=path.parent,
            prefix='.runner-provenance-', suffix='.tmp', delete=False
        ) as stream:
            temporary = Path(stream.name)
            os.chmod(stream.name, 0o600)
            json.dump(data, stream, ensure_ascii=False, sort_keys=True, indent=2)
            stream.write('\n')
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def read_report(path):
    reject(path.is_file() and not path.is_symlink(),
           'RUNNER_PROVENANCE_FILE_MISSING_OR_SYMLINK')
    size = path.stat().st_size
    reject(2 <= size <= 128 * 1024,
           'RUNNER_PROVENANCE_FILE_SIZE_INVALID')
    try:
        value = json.loads(path.read_text(encoding='utf8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError('RUNNER_PROVENANCE_JSON_INVALID') from exc
    reject(isinstance(value, dict), 'RUNNER_PROVENANCE_OBJECT_REQUIRED')
    return value


def expected_args(args):
    reject(isinstance(args.run_id, str) and DIGITS.fullmatch(args.run_id),
           'RUNNER_PROVENANCE_EXPECTED_RUN_INVALID')
    reject(type(args.attempt) is int and 1 <= args.attempt <= 10000,
           'RUNNER_PROVENANCE_EXPECTED_ATTEMPT_INVALID')
    reject(isinstance(args.commit_sha, str) and SHA40.fullmatch(args.commit_sha),
           'RUNNER_PROVENANCE_EXPECTED_SHA_INVALID')
    return args.run_id, args.attempt, args.commit_sha


def main():
    parser = argparse.ArgumentParser(
        description='Capture/verify ROS self-hosted runner provenance')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--capture', action='store_true')
    mode.add_argument('--verify', action='store_true')
    parser.add_argument('--report', type=Path, default=DEFAULT)
    parser.add_argument('--run-id')
    parser.add_argument('--attempt', type=int)
    parser.add_argument('--commit-sha')
    args = parser.parse_args()
    try:
        if args.capture:
            reject(args.run_id is None and args.attempt is None
                   and args.commit_sha is None,
                   'RUNNER_PROVENANCE_CAPTURE_UNEXPECTED_EXPECTATION')
            report = capture()
            atomic_write(args.report, report)
            print('ROS_RUNNER_PROVENANCE_CAPTURED:'
                  + report['fingerprint_sha256'])
        else:
            run_id, attempt, commit = expected_args(args)
            verify_report(read_report(args.report), run_id, attempt, commit)
            print('ROS runner provenance verified')
    except (OSError, ValueError, TypeError) as exc:
        code = str(exc)
        if not re.fullmatch(r'RUNNER_PROVENANCE_[A-Z0-9_]+', code):
            code = 'RUNNER_PROVENANCE_FAILED'
        print(code, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
