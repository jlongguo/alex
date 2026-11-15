import {createHash} from 'node:crypto';

export const PROVENANCE_APT_PACKAGES=[
 'ros-jazzy-ros-base',
 'ros-jazzy-ros-gz',
 'ros-jazzy-navigation2',
 'ros-jazzy-nav2-bringup',
 'ros-jazzy-robot-state-publisher',
 'ros-jazzy-tf2-ros',
 'python3-colcon-common-extensions'
];

export const PROVENANCE_ROS_PACKAGES=[
 'ros_gz_sim',
 'ros_gz_bridge',
 'nav2_bringup',
 'nav2_common',
 'robot_state_publisher',
 'nav2_msgs',
 'tf2_ros'
];

function canonical(value){
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object'){
  return '{'+Object.keys(value).sort().map(key=>
   JSON.stringify(key)+':'+canonical(value[key])
  ).join(',')+'}';
 }
 return JSON.stringify(value);
}

export function makeRunnerProvenance({
 runId='76543210',
 attempt=2,
 sha='0123456789abcdef0123456789abcdef01234567'
}={}){
 const actions={
  repository:'jlongguo/alex',
  workflow:'.github/workflows/ros-sim-acceptance.yml',
  workflow_ref:'jlongguo/alex/.github/workflows/ros-sim-acceptance.yml@refs/heads/main',
  job:'nav2-simulation',
  workflow_run_id:String(runId),
  workflow_run_attempt:Number(attempt),
  commit_sha:sha,
  runner_environment:'self-hosted',
  runner_os:'Linux',
  runner_arch:'X64'
 };
 const isolation={
  simulation_only:'1',
  integration_opt_in:'1',
  headless_rendering:'1',
  ros_domain_id:'77',
  ros_discovery_range:'LOCALHOST',
  ros_distro:'jazzy'
 };
 const platform={
  id:'ubuntu',
  version_id:'24.04',
  version_codename:'noble',
  kernel_release:'6.8.0-101-generic',
  machine:'x86_64'
 };
 const tools={
  node:'v22.16.0',
  npm:'10.9.2',
  python3:'Python 3.12.3',
  git:'git version 2.43.0',
  gazebo_sim_versions:'Gazebo Sim, version 8.9.0'
 };
 const apt_packages=Object.fromEntries(PROVENANCE_APT_PACKAGES.map(name=>[
  name,name==='python3-colcon-common-extensions'?'0.19.0-1':'1.2.3-1noble.20261114.123456'
 ]));
 const ros_package_prefixes=Object.fromEntries(
  PROVENANCE_ROS_PACKAGES.map(name=>[name,'/opt/ros/jazzy'])
 );
 const source={git_head:sha,tracked_worktree_clean:true};
 const payload={actions,isolation,platform,tools,apt_packages,ros_package_prefixes,source};
 const fingerprint_sha256=createHash('sha256').update(canonical(payload)).digest('hex');
 return {
  schema:'alex.dev/ros-runner-provenance/v1',
  status:'verified',
  source_type:'github-actions-self-hosted-runtime',
  simulation_only:true,
  physical_safety_certified:false,
  release_approved:false,
  ...payload,
  fingerprint_sha256,
  captured_at:'2026-11-15T00:00:00+00:00'
 };
}
