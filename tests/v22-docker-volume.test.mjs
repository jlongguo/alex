import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,readFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
function fakeDocker(action, opts={}) {
  const tmp=mkdtempSync(join(tmpdir(),'alex-vol-'));
  const exe=join(tmp,'docker'),log=join(tmp,'calls');
  writeFileSync(exe,'#!/bin/sh\nprintf "%s\\n" "$*" >> "$ALEX_TEST_LOG"\ncase "$*" in *"--cap-add CHOWN"*) [ "$ALEX_TEST_DENY" != 1 ] || exit 1;; esac\nexit 0\n');
  chmodSync(exe,0o755);
  try {
    const env={...process.env,PATH:tmp+':'+process.env.PATH,ALEX_TEST_LOG:log,ALEX_DOCKER_UID:'501',ALEX_DOCKER_GID:'20',...opts};
    const result=spawnSync('/bin/bash',[join(root,'scripts/docker-sim.sh'),action],{cwd:root,encoding:'utf8',timeout:10000,env});
    return {...result,calls:readFileSync(log,'utf8').split('\n').filter(Boolean)};
  }finally{rmSync(tmp,{recursive:true,force:true});}
}
test('dependency volume is chowned before unprivileged npm',()=>{
  const r=fakeDocker('check');
  assert.equal(r.status,0,r.stderr);
  const root=r.calls.findIndex(x=>x.includes('--user 0:0 --cap-add CHOWN sim'));
  const npm=r.calls.findIndex(x=>x.includes('run --rm -T sim bash -lc'));
  assert.ok(root>=0 && npm>root,r.calls.join('\n'));
  assert.match(r.calls[root],/chown -R -- '501:20'/);
  assert.match(r.calls[npm],/npm test && npm run sim:check/);
  assert.doesNotMatch(r.calls[npm],/--user 0:0|--cap-add CHOWN/);
});
test('a denied ownership repair stops before npm or ROS acceptance',()=>{
  const r=fakeDocker('accept',{ALEX_TEST_DENY:'1'});
  assert.equal(r.status,2);
  assert.match(r.stderr,/Could not initialize the Docker dependency volume/);
  assert.ok(!r.calls.some(x=>x.includes('npm run sim:accept')));
});
test('invalid UID:GID values cannot be injected into the container command',()=>{
  const r=fakeDocker('check',{ALEX_DOCKER_UID:'501;echo wrong'});
  assert.equal(r.status,2);
  assert.match(r.stderr,/must be numeric/);
  assert.ok(!r.calls.some(x=>x.includes('run --rm')));
});
test('setup, preflight, accept and shell all initialize named volume',()=>{
  for(const action of ['setup','preflight','accept','shell']){
    const r=fakeDocker(action);
    assert.equal(r.status,0,action+': '+r.stderr);
    assert.ok(r.calls.some(x=>x.includes('--cap-add CHOWN')),action);
  }
});