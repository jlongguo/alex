import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
const root=resolve(import.meta.dirname,'..');
const read=p=>readFileSync(join(root,p),'utf8');

test('Docker Node dependencies are isolated from the host pnpm tree',()=>{
 const compose=read('docker-compose.sim.yml');
 const script=read('scripts/docker-sim.sh');
 assert.match(compose,/source:\s*sim_node_modules\s*\n\s*target:\s*\/workspace\/alex\/node_modules/);
 assert.match(compose,/nocopy:\s*true/);
 assert.match(compose,/^volumes:\s*\n\s*sim_node_modules:/m);
 assert.match(script,/npm install --ignore-scripts --no-package-lock/);
});

test('Parent server startup reports damaged TypeScript dependencies before compiling',()=>{
 const shell=read('scripts/start-local.sh');
 assert.match(shell,/node_modules\/typescript\/lib\/tsc\.js/);
 assert.match(shell,/pnpm install --frozen-lockfile/);
 const tmp=mkdtempSync(join(tmpdir(),'alex-local-deps-'));
 try {
  mkdirSync(join(tmp,'scripts'));
  writeFileSync(join(tmp,'scripts/start-local.sh'),shell);
  const run=spawnSync('bash',[join(tmp,'scripts/start-local.sh')],{cwd:tmp,encoding:'utf8',timeout:3000,env:{...process.env,ALEX_PARENT_PASSWORD:'test-password-123456789'}});
  assert.equal(run.status,2,run.stderr);
  assert.match(run.stderr,/TypeScript.*依赖缺失或损坏/);
  assert.doesNotMatch(run.stderr,/test-password-123456789/);
 }finally{rmSync(tmp,{recursive:true,force:true});}
});

test('Virtual client checks auth mode before sending the device bearer token',async()=>{
 const seen=[];
 const server=createServer((req,res)=>{seen.push({path:req.url,authorization:req.headers.authorization});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({authMode:'demo'}));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=server.address().port;
 const token='a'.repeat(64);
 const child=spawn(process.execPath,['scripts/virtual-device.mjs'],{cwd:root,env:{...process.env,ALEX_BASE_URL:'http://127.0.0.1:'+port,ALEX_DEVICE_ID:'dev-00000000-0000-4000-8000-000000000000',ALEX_DEVICE_TOKEN:token},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',b=>stderr+=b.toString());
 const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
 try{
  const [code]=await once(child,'exit');
  assert.notEqual(code,0);
  assert.match(stderr,/LOCAL_AUTH_REQUIRED.*demo mode/);
  assert.deepEqual(seen,[{path:'/api/health',authorization:undefined}]);
  assert.doesNotMatch(stderr,new RegExp(token));
 }finally{clearTimeout(timer);server.close();}
});
