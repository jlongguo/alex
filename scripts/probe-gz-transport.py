#!/usr/bin/env python3
"""Bounded, read-only Gazebo Transport probe while the world is still running.
This is diagnostic evidence and cannot count as Nav2 navigation acceptance.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import re
import subprocess

PROBES = {
    "world_stats": "/world/alex_home/stats",
    "clock": "/world/alex_home/clock",
    "odom": "/odom",
    "scan": "/scan",
}

def run_gz(args, timeout=8):
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
        label, topic = item
        # Gazebo may advertise the unqualified root /clock.
        if label == "clock" and topic not in names and "/clock" in names:
            topic = "/clock"
        if topic not in names:
            return label, {"topic": topic, "advertised": False,
                           "message_received": False, "probe_status": "not_advertised"}
        # Harmonic CLI supports -e -t; do not rely on an unsupported -n flag.
        data = run_gz(["topic", "-e", "-t", topic], timeout=5)
        return label, {"topic": topic, "advertised": True,
                       "message_received": bool(data["stdout"].strip()),
                       "probe_status": data["status"],
                       "sample_prefix": data["stdout"][:400], "stderr": data["stderr"]}
    with ThreadPoolExecutor(max_workers=4) as executor:
        samples = dict(executor.map(sample, PROBES.items()))
    paused_match = re.search(r"\bpaused\s*:\s*(true|false)\b",
                             samples["world_stats"].get("sample_prefix", ""), flags=re.I)
    paused = paused_match.group(1).lower() == "true" if paused_match else None
    control_name = "/world/alex_home/control"
    # CLI failure/timeout is unknown, not evidence that the world disappeared.
    control = (True if control_name in service_names else
               False if services["status"] == "ok" else None)
    if control is None:
        hint = "Gazebo service discovery unavailable: inspect status/stderr; world state unverified."
    elif not control:
        hint = "Gazebo world control service absent from successful CLI discovery: inspect server lifetime."
    elif paused:
        hint = "Gazebo world is paused: check -r launch and world controls."
    elif not samples["clock"]["message_received"]:
        hint = "Gazebo clock not observed: inspect source topic and simulator progress."
    elif not samples["odom"]["message_received"]:
        hint = "Gazebo clock observed, odom absent: check robot DiffDrive plugin."
    elif not samples["scan"]["message_received"]:
        hint = "Gazebo clock and odom observed, scan absent: check GPU LiDAR EGL/OGRE2."
    else:
        hint = "Gazebo has samples: inspect ROS bridge mapping and QoS."
    return {"schema": "alex.dev/gz-transport/v1",
            "world_control_available": control, "world_paused": paused,
            "topics_status": topics["status"], "services_status": services["status"],
            "topics_stderr": topics["stderr"], "services_stderr": services["stderr"],
            "topics": sorted(names)[:80], "samples": samples, "hint": hint,
            "note": "Diagnostic only; not a ROS navigation acceptance result."}

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
