"""Gazebo Harmonic + ROS 2 Jazzy simulation, optionally Nav2. NEVER physical hardware."""
import os
from pathlib import Path

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription, SetEnvironmentVariable, TimerAction
from launch.conditions import IfCondition
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    if os.environ.get('ALEX_ROS_SIMULATION_ONLY') != '1':
        raise RuntimeError('SIMULATION_ONLY_FLAG_REQUIRED: do not bridge to real hardware')
    if os.environ.get('ROS_DISTRO') != 'jazzy':
        raise RuntimeError('ROS_2_JAZZY_REQUIRED: test this package only on the documented stack')

    share = Path(get_package_share_directory('alex_sim'))
    world = share / 'worlds' / 'alex_home.sdf'
    urdf = (share / 'urdf' / 'alex_bot.urdf').read_text(encoding='utf8')
    models = share / 'models'
    resource_path = str(models) + os.pathsep + os.environ.get('GZ_SIM_RESOURCE_PATH', '')
    ros_gz = Path(get_package_share_directory('ros_gz_sim'))
    bringup = Path(get_package_share_directory('nav2_bringup'))
    bringup_launch = bringup / 'launch' / 'bringup_launch.py'
    if not bringup_launch.is_file():
        raise RuntimeError('NAV2_BRINGUP_LAUNCH_MISSING: ' + str(bringup_launch))
    with_nav2 = LaunchConfiguration('with_nav2')
    # Headless EGL for simulated GPU lidar is opt-in and requires a working OGRE2
    # rendering backend. It is not the same as just running a Gazebo server (-s).
    headless = os.environ.get('ALEX_GZ_HEADLESS_RENDERING', '0')
    if headless not in ('0', '1'):
        raise RuntimeError('INVALID_HEADLESS_RENDERING_FLAG')
    # Verbose Gazebo startup is needed to diagnose render / plugin / model failures.
    gz_args = '-v 4 -r -s ' + ('--headless-rendering ' if headless == '1' else '') + str(world)
    gz = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(str(ros_gz / 'launch' / 'gz_sim.launch.py')),
        launch_arguments={'gz_args': gz_args}.items(),
    )
    # launch-ros-sim.sh generates this from *installed* Jazzy defaults and
    # validates nested parameters. A missing file must fail closed.
    params_file = os.environ.get('ALEX_ROS_NAV2_PARAMS_FILE', '')
    if not params_file or not Path(params_file).is_file():
        raise RuntimeError('NAV2_PARAMS_NOT_GENERATED: run scripts/launch-ros-sim.sh')
    nav2 = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(str(bringup_launch)),
        launch_arguments={
            'slam': 'False', 'map': str(share / 'maps' / 'alex_home.yaml'),
            'use_sim_time': 'True', 'params_file': params_file,
            'use_composition': 'False', 'autostart': 'True',
        }.items(),
        condition=IfCondition(with_nav2),
    )
    return LaunchDescription([
        DeclareLaunchArgument('with_nav2', default_value='false', description='Start Nav2 + AMCL in simulation'),
        SetEnvironmentVariable('GZ_SIM_RESOURCE_PATH', resource_path),
        gz,
        Node(package='robot_state_publisher', executable='robot_state_publisher',
             parameters=[{'robot_description': urdf, 'use_sim_time': True}], output='screen'),
        Node(package='ros_gz_bridge', executable='parameter_bridge',
             parameters=[{'config_file': str(share / 'config' / 'bridge.yaml')}], output='screen'),
        TimerAction(period=5.0, actions=[nav2]),
    ])
