import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const python=join(root,'scripts/probe-gz-physics.py');
const code=[
  'import importlib.util',
  'spec=importlib.util.spec_from_file_location("alex_physics_probe","scripts/probe-gz-physics.py")',
  'mod=importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(mod)',
  'calls=[]',
  'def echo(args, timeout=4):',
  '    calls.append((args,timeout))',
  '    return {"state":"timeout", "stderr":"", "output": "sim { sec: 1 nsec: 0 }\\nsim { sec: 2 nsec: 0 }\\n" if args[-1]=="/clock" else ""}',
  'topic,attempts=mod.sample_clock(set(),runner=echo)',
  'assert topic=="/clock", (topic, attempts)',
  'assert calls[0][0]==["topic","-e","-t","/clock"]',
  'assert attempts[0]["advanced"] is True',
  'def empty(args,timeout=4):',
  '    return {"state":"timeout","stderr":"","output":""}',
  'topic,attempts=mod.sample_clock(set(),runner=empty)',
  'assert topic is None',
  'assert {a["topic"] for a in attempts}=={"/clock","/world/alex_home/clock"}',
].join('\n');

test('clock is probed directly even when Gazebo topic discovery is empty',()=>{
 const p=spawnSync('python3',['-c',code],{cwd:root,encoding:'utf8'});
 assert.equal(p.status,0,p.stderr);
});
test('explicit Gazebo partition is exported to all Compose simulation children',()=>{
 const cfg=readFileSync(join(root,'docker-compose.sim.yml'),'utf8');
 const py=readFileSync(python,'utf8');
 assert.match(cfg,/GZ_PARTITION: "\$\{ALEX_GZ_PARTITION:-alex-simulation-ros77\}"/);
 assert.match(py,/os\.environ\["GZ_PARTITION"\] = env\["GZ_PARTITION"\]/);
 assert.match(py,/report\["gz_partition"\]/);
});
test('no topic list does not skip direct clock or odom probing',()=>{
 const py=readFileSync(python,'utf8');
 assert.match(py,/sample_clock\(observed_topics\)/);
 assert.match(py,/cmd\(\["topic", "-e", "-t", "\/odom"\]/);
 assert.match(py,/transport_discovery_or_clock_unavailable/);
 assert.doesNotMatch(py,/if topic:\s*\n\s*clock =/);
});
