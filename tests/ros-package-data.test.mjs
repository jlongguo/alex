import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const setupPath = resolve(root, 'robotics/ros2/alex_sim/setup.py');

// Execute the *real* setup.py in a throwaway synthetic package with simulated
// launch bytecode caches. A fake setuptools.setup captures its data_files
// without requiring ROS, colcon, setuptools or PyYAML on the host.
const inspectSetup = String.raw`
import json, os, pathlib, runpy, sys, tempfile, types, shutil
from pathlib import Path
setup_path = sys.argv[1]
records = {}
fake_setuptools = types.ModuleType('setuptools')
fake_setuptools.setup = lambda **kwargs: records.update(kwargs)
sys.modules['setuptools'] = fake_setuptools
with tempfile.TemporaryDirectory(prefix='alex-ros-package-') as tmp:
    os.chdir(tmp)
    expected = [
      'resource/alex_sim', 'package.xml',
      'launch/sim.launch.py',
      'worlds/alex_home.sdf',
      'maps/alex_home.yaml', 'maps/alex_home.pgm',
      'urdf/alex_bot.urdf', 'config/bridge.yaml',
      'models/alex_bot/model.sdf', 'models/alex_bot/model.config',
    ]
    for name in expected:
        path=Path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('simulated asset')
    for path in ('launch/__pycache__/sim.cpython-312.pyc',
                 'models/alex_bot/__pycache__/model.pyc',
                 'config/unrelated.tmp', 'launch/debug.log'):
        p=Path(path); p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(b'cache')
    runpy.run_path(setup_path, run_name='__main__')
    assets = [source for _dest,files in records['data_files'] for source in files]
    if sorted(assets) != sorted(expected):
        raise AssertionError('wrong ament_python package assets: ' + repr(assets))
    for dest,files in records['data_files']:
        for filename in files:
            p=Path(filename)
            if not p.is_file():
                raise AssertionError('not a regular package file: ' + str(p))
            # Mimic setuptools copying each data_file into the install prefix.
            target=Path(tmp)/'install'/dest/p.name
            target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(p,target)
    print(json.dumps({'assets':assets, 'count':len(assets)}))
`;

test('ROS ament_python package excludes __pycache__ directories and non-assets', () => {
  const result = spawnSync('python3', ['-c', inspectSetup, setupPath], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.count, 10);
  assert.ok(report.assets.includes('launch/sim.launch.py'));
  assert.ok(report.assets.includes('models/alex_bot/model.sdf'));
  assert.ok(report.assets.every(a => !a.includes('__pycache__')));
});
