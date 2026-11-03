#!/usr/bin/env python3
"""Simulation-only physics isolation: no Sensors/OGRE2; NEVER Nav2 acceptance.

Runs Gazebo with a temporary copy of the real Alex SDF world from which only
the world Sensors system plugin is removed. Reads Gazebo Transport clock and
odometry, then terminates its own isolated server process group.
"""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
WORLD = ROOT / "robotics/ros2/alex_sim/worlds/alex_home.sdf"
MODELS = ROOT / "robotics/ros2/alex_sim/models"


def write_physics_world(source, destination):
    tree = ET.parse(source)
    world = tree.getroot().find("./world[@name='alex_home']")
    if world is None:
        raise ValueError("ALEX_WORLD_NOT_FOUND")
    sensors = [p for p in world.findall("plugin")
               if p.get("name") == "gz::sim::systems::Sensors"]
    if len(sensors) != 1:
        raise ValueError("EXPECTED_ONE_SENSORS_PLUGIN")
    world.remove(sensors[0])
    if not world.find("./plugin[@name='gz::sim::systems::Physics']") is not None:
        raise ValueError("PHYSICS_PLUGIN_MISSING")
    tree.write(destination, encoding="utf-8", xml_declaration=True)


def cmd(args, timeout=5):
    try:
        result = subprocess.run(["gz", *args], capture_output=True, text=True,
                                errors="replace", timeout=timeout, check=False)
        return {"state": "ok" if result.returncode == 0 else "error",
                "output": result.stdout[:10000], "stderr": result.stderr[:400]}
    except subprocess.TimeoutExpired as ex:
        output = ex.stdout or b""
        if isinstance(output, bytes):
            output = output.decode("utf-8", "replace")
        return {"state": "timeout", "output": output[:10000], "stderr": ""}
    except OSError as ex:
        return {"state": "unavailable", "output": "", "stderr": str(ex)[:300]}


def clock_values(message):
    values = []
    for block in re.findall(r"\bsim\s*\{([^}]*)\}", message, re.S):
        sec = re.search(r"\bsec\s*:\s*(\d+)", block)
        nsec = re.search(r"\bnsec\s*:\s*(\d+)", block)
        if sec or nsec:
            values.append(int(sec.group(1)) * 1_000_000_000 if sec else 0)
            values[-1] += int(nsec.group(1)) if nsec else 0
    return values


def probe(out, deadline_seconds=35):
    report = {"schema": "alex.dev/gazebo-physics-isolation/v1",
              "mode": "physics_only_no_sensors", "status": "not_run",
              "clock_advanced": False, "odom_message_received": False,
              "simulation_only": True,
              "note": "This isolation excludes Sensors/OGRE2 and is NEVER three-goal Nav2 acceptance."}
    with tempfile.TemporaryDirectory(prefix="alex-physics-only-") as temp:
        temp = Path(temp)
        world = temp / "alex_home_no_sensors.sdf"
        log = temp / "gz.log"
        try:
            write_physics_world(WORLD, world)
            env = dict(os.environ)
            env["GZ_SIM_RESOURCE_PATH"] = str(MODELS) + os.pathsep + env.get("GZ_SIM_RESOURCE_PATH", "")
            env["ROS_DOMAIN_ID"] = "77"
            env["ROS_AUTOMATIC_DISCOVERY_RANGE"] = "LOCALHOST"
            with log.open("w", encoding="utf-8") as stream:
                proc = subprocess.Popen(["gz", "sim", "-v", "3", "-r", "-s", str(world)],
                                        env=env, stdout=stream, stderr=subprocess.STDOUT,
                                        start_new_session=True)
                try:
                    stop = time.monotonic() + deadline_seconds
                    topic = None
                    listed = None
                    while time.monotonic() < stop and proc.poll() is None:
                        listed = cmd(["topic", "--list"], timeout=3)
                        topics = set(listed["output"].splitlines())
                        topic = "/clock" if "/clock" in topics else (
                            "/world/alex_home/clock" if "/world/alex_home/clock" in topics else None)
                        if topic is not None:
                            break
                        time.sleep(1)
                    report["clock_topic"] = topic
                    report["topic_list_state"] = listed["state"] if listed else "not_attempted"
                    if topic:
                        clock = cmd(["topic", "-e", "-t", topic], timeout=6)
                        ticks = clock_values(clock["output"])
                        report["clock_advanced"] = len(set(ticks)) >= 2 and ticks[-1] > ticks[0]
                        report["clock_observations"] = len(ticks)
                        report["clock_echo_state"] = clock["state"]
                        report["clock_sample_prefix"] = clock["output"][:450]
                        odom = cmd(["topic", "-e", "-t", "/odom"], timeout=3)
                        report["odom_message_received"] = bool(odom["output"].strip())
                        report["odom_echo_state"] = odom["state"]
                        report["odom_sample_prefix"] = odom["output"][:250]
                    report["gazebo_exited_early"] = proc.poll() is not None
                    report["status"] = "clock_advancing" if report["clock_advanced"] else "clock_unavailable_or_static"
                finally:
                    try:
                        os.killpg(proc.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(proc.pid, signal.SIGKILL)
                        proc.wait(timeout=5)
        except Exception as ex:
            report["status"] = "probe_error"
            report["error"] = str(ex)[:400]
        report["startup_log_tail"] = log.read_text(encoding="utf-8", errors="replace")[-3000:] if log.is_file() else ""
    path = Path(out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Gazebo physics isolation:", report["status"], "clock_advancing=", report["clock_advanced"])
    print("Report:", path)
    return 0 if report["clock_advanced"] else 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--timeout", type=int, default=35)
    args = parser.parse_args()
    if os.environ.get("ALEX_ROS_SIMULATION_ONLY") != "1":
        raise SystemExit("SIMULATION_ONLY_FLAG_REQUIRED")
    if not 10 <= args.timeout <= 90:
        raise SystemExit("INVALID_PROBE_TIMEOUT")
    raise SystemExit(probe(args.out, args.timeout))


if __name__ == "__main__":
    main()
