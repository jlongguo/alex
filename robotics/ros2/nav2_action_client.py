#!/usr/bin/env python3
"""Experimental ROS 2 Jazzy Nav2 *simulation-only* action client.

One goal per subprocess. JSON-lines over stdin/stdout; no raw Twist or GPIO access.
Requires a published /clock, a Nav2 NavigateToPose action server, and a
Gazebo simulation that uses the same 0.1m grid/map origin as Alex.
This is NOT a safety-certified stop controller, nor suitable for real robots.
"""
import json
import math
import os
import sys
import threading
import time


# 所有 Action 阶段必须有界；未确认取消不能报告为已停止。
CLOCK_WAIT_SECONDS = 8.0
ACTION_READY_WAIT_SECONDS = 8.0
GOAL_RESPONSE_WAIT_SECONDS = 8.0
GOAL_RESULT_WAIT_SECONDS = 75.0
CANCEL_CONFIRM_WAIT_SECONDS = 3.0


def send(payload):
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    if os.environ.get("ALEX_ROS_SIMULATION_ONLY") != "1":
        raise RuntimeError("ROS2_SIMULATION_ONLY_FLAG_REQUIRED")
    # 直接执行 Python 同样不得接入可发现实体设备的 ROS DDS 域。
    if (os.environ.get("ROS_DISTRO") != "jazzy"
            or os.environ.get("ROS_DOMAIN_ID") != "77"
            or os.environ.get("ROS_AUTOMATIC_DISCOVERY_RANGE") != "LOCALHOST"):
        raise RuntimeError("NAV2_ACTION_REQUIRES_ISOLATED_JAZZY_DOMAIN")
    raw = sys.stdin.readline()
    request = json.loads(raw)
    goal = request.get("goal")
    if request.get("type") != "navigate" or not isinstance(goal, dict):
        raise ValueError("INVALID_GOAL")
    if goal.get("frame_id") != "map" or goal.get("destination") not in (
        "dock", "study_desk", "sofa", "story_corner"
    ):
        raise ValueError("INVALID_GOAL")
    if any(type(goal.get(n)) not in (int, float) or not math.isfinite(goal[n])
           for n in ("x", "y", "yaw")):
        raise ValueError("INVALID_GOAL")

    import rclpy
    from action_msgs.msg import GoalStatus
    from nav2_msgs.action import NavigateToPose
    from rclpy.action import ActionClient
    from geometry_msgs.msg import PoseStamped
    from rosgraph_msgs.msg import Clock

    cancelled = threading.Event()

    def watch_stdin():
        for line in sys.stdin:
            try:
                if json.loads(line).get("type") == "cancel":
                    cancelled.set()
                    return
            except (ValueError, AttributeError):
                continue
        cancelled.set()  # Treat a lost parent as cancellation.

    threading.Thread(target=watch_stdin, daemon=True).start()
    rclpy.init()
    node = rclpy.create_node("alex_nav2_sim_action_client")
    clock_seen = threading.Event()
    sub = node.create_subscription(Clock, "/clock", lambda _: clock_seen.set(), 10)
    action = ActionClient(node, NavigateToPose, "/navigate_to_pose")
    try:
        deadline = time.monotonic() + CLOCK_WAIT_SECONDS
        while rclpy.ok() and time.monotonic() < deadline and not clock_seen.is_set() and not cancelled.is_set():
            rclpy.spin_once(node, timeout_sec=0.1)
        if cancelled.is_set():
            send({"type": "result", "status": "cancelled", "reason": "NAV2_CANCEL_BEFORE_GOAL"})
            return 1
        if not clock_seen.is_set():
            send({"type": "result", "status": "failed", "reason": "SIMULATION_CLOCK_MISSING"})
            return 2
        deadline = time.monotonic() + ACTION_READY_WAIT_SECONDS
        while rclpy.ok() and time.monotonic() < deadline and not action.server_is_ready() and not cancelled.is_set():
            action.wait_for_server(timeout_sec=0.2)
        if cancelled.is_set():
            send({"type": "result", "status": "cancelled", "reason": "NAV2_CANCEL_BEFORE_GOAL"})
            return 1
        if not action.server_is_ready():
            send({"type": "result", "status": "failed", "reason": "NAV2_ACTION_UNAVAILABLE"})
            return 2
        pose = PoseStamped()
        pose.header.frame_id = "map"
        pose.header.stamp = node.get_clock().now().to_msg()
        pose.pose.position.x = float(goal["x"])
        pose.pose.position.y = float(goal["y"])
        pose.pose.orientation.z = math.sin(float(goal["yaw"]) / 2)
        pose.pose.orientation.w = math.cos(float(goal["yaw"]) / 2)
        request = NavigateToPose.Goal()
        request.pose = pose
        request.behavior_tree = ""  # Default trusted Nav2 tree; never model-supplied.
        if cancelled.is_set():
            send({"type": "result", "status": "cancelled", "reason": "NAV2_CANCEL_BEFORE_GOAL"})
            return 1
        send({"type": "ready"})

        def feedback(msg):
            fb = msg.feedback
            p = fb.current_pose.pose
            yaw = math.atan2(2 * (p.orientation.w * p.orientation.z + p.orientation.x * p.orientation.y),
                             1 - 2 * (p.orientation.y ** 2 + p.orientation.z ** 2))
            send({"type": "feedback", "distance_remaining": float(fb.distance_remaining),
                  "pose": {"x": float(p.position.x), "y": float(p.position.y), "yaw": yaw}})

        future = action.send_goal_async(request, feedback_callback=feedback)
        # 可能已送达 Nav2，但 future 永久无响应；必须报告状态未知，不能谎报取消。
        deadline = time.monotonic() + GOAL_RESPONSE_WAIT_SECONDS
        while rclpy.ok() and not future.done() and time.monotonic() < deadline:
            rclpy.spin_once(node, timeout_sec=0.05)
        if not future.done():
            send({"type": "result", "status": "failed", "reason": "NAV2_GOAL_SUBMISSION_UNCONFIRMED"})
            return 2
        goal_handle = future.result()
        if not goal_handle or not goal_handle.accepted:
            send({"type": "result", "status": "rejected", "reason": "NAV2_GOAL_REJECTED"})
            return 1
        result = goal_handle.get_result_async()
        cancel_sent = False
        cancel_future = None
        cancel_deadline = None
        cancel_confirmed = False
        goal_deadline = time.monotonic() + GOAL_RESULT_WAIT_SECONDS
        timed_out = False
        while rclpy.ok() and not result.done():
            if time.monotonic() >= goal_deadline:
                timed_out = True
                cancelled.set()
            if cancelled.is_set() and not cancel_sent:
                cancel_future = goal_handle.cancel_goal_async()
                cancel_sent = True
                cancel_deadline = time.monotonic() + CANCEL_CONFIRM_WAIT_SECONDS
            if cancel_sent:
                if cancel_future.done() and not cancel_confirmed:
                    ack = cancel_future.result()
                    if (ack is None or getattr(ack, "return_code", None) != 0
                            or not getattr(ack, "goals_canceling", None)):
                        send({"type": "result", "status": "failed", "reason": "NAV2_CANCEL_NOT_ACKNOWLEDGED"})
                        return 2
                    cancel_confirmed = True
                if time.monotonic() >= cancel_deadline:
                    send({"type": "result", "status": "failed", "reason": "NAV2_CANCEL_UNCONFIRMED"})
                    return 2
            rclpy.spin_once(node, timeout_sec=0.05)
        if not result.done():
            send({"type": "result", "status": "failed", "reason": "NAV2_DISCONNECTED"})
            return 2
        # 结果先于 ACK 到达也必须等待有界确认，不依赖“发出取消请求”推断停止。
        if cancelled.is_set() and not cancel_sent:
            send({"type": "result", "status": "failed", "reason": "NAV2_COMPLETED_AFTER_CANCELLATION"})
            return 2
        if cancel_sent and not cancel_confirmed:
            while (rclpy.ok() and not cancel_future.done()
                   and time.monotonic() < cancel_deadline):
                rclpy.spin_once(node, timeout_sec=0.05)
            if not cancel_future.done():
                send({"type": "result", "status": "failed", "reason": "NAV2_CANCEL_UNCONFIRMED"})
                return 2
            ack = cancel_future.result()
            if (ack is None or getattr(ack, "return_code", None) != 0
                    or not getattr(ack, "goals_canceling", None)):
                send({"type": "result", "status": "failed", "reason": "NAV2_CANCEL_NOT_ACKNOWLEDGED"})
                return 2
            cancel_confirmed = True
        output = result.result()
        if cancel_sent:
            if output.status != GoalStatus.STATUS_CANCELED:
                send({"type": "result", "status": "failed", "reason": "NAV2_CANCEL_TERMINAL_NOT_CANCELED"})
                return 2
            if timed_out:
                send({"type": "result", "status": "failed", "reason": "NAV2_GOAL_TIMEOUT_CANCELLED"})
                return 2
            send({"type": "result", "status": "cancelled"})
            return 0
        if output.status == GoalStatus.STATUS_CANCELED:
            send({"type": "result", "status": "cancelled"})
        elif output.status == GoalStatus.STATUS_SUCCEEDED and getattr(output.result, "error_code", 0) == 0:
            send({"type": "result", "status": "succeeded"})
        else:
            send({"type": "result", "status": "failed", "reason": "NAV2_ACTION_FAILED"})
        return 0
    finally:
        node.destroy_subscription(sub)
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        send({"type": "result", "status": "failed", "reason": type(error).__name__})
        sys.exit(2)
