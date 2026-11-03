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


def send(payload):
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    if os.environ.get("ALEX_ROS_SIMULATION_ONLY") != "1":
        raise RuntimeError("ROS2_SIMULATION_ONLY_FLAG_REQUIRED")
    raw = sys.stdin.readline()
    request = json.loads(raw)
    goal = request.get("goal")
    if request.get("type") != "navigate" or not isinstance(goal, dict):
        raise ValueError("INVALID_GOAL")
    if goal.get("frame_id") != "map" or goal.get("destination") not in (
        "dock", "study_desk", "sofa", "story_corner"
    ):
        raise ValueError("INVALID_GOAL")
    if any(not isinstance(goal.get(n), (int, float)) or not math.isfinite(goal[n])
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
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline and not clock_seen.is_set() and not cancelled.is_set():
            rclpy.spin_once(node, timeout_sec=0.1)
        if not clock_seen.is_set():
            send({"type": "result", "status": "failed", "reason": "SIMULATION_CLOCK_MISSING"})
            return 2
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline and not action.wait_for_server(timeout_sec=0.2):
            if cancelled.is_set():
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
        send({"type": "ready"})

        def feedback(msg):
            fb = msg.feedback
            p = fb.current_pose.pose
            yaw = math.atan2(2 * (p.orientation.w * p.orientation.z + p.orientation.x * p.orientation.y),
                             1 - 2 * (p.orientation.y ** 2 + p.orientation.z ** 2))
            send({"type": "feedback", "distance_remaining": float(fb.distance_remaining),
                  "pose": {"x": float(p.position.x), "y": float(p.position.y), "yaw": yaw}})

        future = action.send_goal_async(request, feedback_callback=feedback)
        while rclpy.ok() and not future.done():
            rclpy.spin_once(node, timeout_sec=0.05)
        goal_handle = future.result()
        if not goal_handle or not goal_handle.accepted:
            send({"type": "result", "status": "rejected", "reason": "NAV2_GOAL_REJECTED"})
            return 1
        result = goal_handle.get_result_async()
        cancel_sent = False
        cancel_future = None
        cancel_deadline = None
        while rclpy.ok() and not result.done():
            if cancelled.is_set() and not cancel_sent:
                cancel_future = goal_handle.cancel_goal_async()
                cancel_sent = True
                cancel_deadline = time.monotonic() + 3
            if cancel_sent and time.monotonic() > cancel_deadline:
                send({"type": "result", "status": "failed", "reason": "NAV2_CANCEL_UNCONFIRMED"})
                return 2
            rclpy.spin_once(node, timeout_sec=0.05)
        if not result.done():
            send({"type": "result", "status": "failed", "reason": "NAV2_DISCONNECTED"})
            return 2
        output = result.result()
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
