import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const root=resolve(import.meta.dirname,'..');
const driver=join(root,'tests/fixtures/r68-runner-provenance-driver.py');
const provenance=join(root,'scripts/ros-runner-provenance.py');
const SHA='0123456789abcdef0123456789abcdef01234567';
const RUN='76543210';
const ATTEMPT='2';

const run=(command,args,env)=>spawnSync(command,args,{
 cwd:root,encoding:'utf8',timeout:15000,
 env:{...process.env,...(env??{})}
});
const scenario=name=>run('python3',[driver,name]);

test('R68 capture 记录严格 Runner/OS/ROS/Gazebo/源码 provenance 并生成稳定 fingerprint',{timeout:15000},()=>{
 const result=scenario('success');
 assert.equal(result.status,0,result.stderr);
 const data=JSON.parse(result.stdout);
 assert.equal(data.schema,'alex.dev/ros-runner-provenance/v1');
 assert.equal(data.status,'verified');
 assert.equal(data.source_type,'github-actions-self-hosted-runtime');
 assert.equal(data.actions.workflow_run_id,RUN);
 assert.equal(data.actions.workflow_run_attempt,2);
 assert.equal(data.actions.commit_sha,SHA);
 assert.equal(data.actions.runner_environment,'self-hosted');
 assert.equal(data.actions.runner_os,'Linux');
 assert.equal(data.actions.runner_arch,'X64');
 assert.deepEqual(data.isolation,{
  simulation_only:'1',integration_opt_in:'1',headless_rendering:'1',
  ros_domain_id:'77',ros_discovery_range:'LOCALHOST',ros_distro:'jazzy'
 });
 assert.deepEqual(
  {id:data.platform.id,version_id:data.platform.version_id,
   version_codename:data.platform.version_codename,machine:data.platform.machine},
  {id:'ubuntu',version_id:'24.04',version_codename:'noble',machine:'x86_64'}
 );
 assert.match(data.tools.node,/^v22\./);
 assert.match(data.tools.python3,/^Python 3\.12\./);
 assert.match(data.tools.gazebo_sim_versions,/Gazebo Sim, version 8\./);
 assert.equal(data.source.git_head,SHA);
 assert.equal(data.source.tracked_worktree_clean,true);
 assert.equal(Object.keys(data.apt_packages).length,7);
 assert.equal(Object.keys(data.ros_package_prefixes).length,7);
 assert.ok(Object.values(data.ros_package_prefixes).every(x=>x==='/opt/ros/jazzy'));
 assert.match(data.fingerprint_sha256,/^[0-9a-f]{64}$/);
 assert.equal(data.release_approved,false);
 assert.equal(data.physical_safety_certified,false);
 assert.doesNotMatch(JSON.stringify(data),/must-never-appear/);
});

test('R68 非 Ubuntu24.04/x86_64、Runner arch 或隔离边界错误全部 fail closed',{timeout:15000},()=>{
 const cases=[
  ['wrong-os','RUNNER_PROVENANCE_OS_UNSUPPORTED'],
  ['wrong-machine','RUNNER_PROVENANCE_MACHINE_INVALID'],
  ['wrong-runner-arch','RUNNER_PROVENANCE_RUNNER_PLATFORM_INVALID'],
  ['wrong-isolation','RUNNER_PROVENANCE_ISOLATION_INVALID'],
  ['wrong-context','RUNNER_PROVENANCE_UNAPPROVED_CONTEXT']
 ];
 for(const [name,code] of cases){
  const result=scenario(name);
  assert.equal(result.status,1,name);
  assert.match(result.stderr,new RegExp(code),name);
 }
});

test('R68 Node/Python/Gazebo 或 ROS/apt 安装不符合基线时拒绝',{timeout:15000},()=>{
 const cases=[
  ['wrong-node','RUNNER_PROVENANCE_NODE_INVALID'],
  ['wrong-python','RUNNER_PROVENANCE_PYTHON_INVALID'],
  ['wrong-gazebo','RUNNER_PROVENANCE_GAZEBO_INVALID'],
  ['wrong-ros-prefix','RUNNER_PROVENANCE_ROS_PREFIX_INVALID'],
  ['missing-apt','RUNNER_PROVENANCE_COMMAND_FAILED']
 ];
 for(const [name,code] of cases){
  const result=scenario(name);
  assert.equal(result.status,1,name);
  assert.match(result.stderr,new RegExp(code),name);
 }
});

test('R68 Git HEAD 不等于 Workflow SHA 或 tracked worktree 被修改时拒绝',{timeout:15000},()=>{
 for(const [name,code] of [
  ['wrong-sha','RUNNER_PROVENANCE_GIT_HEAD_MISMATCH'],
  ['dirty-tree','RUNNER_PROVENANCE_TRACKED_WORKTREE_DIRTY']
 ]){
  const result=scenario(name);
  assert.equal(result.status,1,name);
  assert.match(result.stderr,new RegExp(code),name);
 }
});

test('R68 离线 verifier 重算 fingerprint，篡改环境字段或 overclaim 均失败',{timeout:15000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r68-provenance-'));
 try{
  const generated=scenario('success');
  assert.equal(generated.status,0,generated.stderr);
  const report=join(dir,'runner-provenance.json');
  const original=JSON.parse(generated.stdout);
  await writeFile(report,JSON.stringify(original));
  const verify=()=>run('python3',[
   provenance,'--verify','--report',report,
   '--run-id',RUN,'--attempt',ATTEMPT,'--commit-sha',SHA
  ]);
  assert.equal(verify().status,0,verify().stderr);

  const tampered=structuredClone(original);
  tampered.platform.kernel_release='6.8.0-tampered';
  await writeFile(report,JSON.stringify(tampered));
  let checked=verify();
  assert.equal(checked.status,1);
  assert.match(checked.stderr,/RUNNER_PROVENANCE_FINGERPRINT_MISMATCH/);

  const overclaim=structuredClone(original);
  overclaim.release_approved=true;
  await writeFile(report,JSON.stringify(overclaim));
  checked=verify();
  assert.equal(checked.status,1);
  assert.match(checked.stderr,/RUNNER_PROVENANCE_OVERCLAIMED/);
 }finally{
  await rm(dir,{recursive:true,force:true});
 }
});

test('R68 Workflow 在 npm install/Gazebo 前捕获 provenance，并把它放入主 evidence Artifact',{timeout:15000},async()=>{
 const workflow=await readFile(join(root,'.github/workflows/ros-sim-acceptance.yml'),'utf8');
 const reset=workflow.indexOf('Invalidate previous ROS workflow evidence');
 const capture=workflow.indexOf('ros-runner-provenance.py --capture');
 const verify=workflow.indexOf('ros-runner-provenance.py --verify');
 const install=workflow.indexOf('npm install --ignore-scripts');
 const gazebo=workflow.indexOf('npm run sim:accept');
 const artifact=workflow.indexOf('.local/ros/runner-provenance.json');
 assert.ok(reset>=0);
 assert.ok(capture>reset);
 assert.ok(verify>capture);
 assert.ok(install>verify);
 assert.ok(gazebo>install);
 assert.ok(artifact>gazebo);
 assert.match(workflow,/source \/opt\/ros\/jazzy\/setup\.bash/);
 assert.match(workflow,/ROS_DOMAIN_ID: '77'/);
 assert.match(workflow,/ROS_AUTOMATIC_DISCOVERY_RANGE: LOCALHOST/);
});

test('R68 provenance 源码不枚举环境变量、不记录 hostname/token/用户目录',{timeout:15000},async()=>{
 const source=await readFile(provenance,'utf8');
 assert.doesNotMatch(source,/os\.environ\.items\(|printenv|env\s*\)/);
 assert.doesNotMatch(source,/hostname|platform\.node\(/i);
 assert.doesNotMatch(source,/GITHUB_TOKEN/);
 assert.doesNotMatch(source,/\/home\//);
 assert.match(source,/--untracked-files=no/);
});
