#!/usr/bin/env python3
"""Opt-in integration check. Requires live ROS2 Gazebo + Nav2; never runs in normal unit tests.

Usage: ALEX_ROS_SIMULATION_ONLY=1 ALEX_RUN_ROS_INTEGRATION=1 \
  python3 robotics/ros2/alex_sim/scripts/ros_smoke.py [--navigate]
"""
import argparse
import os
import time


def main():
    if os.environ.get('ALEX_ROS_SIMULATION_ONLY') != '1' or os.environ.get('ALEX_RUN_ROS_INTEGRATION') != '1':
        raise SystemExit('Simulation integration test requires explicit ALEX_ROS_SIMULATION_ONLY=1 and ALEX_RUN_ROS_INTEGRATION=1')
    parser = argparse.ArgumentParser()
    parser.add_argument('--navigate', action='store_true', help='Send a real Nav2 goal within Gazebo, never hardware')
    parser.add_argument('--timeout', type=float, default=90.0)
    args = parser.parse_args()

    import rclpy
    from rclpy.action import ActionClient
    from rosgraph_msgs.msg import Clock
    from sensor_msgs.msg import LaserScan
    from nav_msgs.msg import Odometry, OccupancyGrid
    from tf2_msgs.msg import TFMessage
    from nav2_msgs.action import NavigateToPose
    from rclpy.qos import qos_profile_sensor_data, QoSProfile, DurabilityPolicy
    from rclpy.parameter import Parameter

    rclpy.init()
    node = rclpy.create_node('alex_ros_sim_smoke', parameter_overrides=[Parameter('use_sim_time', value=True)])
    seen = set()
    frames = set()

    def received(label):
        return lambda _: seen.add(label)

    def tf_recv(msg):
        for transform in msg.transforms:
            frames.add((transform.header.frame_id, transform.child_frame_id))

    subs = [
        node.create_subscription(Clock, '/clock', received('clock'), 10),
        node.create_subscription(LaserScan, '/scan', received('scan'), qos_profile_sensor_data),
        node.create_subscription(Odometry, '/odom', received('odom'), 10),
        node.create_subscription(OccupancyGrid, '/map', received('map'), QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL)),
        node.create_subscription(TFMessage, '/tf', tf_recv, 10),
        node.create_subscription(TFMessage, '/tf_static', tf_recv, QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL)),
    ]
    action = ActionClient(node, NavigateToPose, '/navigate_to_pose')
    try:
        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline:
            rclpy.spin_once(node, timeout_sec=0.2)
            if seen == {'clock', 'scan', 'odom', 'map'} and action.server_is_ready() and ('odom', 'base_link') in frames and ('map', 'odom') in frames and ('base_link', 'lidar_link') in frames:
                break
        else:
            raise RuntimeError(f'ROS_GRAPH_NOT_READY seen={seen} frames={frames} action={action.server_is_ready()}')
        print('ROS graph ready: /clock /scan /odom /map, map->odom->base_link->lidar_link, NavigateToPose')
        if not args.navigate:
            return
        from geometry_msgs.msg import PoseStamped
        deadline = time.monotonic() + args.timeout
        goal = NavigateToPose.Goal()
        goal.pose = PoseStamped()
        goal.pose.header.frame_id = 'map'
        goal.pose.header.stamp = node.get_clock().now().to_msg()
        goal.pose.pose.position.x = 1.7
        goal.pose.pose.position.y = 1.6
        goal.pose.pose.orientation.w = 1.0
        future = action.send_goal_async(goal)
        while rclpy.ok() and time.monotonic() < deadline and not future.done():
            rclpy.spin_once(node, timeout_sec=0.1)
        if not future.done() or not future.result().accepted:
            raise RuntimeError('NAV2_GOAL_REJECTED_OR_TIMEOUT')
        handle = future.result()
        result = handle.get_result_async()
        while rclpy.ok() and time.monotonic() < deadline and not result.done():
            rclpy.spin_once(node, timeout_sec=0.1)
        if not result.done():
            cancel = handle.cancel_goal_async()
            for _ in range(25):
                if cancel.done(): break
                rclpy.spin_once(node, timeout_sec=0.1)
            raise RuntimeError('NAV2_GOAL_TIMEOUT_CANCEL_REQUESTED')
        if result.result().status != 4:  # GoalStatus.STATUS_SUCCEEDED
            raise RuntimeError(f'NAV2_GOAL_NOT_SUCCEEDED status={result.result().status}')
        print('Nav2 Gazebo goal succeeded; independent pose tolerance still needs evaluation')
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
