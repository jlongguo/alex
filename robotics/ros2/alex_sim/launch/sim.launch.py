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
from nav2_common.launch import RewrittenYaml
import yaml


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
    with_nav2 = LaunchConfiguration('with_nav2')
    # --headless-rendering permits GPU lidar in a headless Gazebo server if EGL works.
    # GUI requires a supported graphics environment; CLI override is documented.
    gz = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(str(ros_gz / 'launch' / 'gz_sim.launch.py')),
        launch_arguments={'gz_args': ['-r -s ', str(world)]}.items(),
    )
    tuning = yaml.safe_load((share / 'config' / 'nav2_tuning.yaml').read_text())
    params = RewrittenYaml(
        source_file=str(bringup / 'params' / 'nav2_params.yaml'),
        root_key='', param_rewrites={k: str(v) for k, v in tuning.items()},
        convert_types=True,
    )
    nav2 = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(str(bringup / 'launch' / 'bringup_launch.py')),
        launch_arguments={
            'slam': 'False', 'map': str(share / 'maps' / 'alex_home.yaml'),
            'use_sim_time': 'True', 'params_file': params,
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
        Node(package='alex_sim', executable='seed_pose', name='alex_seed_amcl_pose',
             parameters=[{'use_sim_time': True}], condition=IfCondition(with_nav2), output='screen'),
    ])
