# Python dependencies for ROS/Nav2 tests

The Node.js test suite calls the `python3` found on the **current shell PATH**.
The offline Nav2 tuning contract is tested using the Python standard library;
YAML CLI integration additionally needs `PyYAML` in that same interpreter.

On macOS / Linux (including externally managed Homebrew Python), use a local
virtual environment instead of installing Python packages globally:

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements-ros-test.txt
python3 -c "import yaml; print(yaml.__version__)"
pnpm test  # or npm test
```

The YAML CLI test always runs. If PyYAML is absent, it verifies a clear,
nonzero missing-dependency error instead of silently skipping the test or
mistaking a missing package for a Nav2 logic regression. The pure Python
contract tests (including incompatible-template rejection) always execute.

For real `sim:accept`, ROS 2 Jazzy, Nav2 and Gazebo must be installed and
sourced, and the Python environment selected for the Nav2 parameter generator
must also have PyYAML available. These offline tests do not establish real
Gazebo/Nav2 navigation success.
