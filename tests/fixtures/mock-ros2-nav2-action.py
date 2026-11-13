#!/usr/bin/env python3
"""仅用于 R61 离线回归：伪造 rclpy/Nav2 接口，不加载 ROS、不发送网络请求。

运行目标是实际 Python Action 客户端源码，不是对客户端逻辑的重新实现。
"""
import json
import os
from pathlib import Path
import sys
import threading
import time
from types import ModuleType, SimpleNamespace as NS

SCENARIO = sys.argv[1] if len(sys.argv) > 1 else 'success'
ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'robotics/ros2/nav2_action_client.py'
state = {
    'ticks': 0,
    'subscription': None,
    'submission_started': False,
    'result_started': False,
    'cancel_sent': False,
    'cancel_at': 0,
}

CANCEL_SCENARIOS = {
    'cancel_early', 'cancel_pending', 'cancel_ack_rejected',
    'cancel_ack_stall', 'cancel_happy', 'late_success',
    'cancel_ack_after_terminal', 'result_before_ack_reject'
}
RESULT_STALL = {'result_stall', 'cancel_ack_stall', 'cancel_ack_rejected'}
CANCEL_RESULT = {
    'cancel_happy', 'cancel_pending', 'cancel_ack_after_terminal',
    'result_before_ack_reject', 'cancel_ack_rejected'
}


class InputFeed:
    def readline(self):
        return json.dumps({
            'type': 'navigate',
            'goal': {'destination': 'study_desk', 'frame_id': 'map',
                     'x': 1.7, 'y': 1.6, 'yaw': 0.0}
        }) + '\n'

    def __iter__(self):
        if SCENARIO in CANCEL_SCENARIOS:
            stage = ('submission_started' if SCENARIO == 'cancel_pending'
                     else 'result_started' if SCENARIO != 'cancel_early' else None)
            while stage is not None and not state[stage]:
                time.sleep(0.001)
            if stage is None:
                while state['ticks'] < 1:
                    time.sleep(0.001)
            yield '{"type":"cancel"}\n'
        # 维持父进程输入开启；否则 EOF 会触发被测客户端的取消语义。
        while True:
            time.sleep(0.05)


class Future:
    def __init__(self, kind):
        self.kind = kind
        self.start = state['ticks']

    def done(self):
        delta = state['ticks'] - self.start
        if self.kind == 'submission':
            return SCENARIO != 'goal_stall' and delta >= (
                8 if SCENARIO == 'cancel_pending' else 2)
        if self.kind == 'cancel_ack':
            return SCENARIO not in ('cancel_ack_stall', 'cancel_ack_after_terminal') and delta >= (
                3 if SCENARIO == 'result_before_ack_reject' else 1)
        if self.kind == 'result':
            if SCENARIO in RESULT_STALL:
                return False
            if SCENARIO == 'result_stall':
                return state['cancel_sent'] and delta >= 4
            if SCENARIO in CANCEL_SCENARIOS:
                return state['cancel_sent'] and delta >= (
                    1 if SCENARIO in ('cancel_ack_after_terminal', 'result_before_ack_reject')
                    else 5)
            return delta >= 3
        raise ValueError(self.kind)

    def result(self):
        if self.kind == 'submission':
            return StubGoalHandle(accepted=SCENARIO != 'goal_rejected')
        if self.kind == 'cancel_ack':
            rejected = SCENARIO in ('cancel_ack_rejected', 'result_before_ack_reject')
            return NS(return_code=1 if rejected else 0,
                      goals_canceling=[] if rejected else [NS(goal_id='test')])
        if self.kind == 'result':
            status = (
                6 if SCENARIO == 'action_failed'
                else 4 if SCENARIO in ('late_success', 'success')
                else 5
            )
            return NS(status=status, result=NS(error_code=0))
        raise ValueError(self.kind)


class StubGoalHandle:
    def __init__(self, accepted):
        self.accepted = accepted

    def get_result_async(self):
        state['result_started'] = True
        return Future('result')

    def cancel_goal_async(self):
        state['cancel_sent'] = True
        state['cancel_at'] = state['ticks']
        return Future('cancel_ack')


class StubActionClient:
    def __init__(self, _node, _action_type, _name):
        self.ready = SCENARIO != 'action_missing'

    def wait_for_server(self, timeout_sec):
        time.sleep(min(timeout_sec, 0.01))
        return self.ready

    def server_is_ready(self):
        return self.ready

    def send_goal_async(self, _request, feedback_callback):
        state['submission_started'] = True
        return Future('submission')


class StubNode:
    def create_subscription(self, _cls, _name, callback, _depth):
        state['subscription'] = callback
        return object()

    def get_clock(self):
        return NS(now=lambda: NS(to_msg=lambda: NS()))

    def destroy_subscription(self, _subscription):
        return None

    def destroy_node(self):
        return None


def spin_once(_node, timeout_sec=0.1):
    state['ticks'] += 1
    time.sleep(0.005)
    if SCENARIO != 'clock_missing' and state['subscription'] is not None:
        state['subscription'](None)
    if SCENARIO == 'ros_disconnected' and state['ticks'] >= 9:
        state['shutdown'] = True


def make_module(name, **values):
    module = ModuleType(name)
    for key, value in values.items():
        setattr(module, key, value)
    sys.modules[name] = module
    return module


make_module('rclpy', init=lambda: None, create_node=lambda _name: StubNode(),
            spin_once=spin_once, ok=lambda: not state.get('shutdown', False),
            shutdown=lambda: None)
make_module('action_msgs')
make_module('action_msgs.msg', GoalStatus=NS(
    STATUS_CANCELED=5, STATUS_SUCCEEDED=4, STATUS_ABORTED=6))
make_module('nav2_msgs')
make_module('nav2_msgs.action', NavigateToPose=NS(Goal=type('Goal', (), {
    '__init__': lambda self: setattr(self, 'pose', None)
})))
make_module('rclpy.action', ActionClient=StubActionClient)


class PoseStamped:
    def __init__(self):
        self.header = NS(frame_id=None, stamp=None)
        self.pose = NS(position=NS(x=0.0, y=0.0),
                       orientation=NS(z=0.0, w=1.0))


make_module('geometry_msgs')
make_module('geometry_msgs.msg', PoseStamped=PoseStamped)
make_module('rosgraph_msgs')
make_module('rosgraph_msgs.msg', Clock=type('Clock', (), {}))

# exec() 避免运行源码的 __main__ 异常处理器，让 Python 回归能核查实际返回码。
namespace = {'__name__': 'nav2_action_offline_fixture', '__file__': str(SOURCE)}
exec(compile(SOURCE.read_text(encoding='utf8'), str(SOURCE), 'exec'), namespace)
namespace['CLOCK_WAIT_SECONDS'] = 0.075
namespace['ACTION_READY_WAIT_SECONDS'] = 0.075
namespace['GOAL_RESPONSE_WAIT_SECONDS'] = 0.09
namespace['GOAL_RESULT_WAIT_SECONDS'] = 0.12
namespace['CANCEL_CONFIRM_WAIT_SECONDS'] = 0.09

if SCENARIO == 'wrong_domain':
    os.environ['ROS_DOMAIN_ID'] = '0'
else:
    os.environ['ROS_DOMAIN_ID'] = '77'
os.environ['ALEX_ROS_SIMULATION_ONLY'] = '1'
os.environ['ROS_DISTRO'] = 'jazzy'
os.environ['ROS_AUTOMATIC_DISCOVERY_RANGE'] = 'LOCALHOST'
sys.stdin = InputFeed()

try:
    code = namespace['main']()
except Exception as exc:
    # 仅输出异常类型；不回显环境值或任意原始数据。
    print(json.dumps({'type': 'result', 'status': 'exception',
                      'reason': type(exc).__name__}))
    code = 88
sys.exit(code)
