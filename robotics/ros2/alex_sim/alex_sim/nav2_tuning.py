"""Build a *verified* Nav2 Jazzy simulation configuration.

Only applies overrides at explicit nested ROS parameter paths.  Refuses an
incompatible installed nav2_bringup template instead of silently ignoring
configuration or applying top-level keys to unrelated Nav2 components.
"""
import argparse
import copy
from pathlib import Path


INITIAL_POSE = (0.7, 2.8)


class IncompatibleNav2Template(ValueError):
    pass


def nested(data, *parts):
    cursor = data
    for part in parts:
        if not isinstance(cursor, dict) or part not in cursor:
            raise IncompatibleNav2Template('Missing Nav2 configuration key: ' + '.'.join(parts))
        cursor = cursor[part]
    if not isinstance(cursor, dict):
        raise IncompatibleNav2Template('Expected mapping at: ' + '.'.join(parts))
    return cursor


def configure_nav2(source):
    """Return a tuned copy of a parsed installed Jazzy nav2_params.yaml."""
    if not isinstance(source, dict):
        raise IncompatibleNav2Template('Nav2 base parameters must be a YAML mapping')
    data = copy.deepcopy(source)
    amcl = nested(data, 'amcl', 'ros__parameters')
    controller = nested(data, 'controller_server', 'ros__parameters')
    local = nested(data, 'local_costmap', 'local_costmap', 'ros__parameters')
    global_map = nested(data, 'global_costmap', 'global_costmap', 'ros__parameters')
    bt_navigator = nested(data, 'bt_navigator', 'ros__parameters')
    behavior = nested(data, 'behavior_server', 'ros__parameters')
    collision_monitor = nested(data, 'collision_monitor', 'ros__parameters')

    # Jazzy's default BT Action goal-ack window is 20 ms. A local Gazebo
    # process sharing CPU with OGRE2 and MPPI may briefly defer a planner
    # server callback even when planning itself is healthy. Keep a bounded
    # 1-second acknowledgement timeout, without changing the per-leg action
    # deadline or permitting an aborted goal to pass acceptance.
    ack_timeout = bt_navigator.get('default_server_timeout')
    if type(ack_timeout) is not int or not (1 <= ack_timeout <= 60_000):
        raise IncompatibleNav2Template('Invalid bt_navigator.default_server_timeout')
    bt_navigator['default_server_timeout'] = 1000

    amcl.update({
        'use_sim_time': True, 'base_frame_id': 'base_link',
        'odom_frame_id': 'odom', 'global_frame_id': 'map',
        'scan_topic': '/scan', 'set_initial_pose': True,
        'initial_pose': {'x': INITIAL_POSE[0], 'y': INITIAL_POSE[1], 'z': 0.0, 'yaw': 0.0},
    })
    for component in ('bt_navigator', 'planner_server', 'controller_server',
                      'behavior_server', 'smoother_server', 'velocity_smoother',
                      'collision_monitor'):
        if component in data:
            nested(data, component, 'ros__parameters')['use_sim_time'] = True

    # Gazebo's DiffDrive publishes odom -> base_link; robot_state_publisher
    # publishes base_link -> lidar_link. There is NO base_footprint frame.
    # Nav2 Jazzy's stock collision_monitor still defaults to base_footprint,
    # causing every scan transform to fail and blocking the final /cmd_vel.
    bt_navigator['robot_base_frame'] = 'base_link'
    behavior['robot_base_frame'] = 'base_link'
    collision_monitor['base_frame_id'] = 'base_link'
    collision_monitor['odom_frame_id'] = 'odom'

    # Preserve the Nav2 safety filter. Controller -> velocity_smoother ->
    # collision_monitor -> ros_gz_bridge -> Gazebo DiffDrive must remain wired.
    # Fail closed if a different installed template uses incompatible topics.
    velocity_chain = {
        'cmd_vel_in_topic': 'cmd_vel_smoothed',
        'cmd_vel_out_topic': 'cmd_vel',
    }
    for key, expected in velocity_chain.items():
        if collision_monitor.get(key, expected) != expected:
            raise IncompatibleNav2Template(
                f'Unexpected collision_monitor {key}: {collision_monitor[key]!r}')
        collision_monitor[key] = expected
    sources = collision_monitor.get('observation_sources', [])
    if not isinstance(sources, list) or 'scan' not in sources:
        raise IncompatibleNav2Template('collision_monitor must observe the simulated /scan')
    scan = nested(collision_monitor, 'scan')
    if scan.get('type') != 'scan' or scan.get('topic') not in ('scan', '/scan'):
        raise IncompatibleNav2Template('collision_monitor scan source is incompatible with /scan')

    for costmap in (local, global_map):
        costmap['use_sim_time'] = True
        costmap['robot_base_frame'] = 'base_link'
        costmap['robot_radius'] = 0.19
        if 'inflation_layer' not in costmap:
            raise IncompatibleNav2Template('Installed costmap lacks inflation_layer')
        nested(costmap, 'inflation_layer')['inflation_radius'] = 0.24

    checker_names = controller.get('goal_checker_plugins')
    if not isinstance(checker_names, list) or not checker_names:
        raise IncompatibleNav2Template('Missing controller_server goal_checker_plugins')
    tuned_goal_checker = False
    for name in checker_names:
        checker = nested(controller, name)
        if checker.get('plugin') == 'nav2_controller::SimpleGoalChecker':
            checker['xy_goal_tolerance'] = 0.08
            checker['yaw_goal_tolerance'] = 0.20
            tuned_goal_checker = True
    if not tuned_goal_checker:
        raise IncompatibleNav2Template('No compatible SimpleGoalChecker in installed Nav2 template')

    progress_names = controller.get('progress_checker_plugins')
    if not isinstance(progress_names, list) or not progress_names:
        raise IncompatibleNav2Template('Missing progress_checker_plugins')
    tuned_progress_checker = False
    for name in progress_names:
        checker = nested(controller, name)
        if checker.get('plugin') == 'nav2_controller::SimpleProgressChecker':
            checker['required_movement_radius'] = 0.08
            tuned_progress_checker = True
    if not tuned_progress_checker:
        raise IncompatibleNav2Template('No compatible SimpleProgressChecker in installed Nav2 template')

    plugins = controller.get('controller_plugins')
    if not isinstance(plugins, list) or 'FollowPath' not in plugins:
        raise IncompatibleNav2Template('Expected controller_plugins FollowPath')
    follow_path = nested(controller, 'FollowPath')
    # Existing Nav2 releases use different controllers: only rewrite supported keys.
    # Do not add unknown keys or override the plugin identity from installed Jazzy.
    for key, val in {'vx_max': 0.20, 'vx_min': -0.10, 'wz_max': 1.0}.items():
        if key in follow_path:
            follow_path[key] = val
    if not any(k in follow_path for k in ('vx_max', 'desired_linear_vel')):
        raise IncompatibleNav2Template('Unsupported installed FollowPath controller configuration')
    if 'desired_linear_vel' in follow_path:
        follow_path['desired_linear_vel'] = 0.20

    if follow_path.get('plugin') == 'nav2_mppi_controller::MPPIController':
        # The installed Jazzy template samples ~2000 * 56 trajectories at
        # 20 Hz and may visualize them. Do not spend software-rendered Docker
        # CPU on diagnostic visuals during acceptance. A smaller batch
        # preserves MPPI, its critics, and the 20-Hz prediction time base.
        batch_size = follow_path.get('batch_size')
        if type(batch_size) is not int or not (1 <= batch_size <= 100_000):
            raise IncompatibleNav2Template('Invalid FollowPath MPPI batch_size')
        model_dt = follow_path.get('model_dt')
        control_hz = controller.get('controller_frequency')
        if (not isinstance(model_dt, (float, int)) or isinstance(model_dt, bool)
                or not isinstance(control_hz, (float, int)) or isinstance(control_hz, bool)
                or not (0.001 <= model_dt <= 1.0 and 1.0 <= control_hz <= 100.0)
                or abs(float(model_dt) - 1.0 / float(control_hz)) > 1e-6):
            raise IncompatibleNav2Template('MPPI model_dt must match controller_frequency')
        follow_path['batch_size'] = min(batch_size, 750)
        if 'visualize' in follow_path:
            follow_path['visualize'] = False
        if 'publish_optimal_trajectory' in follow_path:
            follow_path['publish_optimal_trajectory'] = False

    return data


def main():
    parser = argparse.ArgumentParser(description='Generate strict Alex Nav2 Jazzy parameters from installed defaults')
    parser.add_argument('--input', required=True, help='Installed Jazzy nav2_bringup default params YAML')
    parser.add_argument('--output', required=True, help='Generated simulation-only params YAML')
    args = parser.parse_args()
    try:
        import yaml
    except ModuleNotFoundError as exc:
        if exc.name != 'yaml':
            raise
        parser.error('PyYAML is required to process ROS YAML templates. Create a Python venv with '
                     '`python3 -m venv .venv`, activate it, then run '
                     '`python3 -m pip install -r requirements-ros-test.txt`.')
    source = yaml.safe_load(Path(args.input).read_text(encoding='utf8'))
    output = configure_nav2(source)
    dest = Path(args.output)
    dest.parent.mkdir(parents=True, exist_ok=True)
    temp = dest.with_suffix('.tmp')
    temp.write_text(yaml.safe_dump(output, sort_keys=False), encoding='utf8')
    temp.replace(dest)
    print('Generated strict nested Nav2 parameters:', dest)


if __name__ == '__main__':
    main()
