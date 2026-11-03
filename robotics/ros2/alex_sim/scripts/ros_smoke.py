#!/usr/bin/env python3
"""Opt-in LIVE ROS 2 / Gazebo / Nav2 acceptance test, never physical hardware.

Provides machine-readable evidence for graph readiness and three navigation legs:
  dock -> study_desk -> story_corner -> dock.
DO NOT run against a physical robot or shared ROS domain.
"""
import argparse
import json
import math
import os
from pathlib import Path
import time


def save_report(report, path):
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp = destination.with_name(destination.name + '.tmp')
    temp.write_text(json.dumps(report, indent=2, sort_keys=True) + '\n', encoding='utf8')
    temp.replace(destination)


def main():
    if os.environ.get('ALEX_ROS_SIMULATION_ONLY') != '1' or os.environ.get('ALEX_RUN_ROS_INTEGRATION') != '1':
        raise SystemExit('Simulation integration test requires explicit ALEX_ROS_SIMULATION_ONLY=1 and ALEX_RUN_ROS_INTEGRATION=1')
    if os.environ.get('ROS_DISTRO') != 'jazzy':
        raise SystemExit('ROS 2 Jazzy is required for this simulation acceptance script')
    parser = argparse.ArgumentParser()
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--navigate', action='store_true', help='One goal: dock to study desk')
    modes.add_argument('--route', action='store_true', help='Three goals: desk -> story -> dock')
    parser.add_argument('--timeout', type=float, default=110.0, help='ROS graph readiness deadline in wall seconds')
    parser.add_argument('--goal-timeout', type=float, default=150.0, help='Per-goal wall time budget')
    parser.add_argument('--report', default='.local/ros/acceptance-report.json')
    args = parser.parse_args()
    if not (10 <= args.timeout <= 600) or not (15 <= args.goal_timeout <= 600):
        raise SystemExit('Invalid acceptance timeouts')

    from alex_sim.acceptance import (ACCEPTANCE_ROUTE, DESK, summarize_leg,
                                     verify_graph, graph_readiness_snapshot, GRAPH_TOPICS)
    import rclpy
    from action_msgs.msg import GoalStatus
    from rclpy.action import ActionClient
    from rclpy.parameter import Parameter
    from rclpy.duration import Duration
    from rclpy.time import Time
    from rosgraph_msgs.msg import Clock
    from sensor_msgs.msg import LaserScan
    from nav_msgs.msg import Odometry, OccupancyGrid
    from tf2_msgs.msg import TFMessage
    from tf2_ros import Buffer, TransformListener
    from geometry_msgs.msg import PoseStamped
    from nav2_msgs.action import NavigateToPose
    from lifecycle_msgs.srv import GetState
    from alex_sim.nav2_lifecycle import Nav2LifecycleGate
    from rclpy.qos import qos_profile_sensor_data, QoSProfile, DurabilityPolicy, ReliabilityPolicy

    report = {'schema': 'alex.dev/ros-acceptance/v1', 'mode': 'route' if args.route else 'navigate' if args.navigate else 'graph',
              'status': 'running', 'legs': [], 'checks': [], 'simulation_only': True,
              'run_id': os.environ.get('ALEX_ROS_ACCEPTANCE_RUN_ID') or __import__('uuid').uuid4().hex}
    save_report(report, args.report)
    rclpy.init()
    node = rclpy.create_node('alex_ros_sim_acceptance', parameter_overrides=[Parameter('use_sim_time', value=True)])
    seen, frames = set(), set()
    clock_times = []
    latest_odom = []
    latest_scan = []
    validated_map = []

    def received(label, value=None):
        def callback(message):
            seen.add(label)
            if value is not None:
                value.append(message)
                if len(value) > 5:
                    del value[:-5]
        return callback

    def clock_received(msg):
        seen.add('clock')
        sim_ns = msg.clock.sec * 1_000_000_000 + msg.clock.nanosec
        if sim_ns > 0 and (not clock_times or sim_ns != clock_times[-1]):
            clock_times.append(sim_ns)
            if len(clock_times) > 5:
                clock_times.pop(0)

    def map_received(msg):
        if msg.info.width == 60 and msg.info.height == 34 and abs(msg.info.resolution - 0.1) < 1e-6:
            seen.add('map')
            validated_map.append(True)

    def tf_recv(msg):
        for transform in msg.transforms:
            frames.add((transform.header.frame_id.lstrip('/'), transform.child_frame_id.lstrip('/')))

    # Gazebo CLOCK QoS is BEST_EFFORT: an integer depth alone would create
    # a RELIABLE subscription that DDS refuses to match to the bridge.
    clock_qos = QoSProfile(depth=10, reliability=ReliabilityPolicy.BEST_EFFORT,
                           durability=DurabilityPolicy.VOLATILE)
    subs = [
        node.create_subscription(Clock, '/clock', clock_received, clock_qos),
        node.create_subscription(LaserScan, '/scan', received('scan', latest_scan), qos_profile_sensor_data),
        node.create_subscription(Odometry, '/odom', received('odom', latest_odom), qos_profile_sensor_data),
        node.create_subscription(OccupancyGrid, '/map', map_received, QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL)),
        node.create_subscription(TFMessage, '/tf', tf_recv, 10),
        node.create_subscription(TFMessage, '/tf_static', tf_recv, QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL)),
    ]
    tf_buffer = Buffer(cache_time=Duration(seconds=10))
    tf_listener = TransformListener(tf_buffer, node, spin_thread=False)
    action = ActionClient(node, NavigateToPose, '/navigate_to_pose')
    # An advertised Nav2 action does not mean that its lifecycle node is active.
    navigator_state_client = node.create_client(GetState, '/bt_navigator/get_state')
    navigator_gate = Nav2LifecycleGate()

    def graph_snapshot():
        try:
            topics = [name for name, _ in node.get_topic_names_and_types()]
        except Exception:
            topics = []
        publishers = {}
        for topic in GRAPH_TOPICS:
            try:
                publishers[topic] = node.count_publishers(topic)
            except Exception:
                publishers[topic] = 0
        _, tf_fresh = current_tf_pose()
        return graph_readiness_snapshot(
            seen, frames, clock_times, odom_samples=len(latest_odom),
            scan_samples=len(latest_scan),
            scan_ranges=len(latest_scan[-1].ranges) if latest_scan else 0,
            map_valid=bool(validated_map), tf_fresh=tf_fresh,
            nav2_ready=action.server_is_ready(),
            observed_topics=topics, publisher_counts=publishers)

    def record_graph_snapshot():
        snapshot = graph_snapshot()
        report['graph'] = snapshot
        save_report(report, args.report)
        print('ROS graph snapshot:', json.dumps({
            'missing': snapshot['missing'], 'publishers': snapshot['publishers'],
            'observed_topics': snapshot['observed_topics'],
            'hints': snapshot['hints']}, ensure_ascii=False), flush=True)
        return snapshot

    def spin_until(predicate, timeout, *, stage):
        deadline = time.monotonic() + timeout
        next_snapshot = time.monotonic() + 15
        while rclpy.ok() and time.monotonic() < deadline:
            rclpy.spin_once(node, timeout_sec=0.1)
            if predicate():
                return
            if stage == 'ROS_GRAPH' and time.monotonic() >= next_snapshot:
                record_graph_snapshot()
                next_snapshot = time.monotonic() + 15
        if stage == 'ROS_GRAPH':
            record_graph_snapshot()
        raise RuntimeError(f'{stage}_TIMEOUT')

    def current_tf_pose():
        try:
            transform = tf_buffer.lookup_transform('map', 'base_link', Time())
            stamp = transform.header.stamp.sec * 1_000_000_000 + transform.header.stamp.nanosec
            # TF from before the current simulation epoch is not acceptable evidence.
            now = node.get_clock().now().nanoseconds
            fresh = stamp > 0 and now >= stamp and now - stamp < 2_000_000_000
            p = transform.transform.translation
            return (p.x, p.y), fresh
        except Exception:
            return None, False

    def graph_is_ready():
        poses = current_tf_pose()
        ready = bool(action.server_is_ready() and poses[1] and len(clock_times) >= 2
                     and len(latest_odom) >= 2 and latest_scan and len(latest_scan[-1].ranges) >= 10 and validated_map)
        if ready:
            try:
                verify_graph(seen, frames, True, clock_times[-1] > clock_times[0])
                return True
            except ValueError:
                return False
        return False

    def navigator_is_active():
        return navigator_gate.poll(
            now=time.monotonic(),
            service_ready=navigator_state_client.service_is_ready(),
            action_ready=action.server_is_ready(),
            request_state=lambda: navigator_state_client.call_async(GetState.Request()))

    def require_active_navigator():
        # Requery ACTIVE before every navigation leg. A static sleep or only
        # server_is_ready() may race with Nav2's configure -> activate cycle.
        try:
            spin_until(navigator_is_active, min(args.timeout, 120),
                       stage='NAV2_LIFECYCLE_ACTIVE')
        finally:
            report['nav2_lifecycle'] = navigator_gate.snapshot()
            save_report(report, args.report)
        if 'bt_navigator_lifecycle_active' not in report['checks']:
            report['checks'].append('bt_navigator_lifecycle_active')
            save_report(report, args.report)
        print('Nav2 bt_navigator ACTIVE; goal submission permitted', flush=True)

    def run_goal(goal):
        require_active_navigator()
        start = time.monotonic()
        initial_tf, _ = current_tf_pose()
        if initial_tf is None:
            raise RuntimeError('INITIAL_TF_MISSING')
        start_dist = math.hypot(initial_tf[0] - goal.x, initial_tf[1] - goal.y)
        odom_movement = {'length': 0.0, 'last': None}

        # Already localized to the same map; goal is sent only to Gazebo's Nav2.
        nav_goal = NavigateToPose.Goal()
        nav_goal.pose = PoseStamped()
        nav_goal.pose.header.frame_id = 'map'
        nav_goal.pose.header.stamp = node.get_clock().now().to_msg()
        nav_goal.pose.pose.position.x = goal.x
        nav_goal.pose.pose.position.y = goal.y
        nav_goal.pose.pose.orientation.w = 1.0
        feedback = {'count': 0}

        def handle_feedback(data):
            fb = data.feedback
            if math.isfinite(fb.distance_remaining) and fb.distance_remaining >= 0:
                feedback['count'] += 1

        request = action.send_goal_async(nav_goal, feedback_callback=handle_feedback)
        spin_until(lambda: request.done(), 10, stage='NAV2_GOAL_SUBMISSION')
        handle = request.result()
        if not handle or not handle.accepted:
            # A goal rejected after an ACTIVE lifecycle response is a
            # separate Nav2 fault, not a reason to blindly retry.
            report['nav2_lifecycle'] = navigator_gate.snapshot()
            save_report(report, args.report)
            raise RuntimeError('NAV2_GOAL_REJECTED')
        result = handle.get_result_async()
        deadline = time.monotonic() + args.goal_timeout
        while rclpy.ok() and time.monotonic() < deadline and not result.done():
            rclpy.spin_once(node, timeout_sec=0.1)
            if latest_odom:
                p = latest_odom[-1].pose.pose.position
                point = (p.x, p.y)
                if odom_movement['last'] is not None:
                    delta = math.hypot(point[0] - odom_movement['last'][0], point[1] - odom_movement['last'][1])
                    if delta > 0.5:
                        raise RuntimeError('ODOMETRY_DISCONTINUITY')
                    odom_movement['length'] += delta
                odom_movement['last'] = point
        if not result.done():
            cancellation = handle.cancel_goal_async()
            cancel_deadline = time.monotonic() + 4
            while rclpy.ok() and time.monotonic() < cancel_deadline and not cancellation.done():
                rclpy.spin_once(node, timeout_sec=0.1)
            raise RuntimeError('NAV2_GOAL_TIMEOUT_CANCEL_' + ('ACKNOWLEDGED' if cancellation.done() else 'UNCONFIRMED'))
        response = result.result()
        status = 'SUCCEEDED' if response.status == GoalStatus.STATUS_SUCCEEDED else f'STATUS_{response.status}'
        # Wait for a genuinely fresh map->base_link TF, independent of Action result.
        pose, fresh = current_tf_pose()
        if not fresh:
            spin_until(lambda: current_tf_pose()[1], 3, stage='FRESH_TF')
            pose, fresh = current_tf_pose()
        leg = summarize_leg(goal, pose, status=status, feedback_count=feedback['count'],
                            tf_fresh=fresh, odom_distance_m=odom_movement['length'],
                            start_distance_m=start_dist, elapsed=time.monotonic() - start)
        report['legs'].append(leg)
        save_report(report, args.report)
        print(f"Verified {goal.name}: position error {leg['position_error_m']}m, odom travel {leg['odom_distance_m']}m, feedback {leg['feedback_count']}", flush=True)

    try:
        spin_until(graph_is_ready, args.timeout, stage='ROS_GRAPH')
        verify_graph(seen, frames, True, clock_times[-1] > clock_times[0])
        # Store positive graph evidence as well as failure diagnostics.
        report['graph'] = graph_snapshot()
        report['checks'].append('clock_scan_odom_map_tf_nav2_ready')
        report['initial_pose'] = list(current_tf_pose()[0])
        save_report(report, args.report)
        print('ROS graph ready with advancing clock, fresh map TF, laser, odom, map and NavigateToPose', flush=True)
        goals = ACCEPTANCE_ROUTE if args.route else (DESK,) if args.navigate else ()
        for goal in goals:
            run_goal(goal)
        report['status'] = 'passed'
        return 0
    except Exception as exc:
        report['status'] = 'failed'
        report['error'] = str(exc)
        print('ROS acceptance FAILED:', exc, flush=True)
        return 1
    finally:
        save_report(report, args.report)
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    raise SystemExit(main())
