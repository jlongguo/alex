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
    modes.add_argument('--cancel-probe', action='store_true', help='Live Nav2 cancel and post-cancel stop proof')
    modes.add_argument('--recover-probe', action='store_true', help='Live cancel, re-navigate and return to dock')
    parser.add_argument('--timeout', type=float, default=110.0, help='ROS graph readiness deadline in wall seconds')
    parser.add_argument('--goal-timeout', type=float, default=150.0, help='Per-goal wall time budget')
    parser.add_argument('--report', default='.local/ros/acceptance-report.json')
    args = parser.parse_args()
    if not (10 <= args.timeout <= 600) or not (15 <= args.goal_timeout <= 600):
        raise SystemExit('Invalid acceptance timeouts')
    # 即便绕过封装 Shell 直接调用 Python，取消探针也必须使用本机独立模拟域。
    if (args.cancel_probe or args.recover_probe) and (os.environ.get('ROS_DOMAIN_ID') != '77'
                              or os.environ.get('ROS_AUTOMATIC_DISCOVERY_RANGE') != 'LOCALHOST'):
        raise SystemExit('NAV2_CANCEL_REQUIRES_ISOLATED_SIMULATION_DOMAIN')

    from alex_sim.acceptance import (ACCEPTANCE_ROUTE, DESK, DOCK, summarize_leg,
                                     verify_graph, graph_readiness_snapshot, GRAPH_TOPICS,
                                     goal_arrival_heading)
    import rclpy
    from action_msgs.msg import GoalStatus
    from rclpy.action import ActionClient
    from rclpy.parameter import Parameter
    from rclpy.duration import Duration
    from rclpy.time import Time
    from rosgraph_msgs.msg import Clock
    from sensor_msgs.msg import LaserScan
    from nav_msgs.msg import Odometry, OccupancyGrid, Path as RosPath
    from tf2_msgs.msg import TFMessage
    from tf2_ros import Buffer, TransformListener
    from geometry_msgs.msg import PoseStamped, Twist, PolygonStamped
    from nav2_msgs.action import NavigateToPose
    from nav2_msgs.msg import CollisionMonitorState
    from lifecycle_msgs.srv import GetState
    from alex_sim.nav2_lifecycle import Nav2LifecycleGate
    from alex_sim.gz_pose import query_gz_model_pose
    from rclpy.qos import qos_profile_sensor_data, QoSProfile, DurabilityPolicy, ReliabilityPolicy

    report = {'schema': ('alex.dev/ros-recovery-acceptance/v1' if args.recover_probe
                         else 'alex.dev/ros-cancel-acceptance/v1' if args.cancel_probe
                         else 'alex.dev/ros-acceptance/v1'),
              'mode': ('recover-probe' if args.recover_probe else 'cancel-probe' if args.cancel_probe
                       else 'route' if args.route else 'navigate' if args.navigate else 'graph'),
              'status': 'running', 'legs': [], 'checks': [], 'simulation_only': True,
              'run_id': os.environ.get('ALEX_ROS_ACCEPTANCE_RUN_ID') or __import__('uuid').uuid4().hex}
    if args.cancel_probe or args.recover_probe:
        # 取消与恢复验收只针对 Gazebo 模拟，不构成物理安全或发布认证。
        report['physical_safety_certified'] = False
        report['release_approved'] = False
    save_report(report, args.report)
    rclpy.init()
    node = rclpy.create_node('alex_ros_sim_acceptance', parameter_overrides=[Parameter('use_sim_time', value=True)])
    seen, frames = set(), set()
    clock_times = []
    latest_odom = []
    latest_scan = []
    latest_footprint = []
    validated_map = []
    # Record active collision intervention and the latest global replan.
    # These subscriptions observe state only and never command the robot.
    collision_state = {'messages': 0, 'last': None, 'transitions': []}
    planned_path = {'messages': 0, 'poses': 0, 'start': None, 'end': None,
                    'frame_id': None}

    def collision_state_received(message):
        observed = {'action_type': int(message.action_type),
                    'polygon_name': str(message.polygon_name)}
        collision_state['messages'] += 1
        if collision_state['last'] != observed:
            collision_state['transitions'].append(observed)
            if len(collision_state['transitions']) > 12:
                del collision_state['transitions'][:-12]
        collision_state['last'] = observed

    def plan_received(message):
        planned_path['messages'] += 1
        planned_path['poses'] = len(message.poses)
        planned_path['frame_id'] = message.header.frame_id
        planned_path['start'] = ([round(message.poses[0].pose.position.x, 3),
                                  round(message.poses[0].pose.position.y, 3)]
                                 if message.poses else None)
        planned_path['end'] = ([round(message.poses[-1].pose.position.x, 3),
                                round(message.poses[-1].pose.position.y, 3)]
                               if message.poses else None)

    # Diagnostics only: never publish commands or treat traffic as navigation
    # success. A failed goal must show which part of Nav2's velocity pipeline
    # actually emitted Twist messages into the Gazebo bridge.
    command_topics = ('/cmd_vel_nav', '/cmd_vel_smoothed', '/cmd_vel')
    command_samples = {
        topic: {'messages': 0, 'nonzero_messages': 0,
                'peak_linear_mps': 0.0, 'peak_angular_rps': 0.0,
                'linear_abs_sum_mps': 0.0, 'angular_abs_sum_rps': 0.0}
        for topic in command_topics
    }

    def command_received(topic):
        def callback(message):
            sample = command_samples[topic]
            sample['messages'] += 1
            linear = abs(message.linear.x)
            angular = abs(message.angular.z)
            if math.isfinite(linear):
                sample['peak_linear_mps'] = max(sample['peak_linear_mps'], linear)
                sample['linear_abs_sum_mps'] += linear
            if math.isfinite(angular):
                sample['peak_angular_rps'] = max(sample['peak_angular_rps'], angular)
                sample['angular_abs_sum_rps'] += angular
            if (math.isfinite(linear) and linear > 1e-4) or (math.isfinite(angular) and angular > 1e-4):
                sample['nonzero_messages'] += 1
        return callback

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
        node.create_subscription(CollisionMonitorState, '/collision_monitor_state',
                                 collision_state_received, 10),
        node.create_subscription(RosPath, '/plan', plan_received, 10),
        node.create_subscription(PolygonStamped, '/local_costmap/published_footprint',
                                 received('footprint', latest_footprint), 10),
        *[node.create_subscription(Twist, topic, command_received(topic), 10)
          for topic in command_topics],
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

    def current_tf_heading():
        # A 2D x/y trace cannot distinguish a stopped wheelbase from a robot
        # that is spinning in place for two minutes at a narrow portal.
        try:
            q = tf_buffer.lookup_transform('map', 'base_link', Time()).transform.rotation
            return round(math.atan2(2 * (q.w * q.z + q.x * q.y),
                                    1 - 2 * (q.y * q.y + q.z * q.z)), 3)
        except Exception:
            return None

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

    def last_scan_clearance():
        # Check what the collision monitor's /scan source can actually see
        # near a stalled goal. Report in the robot base frame, not laser frame.
        if not latest_scan:
            return {'available': False, 'reason': 'no_laser_scan'}
        scan = latest_scan[-1]
        evidence = {'available': False, 'frame_id': scan.header.frame_id,
                    'valid_ranges': 0, 'points_inside_0_19m': None,
                    'min_base_range_m': None}
        try:
            transform = tf_buffer.lookup_transform('base_link', scan.header.frame_id, Time())
            q = transform.transform.rotation
            yaw = math.atan2(2 * (q.w * q.z + q.x * q.y),
                             1 - 2 * (q.y * q.y + q.z * q.z))
            sn, cs = math.sin(yaw), math.cos(yaw)
            tx, ty = transform.transform.translation.x, transform.transform.translation.y
            best, inside, count = math.inf, 0, 0
            for i, distance in enumerate(scan.ranges):
                if not math.isfinite(distance) or not (scan.range_min <= distance <= scan.range_max):
                    continue
                angle = scan.angle_min + i * scan.angle_increment
                x, y = distance * math.cos(angle), distance * math.sin(angle)
                bx, by = tx + cs * x - sn * y, ty + sn * x + cs * y
                radial = math.hypot(bx, by)
                best = min(best, radial)
                count += 1
                if radial <= 0.19:
                    inside += 1
            evidence.update(available=True, valid_ranges=count,
                            points_inside_0_19m=inside,
                            min_base_range_m=round(best, 3) if count else None)
        except Exception as exc:
            evidence['reason'] = type(exc).__name__
        return evidence

    def last_footprint_geometry():
        if not latest_footprint:
            return {'available': False}
        poly = latest_footprint[-1]
        evidence = {'available': True, 'frame_id': poly.header.frame_id,
                    'vertices': len(poly.polygon.points), 'max_base_radius_m': None}
        try:
            transform = tf_buffer.lookup_transform('base_link', poly.header.frame_id, Time())
            q = transform.transform.rotation
            yaw = math.atan2(2 * (q.w * q.z + q.x * q.y),
                             1 - 2 * (q.y * q.y + q.z * q.z))
            sn, cs = math.sin(yaw), math.cos(yaw)
            tx, ty = transform.transform.translation.x, transform.transform.translation.y
            radii = [math.hypot(tx + cs*p.x - sn*p.y, ty + sn*p.x + cs*p.y)
                     for p in poly.polygon.points]
            if radii:
                evidence['max_base_radius_m'] = round(max(radii), 3)
        except Exception as exc:
            evidence['reason'] = type(exc).__name__
        return evidence

    def run_cancel_probe():
        """真实 Gazebo 的取消验收；必须同时证明取消终态与停止后位移。

        只发送 Nav2 Action 目标/取消，不直接控制速度或电机。
        """
        require_active_navigator()
        pose, fresh = current_tf_pose()
        if not fresh or pose is None:
            raise RuntimeError('NAV2_CANCEL_INITIAL_TF_UNAVAILABLE')
        if math.hypot(DESK.x - pose[0], DESK.y - pose[1]) < 0.5:
            raise RuntimeError('NAV2_CANCEL_GOAL_TOO_CLOSE')
        _, qz, qw = goal_arrival_heading(pose, DESK)
        nav_goal = NavigateToPose.Goal()
        nav_goal.pose = PoseStamped()
        nav_goal.pose.header.frame_id = 'map'
        nav_goal.pose.header.stamp = node.get_clock().now().to_msg()
        nav_goal.pose.pose.position.x = DESK.x
        nav_goal.pose.pose.position.y = DESK.y
        nav_goal.pose.pose.orientation.z = qz
        nav_goal.pose.pose.orientation.w = qw
        evidence = {
            'goal': DESK.name, 'goal_accepted': False,
            'cancel_request_sent': False, 'cancel_acknowledged': False,
            'terminal_status': None, 'tf_fresh': False,
            'odom_advanced': False, 'position_drift_m': None,
            'observation_seconds': None, 'nonzero_velocity_commands': None,
        }
        report['cancel'] = evidence
        save_report(report, args.report)
        handle = None
        cancel_attempted = False
        try:
            submission = action.send_goal_async(nav_goal)
            spin_until(lambda: submission.done(), 10, stage='NAV2_CANCEL_SUBMISSION')
            handle = submission.result()
            if handle is None or not handle.accepted:
                raise RuntimeError('NAV2_CANCEL_GOAL_REJECTED')
            evidence['goal_accepted'] = True
            result = handle.get_result_async()
            # 从已接受的 Nav2 Action 发出真实 cancel_goal_async 请求。
            # 拒绝仅凭调用成功或 future.done() 就判定取消已生效。
            cancel_attempted = True
            cancellation = handle.cancel_goal_async()
            evidence['cancel_request_sent'] = True
            save_report(report, args.report)
            spin_until(lambda: cancellation.done(), 5, stage='NAV2_CANCEL_ACK')
            response = cancellation.result()
            if (response is None or response.return_code != 0
                    or len(response.goals_canceling) == 0):
                raise RuntimeError('NAV2_CANCEL_NOT_ACKNOWLEDGED')
            evidence['cancel_acknowledged'] = True
            report['checks'].append('nav2_cancel_acknowledged')
            save_report(report, args.report)
            spin_until(lambda: result.done(), 12, stage='NAV2_CANCEL_TERMINAL')
            terminal = result.result()
            if terminal is None or terminal.status != GoalStatus.STATUS_CANCELED:
                raise RuntimeError('NAV2_CANCEL_TERMINAL_NOT_CANCELED')
            evidence['terminal_status'] = 'CANCELED'
            report['checks'].append('nav2_cancel_terminal')
            save_report(report, args.report)

            # 取消确认之后给予控制管线短暂消退时间；随后观察独立 TF、
            # odom 时间戳和 cmd_vel 订阅，拒绝仅凭 Action 状态声称机器人已停。
            settle_deadline = time.monotonic() + 0.4
            spin_until(lambda: time.monotonic() >= settle_deadline, 1.0,
                       stage='NAV2_CANCEL_SETTLE')
            before, fresh = current_tf_pose()
            if before is None or not fresh or not latest_odom:
                raise RuntimeError('NAV2_CANCEL_STOP_OBSERVATION_UNAVAILABLE')
            odom_stamp = latest_odom[-1].header.stamp
            odom_ns = odom_stamp.sec * 1_000_000_000 + odom_stamp.nanosec
            nonzero_before = sum(
                sample['nonzero_messages'] for sample in command_samples.values())
            start = time.monotonic()
            before_clock = clock_times[-1]
            spin_until(lambda: time.monotonic() - start >= 1.5, 2.5,
                       stage='NAV2_CANCEL_STOP_WINDOW')
            after, fresh = current_tf_pose()
            if after is None or not fresh or not latest_odom:
                raise RuntimeError('NAV2_CANCEL_FINAL_TF_UNAVAILABLE')
            latest_stamp = latest_odom[-1].header.stamp
            latest_odom_ns = latest_stamp.sec * 1_000_000_000 + latest_stamp.nanosec
            delta = math.hypot(after[0] - before[0], after[1] - before[1])
            nonzero_after = sum(
                sample['nonzero_messages'] for sample in command_samples.values())
            evidence.update(
                tf_fresh=True,
                odom_advanced=latest_odom_ns > odom_ns,
                position_drift_m=round(delta, 4),
                observation_seconds=round(time.monotonic() - start, 3),
                nonzero_velocity_commands=nonzero_after - nonzero_before,
            )
            save_report(report, args.report)
            if (not evidence['odom_advanced'] or clock_times[-1] <= before_clock
                    or delta > 0.08 or evidence['nonzero_velocity_commands'] != 0):
                raise RuntimeError('NAV2_CANCEL_STOP_NOT_VERIFIED')
            report['checks'].append('post_cancel_stop_observed')
            save_report(report, args.report)
        finally:
            # 正常通过时终态已取消；异常路径仍尽力撤销可能在途的目标。
            # 子进程清理与 Gazebo 进程组回收由外层验收脚本负责。
            if handle is not None and handle.accepted and not cancel_attempted:
                try:
                    handle.cancel_goal_async()
                except Exception as exc:
                    report['cancel_cleanup_error'] = type(exc).__name__
                    save_report(report, args.report)

    def run_goal(goal):
        require_active_navigator()
        # Probe Gazebo's actual 6-DoF model pose before each leg. Map TF and
        # DiffDrive odometry alone are not sufficient to identify a tipped
        # physical chassis after stopping at furniture.
        gazebo_pose_before_goal = query_gz_model_pose()
        start = time.monotonic()
        start_sim_ns = node.get_clock().now().nanoseconds
        position_trace = []
        next_pose_sample = start
        command_window_start = {topic: {'messages': 0, 'nonzero_messages': 0,
                                        'linear_abs_sum_mps': 0.0,
                                        'angular_abs_sum_rps': 0.0}
                                for topic in command_topics}
        initial_tf, _ = current_tf_pose()
        if initial_tf is None:
            raise RuntimeError('INITIAL_TF_MISSING')
        start_dist = math.hypot(initial_tf[0] - goal.x, initial_tf[1] - goal.y)
        requested_yaw, goal_qz, goal_qw = goal_arrival_heading(initial_tf, goal)
        odom_movement = {'length': 0.0, 'last': None}
        for sample in command_samples.values():
            sample.update(messages=0, nonzero_messages=0,
                          peak_linear_mps=0.0, peak_angular_rps=0.0,
                          linear_abs_sum_mps=0.0, angular_abs_sum_rps=0.0)
        collision_state['messages'] = 0
        collision_state['transitions'].clear()
        planned_path.update(messages=0, poses=0, start=None, end=None, frame_id=None)

        def record_goal_diagnostics(status, result_message=None):
            pose, fresh = current_tf_pose()
            wall_seconds = max(0.001, time.monotonic() - start)
            sim_seconds = max(0.0, (
                node.get_clock().now().nanoseconds - start_sim_ns) / 1_000_000_000)
            report['last_goal'] = {
                'goal': goal.name, 'action_status': status,
                'requested_yaw_rad': round(requested_yaw, 4),
                'feedback_count': feedback['count'],
                'distance_remaining_m': feedback['last_remaining_m'],
                'minimum_distance_remaining_m': feedback['minimum_remaining_m'],
                'number_of_recoveries': feedback['number_of_recoveries'],
                'nav2_error_code': getattr(result_message, 'error_code', None),
                'wall_seconds': round(wall_seconds, 2),
                'sim_seconds': round(sim_seconds, 2),
                'sim_real_time_factor': round(sim_seconds / wall_seconds, 3),
                'position_trace': list(position_trace),
                'start_distance_m': round(start_dist, 3),
                'odom_distance_m': round(odom_movement['length'], 3),
                'map_pose': [round(v, 4) for v in pose] if pose else None,
                'tf_fresh': fresh,
                'velocity_pipeline': {
                    topic: {**sample,
                            'mean_abs_linear_mps': round(
                                sample['linear_abs_sum_mps'] / max(1, sample['messages']), 4),
                            'mean_abs_angular_rps': round(
                                sample['angular_abs_sum_rps'] / max(1, sample['messages']), 4)}
                    for topic, sample in command_samples.items()
                },
                'collision_monitor': {
                    'messages': collision_state['messages'],
                    'last': collision_state['last'],
                    'transitions': list(collision_state['transitions']),
                },
                'global_plan': dict(planned_path),
                'laser_clearance': last_scan_clearance(),
                'local_footprint': last_footprint_geometry(),
                'gazebo_pose_before_goal': gazebo_pose_before_goal,
                'gazebo_pose_at_goal_end': query_gz_model_pose(),
            }
            save_report(report, args.report)

        # Already localized to the same map; goal is sent only to Gazebo's Nav2.
        nav_goal = NavigateToPose.Goal()
        nav_goal.pose = PoseStamped()
        nav_goal.pose.header.frame_id = 'map'
        nav_goal.pose.header.stamp = node.get_clock().now().to_msg()
        nav_goal.pose.pose.position.x = goal.x
        nav_goal.pose.pose.position.y = goal.y
        # A heading aligned with the current leg avoids asking the robot
        # to rotate toward arbitrary map +X next to the desk/bookshelf.
        nav_goal.pose.pose.orientation.z = goal_qz
        nav_goal.pose.pose.orientation.w = goal_qw
        feedback = {'count': 0, 'last_remaining_m': None,
                    'minimum_remaining_m': None, 'number_of_recoveries': 0}

        def handle_feedback(data):
            fb = data.feedback
            if math.isfinite(fb.distance_remaining) and fb.distance_remaining >= 0:
                feedback['count'] += 1
                remaining = round(fb.distance_remaining, 3)
                feedback['last_remaining_m'] = remaining
                prev = feedback['minimum_remaining_m']
                feedback['minimum_remaining_m'] = min(prev, remaining) if prev is not None else remaining
                feedback['number_of_recoveries'] = int(fb.number_of_recoveries)

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
            if time.monotonic() >= next_pose_sample:
                pose, fresh = current_tf_pose()
                if pose is not None and fresh:
                    # A small bounded 5-second interval summary shows whether
                    # the stall is zero commanded linear speed, persistent
                    # rotation, or physical non-response to nonzero commands.
                    interval = {}
                    for topic, sample in command_samples.items():
                        previous = command_window_start[topic]
                        count = sample['messages'] - previous['messages']
                        interval[topic] = {
                            'messages': count,
                            'nonzero_messages': (sample['nonzero_messages']
                                                 - previous['nonzero_messages']),
                            'mean_abs_linear_mps': round(
                                (sample['linear_abs_sum_mps']
                                 - previous['linear_abs_sum_mps']) / max(1, count), 4),
                            'mean_abs_angular_rps': round(
                                (sample['angular_abs_sum_rps']
                                 - previous['angular_abs_sum_rps']) / max(1, count), 4),
                        }
                        command_window_start[topic] = {
                            key: sample[key] for key in previous
                        }
                    position_trace.append({
                        'wall_seconds': round(time.monotonic() - start, 1),
                        'x': round(pose[0], 3), 'y': round(pose[1], 3),
                        'heading_rad': current_tf_heading(),
                        'velocity_interval': interval,
                        'distance_remaining_m': feedback['last_remaining_m'],
                        'collision_action': (
                            collision_state['last']['action_type']
                            if collision_state['last'] else None),
                    })
                    del position_trace[:-40]
                next_pose_sample = time.monotonic() + 5.0
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
            record_goal_diagnostics('TIMEOUT')
            cancellation = handle.cancel_goal_async()
            cancel_deadline = time.monotonic() + 4
            while rclpy.ok() and time.monotonic() < cancel_deadline and not cancellation.done():
                rclpy.spin_once(node, timeout_sec=0.1)
            raise RuntimeError('NAV2_GOAL_TIMEOUT_CANCEL_' + ('ACKNOWLEDGED' if cancellation.done() else 'UNCONFIRMED'))
        response = result.result()
        status = 'SUCCEEDED' if response.status == GoalStatus.STATUS_SUCCEEDED else f'STATUS_{response.status}'
        record_goal_diagnostics(status, response.result)
        # Wait for a genuinely fresh map->base_link TF, independent of Action result.
        pose, fresh = current_tf_pose()
        if not fresh:
            spin_until(lambda: current_tf_pose()[1], 3, stage='FRESH_TF')
            pose, fresh = current_tf_pose()
        leg = summarize_leg(goal, pose, status=status, feedback_count=feedback['count'],
                            tf_fresh=fresh, odom_distance_m=odom_movement['length'],
                            start_distance_m=start_dist, elapsed=time.monotonic() - start)
        leg['gazebo_pose_at_arrival'] = query_gz_model_pose()
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
        initial_clearance = last_scan_clearance()
        report['initial_laser_clearance'] = initial_clearance
        if (initial_clearance.get('available')
                and initial_clearance.get('points_inside_0_19m', 0) > 0):
            save_report(report, args.report)
            raise RuntimeError(
                'SIM_LIDAR_SELF_HIT:'
                + str(initial_clearance['points_inside_0_19m'])
                + '_POINTS_INSIDE_ROBOT_RADIUS')
        save_report(report, args.report)
        print('ROS graph ready with advancing clock, fresh map TF, laser, odom, map and NavigateToPose', flush=True)
        goals = ACCEPTANCE_ROUTE if args.route else (DESK,) if args.navigate else ()
        for goal in goals:
            run_goal(goal)
        if args.cancel_probe:
            run_cancel_probe()
        if args.recover_probe:
            # 必须在同一 ROS Node / Nav2 ActionClient / Gazebo 会话内进行恢复，
            # 不能由另一次独立成功的导航报告冒充取消后的恢复能力。
            run_cancel_probe()
            required_cancel = {'nav2_cancel_acknowledged', 'nav2_cancel_terminal',
                               'post_cancel_stop_observed'}
            if not required_cancel.issubset(report['checks']):
                raise RuntimeError('NAV2_RECOVERY_CANCEL_NOT_VERIFIED')
            report['recovery'] = {
                'source': 'same-gazebo-session',
                'cancel_verified': True,
                'recovery_goals': [],
                'return_to_dock_verified': False,
            }
            save_report(report, args.report)
            for index, goal in enumerate((DESK, DOCK)):
                run_goal(goal)
                # run_goal 只有在 Action 成功、fresh TF 和 odom 运动经验证后才返回。
                report['recovery']['recovery_goals'].append(goal.name)
                report['checks'].append(
                    'post_cancel_recovery_desk_verified' if index == 0
                    else 'post_cancel_return_dock_verified')
                save_report(report, args.report)
            report['recovery']['return_to_dock_verified'] = True
            save_report(report, args.report)
        report['status'] = 'passed'
        return 0
    except Exception as exc:
        report['status'] = 'failed'
        report['error'] = str(exc)
        print('ROS acceptance FAILED:', exc, flush=True)
        if 'last_goal' in report:
            print('ROS failed goal diagnostics:',
                  json.dumps(report['last_goal'], ensure_ascii=False, sort_keys=True),
                  flush=True)
        return 1
    finally:
        save_report(report, args.report)
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    raise SystemExit(main())
