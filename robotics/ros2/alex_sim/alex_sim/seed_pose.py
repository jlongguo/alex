"""Simulation-only AMCL seed, after a ROS subscriber exists. Not a localization system."""
import os
import time


def main():
    if os.environ.get('ALEX_ROS_SIMULATION_ONLY') != '1':
        raise SystemExit('SIMULATION_ONLY_FLAG_REQUIRED')
    import rclpy
    from rclpy.node import Node
    from rclpy.parameter import Parameter
    from geometry_msgs.msg import PoseWithCovarianceStamped

    rclpy.init()
    node = Node('alex_sim_initial_pose', parameter_overrides=[Parameter('use_sim_time', value=True)])
    pub = node.create_publisher(PoseWithCovarianceStamped, '/initialpose', 10)
    deadline = time.monotonic() + 45
    count = 0
    try:
        while rclpy.ok() and time.monotonic() < deadline:
            rclpy.spin_once(node, timeout_sec=0.25)
            if pub.get_subscription_count() == 0 or node.get_clock().now().nanoseconds <= 0:
                continue
            pose = PoseWithCovarianceStamped()
            pose.header.frame_id = 'map'
            pose.header.stamp = node.get_clock().now().to_msg()
            pose.pose.pose.position.x, pose.pose.pose.position.y = 0.7, 2.8
            pose.pose.pose.orientation.w = 1.0
            pose.pose.covariance[0] = 0.01
            pose.pose.covariance[7] = 0.01
            pose.pose.covariance[35] = 0.01
            pub.publish(pose)
            count += 1
            if count >= 3:
                return
            time.sleep(1)
        raise RuntimeError('AMCL_INITIAL_POSE_SUBSCRIBER_UNAVAILABLE')
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
