#!/usr/bin/env python3
"""Execute Alex's ROS Launch description with offline API stubs.

Unlike py_compile, this catches NameErrors and invalid path assembly inside
`generate_launch_description()` without claiming a ROS graph was launched.
"""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
from types import ModuleType
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
SIM = ROOT / 'robotics/ros2/alex_sim'


class StubAction:
    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs


def fake_modules(packages):
    def make_module(name, **symbols):
        module = ModuleType(name)
        vars(module).update(symbols)
        return module

    class LaunchDescription(StubAction):
        pass

    class IncludeLaunchDescription(StubAction):
        pass

    class TimerAction(StubAction):
        pass

    def package_dir(name):
        if name not in packages:
            raise ValueError('UNEXPECTED_ROS_PACKAGE: ' + name)
        return str(packages[name])

    modules = {
        'ament_index_python': make_module('ament_index_python'),
        'ament_index_python.packages': make_module('ament_index_python.packages', get_package_share_directory=package_dir),
        'launch': make_module('launch', LaunchDescription=LaunchDescription),
        'launch.actions': make_module('launch.actions', DeclareLaunchArgument=StubAction,
                                      IncludeLaunchDescription=IncludeLaunchDescription,
                                      SetEnvironmentVariable=StubAction, TimerAction=TimerAction),
        'launch.conditions': make_module('launch.conditions', IfCondition=StubAction),
        'launch.launch_description_sources': make_module('launch.launch_description_sources',
                                                         PythonLaunchDescriptionSource=StubAction),
        'launch.substitutions': make_module('launch.substitutions', LaunchConfiguration=StubAction),
        'launch_ros': make_module('launch_ros'),
        'launch_ros.actions': make_module('launch_ros.actions', Node=StubAction),
    }
    return modules, LaunchDescription, IncludeLaunchDescription, TimerAction


def expect_raises(func, needle):
    try:
        func()
    except RuntimeError as exc:
        assert needle in str(exc), (needle, exc)
    else:
        raise AssertionError('Expected ROS launch to reject: ' + needle)


def main():
    with tempfile.TemporaryDirectory(prefix='alex-offline-ros-launch-') as tmp:
        directory = Path(tmp)
        nav2 = directory / 'nav2_bringup'
        ros_gz = directory / 'ros_gz_sim'
        for folder, filename in ((nav2, 'bringup_launch.py'), (ros_gz, 'gz_sim.launch.py')):
            launch_dir = folder / 'launch'
            launch_dir.mkdir(parents=True)
            (launch_dir / filename).write_text('# offline stub\n', encoding='utf8')
        parameters = directory / 'nav2_params.yaml'
        parameters.write_text('amcl: {}\n', encoding='utf8')
        modules, Description, Include, Timer = fake_modules({
            'alex_sim': SIM, 'nav2_bringup': nav2, 'ros_gz_sim': ros_gz,
        })
        with patch.dict(sys.modules, modules):
            spec = importlib.util.spec_from_file_location('alex_sim_launch_under_test', SIM / 'launch/sim.launch.py')
            launch = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(launch)
            base = {
                'ALEX_ROS_SIMULATION_ONLY': '1', 'ROS_DISTRO': 'jazzy',
                'ALEX_ROS_NAV2_PARAMS_FILE': str(parameters),
                'ALEX_GZ_HEADLESS_RENDERING': '1',
            }
            with patch.dict(os.environ, base, clear=True):
                description = launch.generate_launch_description()
                assert isinstance(description, Description)
                actions = description.args[0]
                includes = [a for a in actions if isinstance(a, Include)]
                assert len(includes) == 1, 'Gazebo launch missing'
                gazebo = includes[0]
                args = dict(gazebo.kwargs['launch_arguments'])
                assert '--headless-rendering' in args['gz_args']
                assert str(SIM / 'worlds/alex_home.sdf') in args['gz_args']
                timers = [a for a in actions if isinstance(a, Timer)]
                assert len(timers) == 1
                wrapped = timers[0].kwargs['actions']
                assert len(wrapped) == 1 and isinstance(wrapped[0], Include)
                nav2_action = wrapped[0]
                source = nav2_action.args[0].args[0]
                assert source == str(nav2 / 'launch/bringup_launch.py')
                nav2_args = dict(nav2_action.kwargs['launch_arguments'])
                assert nav2_args['params_file'] == str(parameters)
                assert nav2_args['use_sim_time'] == 'True'
                assert nav2_args['slam'] == 'False'
                assert Path(nav2_args['map']).is_file()

            with patch.dict(os.environ, {**base, 'ALEX_ROS_SIMULATION_ONLY': '0'}, clear=True):
                expect_raises(launch.generate_launch_description, 'SIMULATION_ONLY_FLAG_REQUIRED')
            with patch.dict(os.environ, {**base, 'ROS_DISTRO': 'humble'}, clear=True):
                expect_raises(launch.generate_launch_description, 'ROS_2_JAZZY_REQUIRED')
            with patch.dict(os.environ, {**base, 'ALEX_ROS_NAV2_PARAMS_FILE': str(directory / 'missing.yaml')}, clear=True):
                expect_raises(launch.generate_launch_description, 'NAV2_PARAMS_NOT_GENERATED')
            with patch.dict(os.environ, {**base, 'ALEX_GZ_HEADLESS_RENDERING': 'yes'}, clear=True):
                expect_raises(launch.generate_launch_description, 'INVALID_HEADLESS_RENDERING_FLAG')
            (nav2 / 'launch/bringup_launch.py').unlink()
            with patch.dict(os.environ, base, clear=True):
                expect_raises(launch.generate_launch_description, 'NAV2_BRINGUP_LAUNCH_MISSING')
    print('Offline ROS launch execution: PASS (ROS runtime NOT tested)')


if __name__ == '__main__':
    main()
