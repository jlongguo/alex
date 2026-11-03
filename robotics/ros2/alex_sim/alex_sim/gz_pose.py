"""Read-only Gazebo ground-truth model pose query for *simulation diagnostics*.

ROS odometry / map TF can be planar or AMCL-adjusted; only Gazebo's actual
model pose can confirm a tipped chassis after braking. No ROS dependencies,
no Gazebo commands that change state, and no acceptance shortcut.
"""
import math
import re
import subprocess


_FLOAT = r'[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?'
_TRIPLET = re.compile(
    r'\[\s*(' + _FLOAT + r')\s*\|\s*(' + _FLOAT +
    r')\s*\|\s*(' + _FLOAT + r')\s*\]')


def parse_gz_model_pose(output):
    """Parse the two XYZ/RPY triplets from `gz model --pose` (radians)."""
    anchor = re.search(r'Pose\s*\[\s*XYZ\s*\(m\)\s*\].*?RPY\s*\(rad\)',
                       output, re.I | re.S)
    if anchor is None:
        raise ValueError('GAZEBO_MODEL_POSE_HEADER_MISSING')
    triples = _TRIPLET.findall(output[anchor.end():])
    if len(triples) < 2:
        raise ValueError('GAZEBO_MODEL_POSE_VALUES_MISSING')
    xyz = [float(v) for v in triples[0]]
    rpy = [float(v) for v in triples[1]]
    if not all(math.isfinite(v) for v in xyz + rpy):
        raise ValueError('GAZEBO_MODEL_POSE_NONFINITE')
    return {
        'available': True,
        'xyz_m': [round(v, 4) for v in xyz],
        'rpy_rad': [round(v, 4) for v in rpy],
        'max_abs_tilt_rad': round(max(abs(rpy[0]), abs(rpy[1])), 4),
    }


def query_gz_model_pose(timeout=4):
    """Ask the isolated Gazebo service for the true alex_bot model pose."""
    try:
        result = subprocess.run(
            ['gz', 'model', '--world-name', 'alex_home', '--model-name', 'alex_bot', '--pose'],
            capture_output=True, text=True, errors='replace', check=False,
            timeout=timeout)
        if result.returncode != 0:
            return {'available': False, 'reason': 'gz_model_query_failed',
                    'returncode': result.returncode,
                    'stderr': result.stderr[-250:]}
        try:
            return parse_gz_model_pose(result.stdout)
        except ValueError as exc:
            return {'available': False, 'reason': str(exc),
                    'stdout_prefix': result.stdout[:300]}
    except subprocess.TimeoutExpired:
        return {'available': False, 'reason': 'gz_model_timeout'}
    except OSError as exc:
        return {'available': False, 'reason': type(exc).__name__}
