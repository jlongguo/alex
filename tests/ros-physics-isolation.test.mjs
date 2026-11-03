import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const read=p=>readFileSync(join(root,p),'utf8');

test('Docker OGRE2 software GL defaults preserve unprivileged simulation',()=>{
 const cfg=read('docker-compose.sim.yml');
 assert.match(cfg,/LIBGL_ALWAYS_SOFTWARE:\s*"\$\{ALEX_LIBGL_ALWAYS_SOFTWARE:-1\}"/);
 assert.match(cfg,/GALLIUM_DRIVER:\s*"\$\{ALEX_GALLIUM_DRIVER:-llvmpipe\}"/);
 assert.match(cfg,/no-new-privileges:true/);
 assert.match(cfg,/cap_drop:\s*\n\s*- ALL/);
 assert.doesNotMatch(cfg,/privileged:\s*true/);
});

test('physics CLI leaves full Nav2 acceptance unchanged',()=>{
 const script=read('scripts/docker-sim.sh');
 assert.match(script,/physics\)\s*command_physics/);
 assert.match(script,/probe-gz-physics\.py --out/);
 assert.match(script,/npm run sim:accept/);
 assert.match(script,/physics-only\.json/);
 assert.equal(spawnSync('bash',['-n','scripts/docker-sim.sh'],{cwd:root}).status,0);
});

test('physics-only generated world omits rendering but retains robot and physics',()=>{
 const code=[
 'import importlib.util, pathlib, tempfile, xml.etree.ElementTree as ET',
 'p=pathlib.Path("scripts/probe-gz-physics.py")',
 'spec=importlib.util.spec_from_file_location("physics_probe",p)',
 'mod=importlib.util.module_from_spec(spec)',
 'spec.loader.exec_module(mod)',
 'with tempfile.TemporaryDirectory() as d:',
 '    out=pathlib.Path(d)/"world.sdf"',
 '    mod.write_physics_world(mod.WORLD,out)',
 '    w=ET.parse(out).getroot().find("world")',
 '    plugins={n.get("name") for n in w.findall("plugin")}',
 '    assert "gz::sim::systems::Sensors" not in plugins',
 '    assert "gz::sim::systems::Physics" in plugins',
 '    assert w.find("./include/uri").text=="model://alex_bot"',
 '    assert mod.clock_values("sim { sec: 0 nsec: 3 } sim { sec: 0 nsec: 4 }")==[3,4]',
 '    assert mod.clock_values("real { sec: 1 } sim { sec: 2 nsec: 4 }")==[2000000004]',
 ].join('\n');
 const out=spawnSync('python3',['-c',code],{cwd:root,encoding:'utf8'});
 assert.equal(out.status,0,out.stderr);
});

test('physics probe never masquerades as Nav2 navigation evidence',()=>{
 const script=read('scripts/probe-gz-physics.py');
 assert.match(script,/physics_only_no_sensors/);
 assert.match(script,/SIMULATION_ONLY_FLAG_REQUIRED/);
 assert.match(script,/os\.killpg/);
 assert.doesNotMatch(script,/NavigateToPose|send_goal/);
});
