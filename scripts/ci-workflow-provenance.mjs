#!/usr/bin/env node
// R74 Workflow provenance：强制官方 Actions 使用 immutable commit SHA，并冻结三个关键 workflow 的 SHA-256。
// 仅做源码层验证，不声明真实 Voice / ROS runtime 已执行。
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export const ACTION_PINS=Object.freeze({
 'actions/checkout':'11d5960a326750d5838078e36cf38b85af677262',
 'actions/setup-node':'49933ea5288caeca8642d1e84afbd3f7d6820020',
 'actions/upload-artifact':'ea165f8d65b6e75b540449e92b4886f43607fa02'
});
export const WORKFLOWS=Object.freeze([
 '.github/workflows/ci.yml',
 '.github/workflows/ros-sim-acceptance.yml',
 '.github/workflows/voice-provider-acceptance.yml'
]);

const fail=code=>{throw Error(code);};
const sha256=text=>createHash('sha256').update(text).digest('hex');

export function verifyWorkflowSource(source,path='<workflow>'){
 if(typeof source!=='string'||!source.trim())fail('WORKFLOW_PROVENANCE_SOURCE_INVALID');
 const uses=[...source.matchAll(/^\s*-\s+uses:\s+([^\s#]+)\s*$/gm)].map(m=>m[1]);
 for(const ref of uses){
  const at=ref.lastIndexOf('@');
  if(at<1)fail('WORKFLOW_PROVENANCE_ACTION_REF_INVALID:'+path);
  const action=ref.slice(0,at),revision=ref.slice(at+1);
  if(action in ACTION_PINS&&revision!==ACTION_PINS[action])
   fail('WORKFLOW_PROVENANCE_ACTION_NOT_PINNED:'+action);
  if(/^actions\//.test(action)&&!/^[0-9a-f]{40}$/.test(revision))
   fail('WORKFLOW_PROVENANCE_ACTION_NOT_IMMUTABLE:'+action);
 }
 for(const action of Object.keys(ACTION_PINS)){
  if(source.includes(action+'@')&&!uses.some(ref=>ref===action+'@'+ACTION_PINS[action]))
   fail('WORKFLOW_PROVENANCE_PIN_MISMATCH:'+action);
 }
 return {path,digestSha256:sha256(source),officialActions:uses.filter(x=>x.startsWith('actions/'))};
}

export async function verifyWorkflowFiles(root='.'){
 const reports=[];
 for(const path of WORKFLOWS){
  const source=await readFile(resolve(root,path),'utf8');
  reports.push(verifyWorkflowSource(source,path));
 }
 return {
  schema:'alex.dev/workflow-provenance/v1',status:'verified',
  immutableOfficialActions:true,reports,
  runtimeAcceptance:false,releaseApproved:false,physicalSafetyCertified:false
 };
}

if(process.argv[1]&&process.argv[1].endsWith('ci-workflow-provenance.mjs')){
 try{
  const [mode,root='.']=process.argv.slice(2);
  if(mode!=='verify')fail('WORKFLOW_PROVENANCE_USAGE: verify [repo-root]');
  const report=await verifyWorkflowFiles(root);
  console.log(JSON.stringify(report,null,2));
 }catch(error){console.error(error.message);process.exitCode=1;}
}
