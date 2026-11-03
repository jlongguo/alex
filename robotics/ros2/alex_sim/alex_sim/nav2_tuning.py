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
    nested(data, 'bt_navigator', 'ros__parameters')

    amcl.update({
        'use_sim_time': True, 'base_frame_id': 'base_link',
        'odom_frame_id': 'odom', 'global_frame_id': 'map',
        'scan_topic': '/scan', 'set_initial_pose': True,
        'initial_pose': {'x': INITIAL_POSE[0], 'y': INITIAL_POSE[1], 'z': 0.0, 'yaw': 0.0},
    })
    for component in ('bt_navigator', 'planner_server', 'controller_server',
                      'behavior_server', 'smoother_server', 'velocity_smoother'):
        if component in data:
            nested(data, component, 'ros__parameters')['use_sim_time'] = True

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

    return data


def main():
    parser = argparse.ArgumentParser(description='Generate strict Alex Nav2 Jazzy parameters from installed defaults')
    parser.add_argument('--input', required=True, help='Installed Jazzy nav2_bringup default params YAML')
    parser.add_argument('--output', required=True, help='Generated simulation-only params YAML')
    args = parser.parse_args()
    import yaml
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
