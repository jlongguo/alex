#!/usr/bin/env python3
"""ROS-free structural validator. NOT a substitute for running Gazebo or Nav2."""
from pathlib import Path
import re
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parent.parent
pkg = root / 'robotics/ros2/alex_sim'
world = ET.parse(pkg / 'worlds/alex_home.sdf').getroot()
model = ET.parse(pkg / 'models/alex_bot/model.sdf').getroot()
urdf = ET.parse(pkg / 'urdf/alex_bot.urdf').getroot()
package = ET.parse(pkg / 'package.xml').getroot()

assert world.tag == 'sdf' and world.attrib['version'] == '1.9'
assert world.find('./world[@name="alex_home"]') is not None
w = world.find('./world')
assert w.find('./include/uri').text == 'model://alex_bot'
assert w.find('./include/pose').text.split()[:2] == ['0.7', '2.8']
for i in range(8):
    assert w.find(f'./model[@name="wall_{i}"]') is not None
for i in range(4):
    assert w.find(f'./model[@name="furniture_{i}"]') is not None
assert model.find('./model[@name="alex_bot"]') is not None
m = model.find('./model')
assert {'base_link', 'left_wheel', 'right_wheel', 'caster'} <= {x.get('name') for x in m.findall('./link')}
assert {'left_wheel_joint', 'right_wheel_joint'} <= {x.get('name') for x in m.findall('./joint')}
assert m.find('.//sensor[@type="gpu_lidar"]/topic').text == '/scan'
# Harmonic GPU lidar uses <lidar> and <gz_frame_id>, not Classic ray/frame_id.
lidar = m.find('.//sensor[@type="gpu_lidar"]')
assert lidar.find('lidar/scan/horizontal/samples').text == '360'
assert lidar.find('gz_frame_id').text == 'lidar_link'
assert lidar.find('ray') is None

drive = m.find('./plugin[@name="gz::sim::systems::DiffDrive"]')
assert drive is not None
assert drive.find('odom_topic').text == '/odom'
assert drive.find('tf_topic').text == '/tf'
assert drive.find('topic').text == '/cmd_vel'
assert drive.find('frame_id').text == 'odom'
assert drive.find('child_frame_id').text == 'base_link'
assert urdf.tag == 'robot'
links = {x.attrib['name'] for x in urdf.findall('./link')}
assert {'base_link', 'lidar_link'} <= links
assert any(j.find('child').attrib['link'] == 'lidar_link' and j.find('parent').attrib['link'] == 'base_link' for j in urdf.findall('./joint'))
assert package.find('name').text == 'alex_sim'

map_data = (pkg / 'maps/alex_home.pgm').read_text()
values = [line for line in map_data.splitlines() if not line.startswith('#')]
assert values[:3] == ['P2', '60 34', '255']
pixels = [int(x) for line in values[3:] for x in line.split()]
assert len(pixels) == 60 * 34
assert set(pixels) <= {0, 254}
def at(x, y):
    return pixels[(33-y)*60+x]
assert at(7,28) == at(17,16) == at(32,16) == at(49,17) == 254
assert at(0,0) == at(21,2) == at(5,4) == 0
map_yaml = (pkg / 'maps/alex_home.yaml').read_text()
assert re.search(r'^resolution: 0\.1$', map_yaml, re.M)
assert 'origin: [-0.05, -0.05, 0.0]' in map_yaml
bridge = (pkg / 'config/bridge.yaml').read_text()
assert all(f'/'+x in bridge for x in ('clock','scan','odom','tf','cmd_vel'))
assert 'gz_topic_name: /clock' in bridge
assert 'gz_topic_name: /world/alex_home/clock' not in bridge

assert 'ROS_TO_GZ' in bridge and 'GZ_TO_ROS' in bridge

sources = [pkg / 'launch/sim.launch.py', pkg / 'alex_sim/seed_pose.py', pkg / 'alex_sim/nav2_tuning.py', pkg / 'alex_sim/acceptance.py', pkg / 'scripts/ros_smoke.py', root / 'scripts/ros-preflight.py', root / 'robotics/ros2/nav2_action_client.py']
for source in sources:
    compile(source.read_text(), str(source), 'exec')
assert 'ALEX_ROS_NAV2_PARAMS_FILE' in (pkg / 'launch/sim.launch.py').read_text()
assert '--route' in (pkg / 'scripts/ros_smoke.py').read_text()
print('Validated XML, PGM, map origin, frames, nested Nav2 parameter generation and Python syntax (NO ROS2 runtime)')
