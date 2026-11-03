# Docker ROS simulation: `__pycache__` breaks colcon package data

## Symptom

`bash scripts/docker-sim.sh all` completes the image build, offline tests and
ROS preflight, but `sim:accept` fails during `colcon build alex_sim` with:

```text
error: can't copy '.../build/alex_sim/launch/__pycache__': doesn't exist or not a regular file
```

The Gazebo/Nav2 runtime **has not started** at this point; a passing preflight
is not evidence of successful navigation.

## Root cause and fix

`robotics/ros2/alex_sim/setup.py` previously used an unfiltered `glob(folder + '/*')`
for `data_files`. Executing the launch offline validator can create
`launch/__pycache__`. Setuptools attempts to copy that directory as an ordinary
file and aborts package installation. `setup.py` now uses regular-file-only,
extension-allowlisted globs for launch, maps, worlds, URDF, config and model assets.
The regression test `tests/ros-package-data.test.mjs` deliberately creates
`__pycache__` folders and copies every declared `data_file` to a scratch
installation tree.

## Retry without rebuilding the large Docker image

After checking out a branch containing the fix, run from the repository root:

```bash
npm test
npm run sim:check
# Remove only generated colcon build/install/log state, not acceptance evidence.
rm -rf .local/ros/build .local/ros/install .local/ros/log
bash scripts/docker-sim.sh accept
```

The image need not be rebuilt for this repository-source change because the
project is bind-mounted into the container. Do not delete `.local/ros/*.json`
when you need them for diagnostics. For the next failure inspect:

```bash
bash scripts/docker-sim.sh logs
```

`colcon` successfully installing the package is only the next prerequisite.
Gazebo rendering, `/scan`, TF, AMCL and three-leg Nav2 navigation remain
unverified until `acceptance-report.json` contains a valid, current-run
`passed` result.
