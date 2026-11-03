#!/usr/bin/env python3
"""Read-only Gazebo Transport probe before shutting down failed ROS acceptance.

Topic discovery can return an empty list even while direct clock echo receives
live samples. Never gate sampling on a successful --list result.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import subprocess

PROBES = {
    "clock": ["/clock", "/world/alex_home/clock"],
    "world_stats": ["/world/alex_home/stats", "/stats"],
    "odom": ["/odom"],
    "scan": ["/scan"],
}

def run_gz(args, timeout=5):
    try:
        proc = subprocess.run(["gz", *args], capture_output=True, text=True,
                              errors="replace", timeout=timeout, check=False)
        return {"status": "ok" if proc.returncode == 0 else "error",
                "stdout": proc.stdout[:2400], "stderr": proc.stderr[:500]}
    except subprocess.TimeoutExpired as exc:
        data = exc.stdout or b""
        if isinstance(data, bytes):
            data = data.decode("utf8", "replace")
        return {"status": "timeout", "stdout": data[:2400], "stderr": ""}
    except OSError as exc:
        return {"status": "unavailable", "stdout": "", "stderr": str(exc)[:300]}

def probe():
    topics = run_gz(["topic", "--list"])
    services = run_gz(["service", "--list"])
    names = set(topics["stdout"].splitlines())
    service_names = set(services["stdout"].splitlines())

    def sample(item):
        label, candidates = item
        ordered = sorted(candidates, key=lambda name: name not in names)
        attempts = []
        for topic in ordered:
            data = run_gz(["topic", "-e", "-t", topic], timeout=4)
            received = bool(data["stdout"].strip())
            attempts.append({"topic": topic, "status": data["status"],
                             "received": received, "stderr": data["stderr"]})
            if received:
                return label, {"topic": topic, "advertised": topic in names,
                               "message_received": True, "probe_status": data["status"],
                               "sample_prefix": data["stdout"][:400],
                               "stderr": data["stderr"], "attempts": attempts}
        topic = ordered[0]
        return label, {"topic": topic, "advertised": topic in names,
                       "message_received": False,
                       "probe_status": attempts[0]["status"],
                       "sample_prefix": "", "stderr": attempts[0]["stderr"],
                       "attempts": attempts}

    with ThreadPoolExecutor(max_workers=4) as executor:
        samples = dict(executor.map(sample, PROBES.items()))
    paused_match = re.search(r"\bpaused\s*:\s*(true|false)\b",
                             samples["world_stats"].get("sample_prefix", ""), flags=re.I)
    paused = paused_match.group(1).lower() == "true" if paused_match else None
    control_name = "/world/alex_home/control"
    control = (True if control_name in service_names else
               False if services["status"] == "ok" else None)
    if paused:
        hint = "Gazebo world is paused: inspect -r launch and world controls."
    elif not samples["clock"]["message_received"]:
        if control is None:
            hint = "Gazebo service discovery unavailable; clock has no sample and world state unverified."
        elif not control:
            hint = "Gazebo world service missing from discovery; clock has no sample; check server lifetime."
        else:
            hint = "Gazebo clock has no sample: clock not observed; inspect physics and sensors."
    elif not samples["odom"]["message_received"]:
        hint = "Gazebo clock observed, odom absent: check robot DiffDrive plugin."
    elif not samples["scan"]["message_received"]:
        hint = "Gazebo clock and odom observed, scan absent: check GPU LiDAR EGL/OGRE2."
    elif control is None:
        hint = "Gazebo samples observed, but service discovery unverified; inspect ROS bridge and QoS."
    else:
        hint = "Gazebo clock/odom/scan samples observed; inspect ROS bridge and QoS."

    return {"schema": "alex.dev/gz-transport/v1",
            "world_control_available": control, "world_paused": paused,
            "topics_status": topics["status"], "services_status": services["status"],
            "topics_stderr": topics["stderr"], "services_stderr": services["stderr"],
            "topics": sorted(names)[:80], "samples": samples, "hint": hint,
            "gz_partition": os.environ.get("GZ_PARTITION"),
            "note": "Read-only diagnosis; NOT ROS navigation acceptance."}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    report = probe()
    dest = Path(args.out)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf8")
    print("Gazebo Transport:", report["hint"], flush=True)
    print("Saved Gazebo Transport:", dest, flush=True)

if __name__ == "__main__":
    main()
