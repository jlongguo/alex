// R54 无额外 npm 依赖的 Chromium/CDP 真实浏览器验收。
// 测试只在独立的本地临时目录启动 Alex/Chromium，绝不连接生产用户数据。
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {existsSync} from 'node:fs';

const project=resolve(import.meta.dirname,'..');
const delay=ms=>new Promise(done=>setTimeout(done,ms));
const envFiles={
 STATE_FILE:'state.json',AUDIT_FILE:'audit.jsonl',MEMORY_FILE:'memory.json',
 DEVICES_FILE:'devices.json',PROFILES_FILE:'profiles.json',
 LEARNER_CREDENTIALS_FILE:'learner-credentials.json',
 ALEX_LEARNER_PRIVACY_FILE:'learner-privacy.json',
 ALEX_LEARNING_PLANS_FILE:'learning-plans.json',
 ALEX_CONVERSATION_FILE:'conversations.json',
 ALEX_SKILL_GOVERNANCE_FILE:'governance.json',
 ALEX_SKILL_TRUST_FILE:'trust.json',
 ALEX_SKILL_PACKAGES_FILE:'packages.json',
 ALEX_SKILL_TRANSACTIONS_FILE:'transactions.json',
 ALEX_SKILL_BATCH_WAL_FILE:'batch-wal.json',
 GATEWAY_FILE:'gateway.json',WORKFLOW_FILE:'workflows.json',
 PLAN_FILE:'plans.json',PROPOSAL_FILE:'proposals.json'
};
const timeout=async(promise,ms,label)=>Promise.race([
 promise,
 delay(ms).then(()=>{throw Error('R54_TIMEOUT_'+label);})
]);
async function freePort(){
 const server=createServer();
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 const port=server.address().port;
 await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
 return port;
}
function findChrome(){
 const preferred=[process.env.CHROME_BIN,
  '/usr/bin/google-chrome','/usr/bin/google-chrome-stable',
  '/usr/bin/chromium','/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
 for(const path of preferred){
  if(path&&existsSync(path))return path;
 }
 for(const name of ['google-chrome','google-chrome-stable','chromium','chromium-browser']){
  const cmd=spawnSync('which',[name],{encoding:'utf8',timeout:2000});
  if(cmd.status===0&&cmd.stdout.trim())return cmd.stdout.trim();
 }
 throw Error('R54_CHROMIUM_NOT_INSTALLED: 需在 CI 或本机安装 Chromium/Chrome，不能将缺失浏览器视为测试通过');
}
async function stopProcess(child,signal='SIGTERM'){
 if(!child||child.exitCode!==null||child.signalCode!==null)return;
 const exiting=once(child,'exit');
 child.kill(signal);
 await timeout(exiting,8000,'STOP_CHILD');
}
async function startAlex(dir){
 const port=await freePort();
 const env={
  PORT:String(port),AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'r54-only-test-parent-password',
  ALEX_CHILD_PIN:'778844',ALEX_CONVERSATION_PERSIST:'1',AGENT_PROVIDER:'rules',
  ALEX_CHAT_PROVIDER:'offline',ALEX_AUDIO_PROVIDER:'disabled',
  ALEX_REALTIME_PROVIDER:'disabled',ALEX_SPEECH_STREAM_PROVIDER:'disabled',
  ...Object.fromEntries(Object.entries(envFiles).map(([key,name])=>[key,join(dir,name)]))
 };
 const child=spawn(process.execPath,['scripts/server.mjs'],{
  cwd:project,env:{...process.env,...env},stdio:['ignore','ignore','pipe']
 });
 let stderr='';
 child.stderr.setEncoding('utf8');
 child.stderr.on('data',chunk=>{if(stderr.length<1600)stderr+=chunk.slice(0,1600);});
 const base='http://127.0.0.1:'+port;
 let lastError=null;
 for(let i=0;i<140;i++){
  if(child.exitCode!==null)throw Error('R54_ALEX_EXITED:'+stderr);
  try{if((await fetch(base+'/api/health')).ok)return {child,base,env};}
  catch(err){lastError=err;}
  await delay(60);
 }
 await stopProcess(child);
 throw Error('R54_ALEX_NOT_READY:'+String(lastError?.message??'unknown'));
}
async function startChrome(root){
 const executable=findChrome();
 const data=join(root,'chrome-data');
 await mkdir(data);
 const args=[
  '--headless=new','--no-first-run','--no-default-browser-check',
  '--disable-background-networking','--disable-extensions','--disable-sync',
  '--disable-dev-shm-usage','--disable-gpu','--remote-debugging-port=0',
  '--remote-allow-origins=*','--user-data-dir='+data,
  '--no-sandbox','about:blank'
 ];
 const child=spawn(executable,args,{stdio:['ignore','ignore','pipe']});
 let stderr='';
 child.stderr.setEncoding('utf8');
 child.stderr.on('data',chunk=>{if(stderr.length<1500)stderr+=chunk.slice(0,1500);});
 const portFile=join(data,'DevToolsActivePort');
 for(let i=0;i<140;i++){
  if(child.exitCode!==null)throw Error('R54_CHROME_EXITED:'+stderr);
  try{
   const port=Number((await readFile(portFile,'utf8')).split('\n')[0]);
   if(Number.isInteger(port)&&port>0){
    const tabs=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    const target=tabs.find(tab=>tab.type==='page'&&tab.webSocketDebuggerUrl);
    if(target)return {child,target:target.webSocketDebuggerUrl};
   }
  }catch(error){
   if(!(error instanceof Error))throw error;
  }
  await delay(70);
 }
 await stopProcess(child);
 throw Error('R54_CHROME_DEVTOOLS_NOT_READY:'+stderr);
}
async function connectCdp(url){
 const socket=new WebSocket(url);
 const pending=new Map();
 let nextId=0;
 await timeout(new Promise((resolve,reject)=>{
  socket.addEventListener('open',resolve,{once:true});
  socket.addEventListener('error',reject,{once:true});
 }),10000,'CDP_CONNECT');
 socket.addEventListener('message',event=>{
  let frame;
  try{frame=JSON.parse(event.data);}
  catch(error){for(const wait of pending.values())wait.reject(error);pending.clear();return;}
  if(!frame.id)return;
  const wait=pending.get(frame.id);
  if(!wait)return;
  pending.delete(frame.id);
  if(frame.error)wait.reject(Error('CDP_'+frame.error.message));
  else wait.resolve(frame.result??{});
 });
 socket.addEventListener('close',()=>{
  for(const wait of pending.values())wait.reject(Error('R54_CDP_CLOSED'));
  pending.clear();
 });
 return {
  async send(method,params={}){
   const id=++nextId;
   const p=new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));
   socket.send(JSON.stringify({id,method,params}));
   return timeout(p,12000,method);
  },
  close(){socket.close();}
 };
}
async function evaluate(cdp,expression){
 const response=await cdp.send('Runtime.evaluate',{
  expression,awaitPromise:true,returnByValue:true
 });
 if(response.exceptionDetails)
  throw Error('R54_BROWSER_EXPRESSION_ERROR:'+
   (response.exceptionDetails.text??'unknown'));
 return response.result?.value;
}
async function eventually(cdp,expression,label,ms=14000){
 let last=null;
 for(let i=0;i<Math.ceil(ms/100);i++){
  try{
   const answer=await evaluate(cdp,expression);
   if(answer)return answer;
  }catch(error){last=error;}
  await delay(100);
 }
 throw Error('R54_BROWSER_CONDITION_'+label+':'+String(last?.message??'not satisfied'));
}
async function click(cdp,id){
 const bounds=await evaluate(cdp,`(()=>{
  const item=document.getElementById(${JSON.stringify(id)});
  if(!item||item.disabled)return null;
  item.scrollIntoView({block:'center'});
  const box=item.getBoundingClientRect();
  return {x:box.x+box.width/2,y:box.y+box.height/2};
 })()`);
 assert.ok(bounds,'无法点击或按钮不可用：'+id);
 await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',
  x:bounds.x,y:bounds.y,button:'left',clickCount:1});
 await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',
  x:bounds.x,y:bounds.y,button:'left',clickCount:1});
}
const input=(cdp,id,value)=>evaluate(cdp,`(()=>{
 const element=document.getElementById(${JSON.stringify(id)});
 element.value=${JSON.stringify(value)};
 element.dispatchEvent(new Event('input',{bubbles:true}));
 element.dispatchEvent(new Event('change',{bubbles:true}));
 return element.value;
})()`);
async function browserLogin(cdp,role,secret,code){
 await eventually(cdp,`!document.getElementById('auth-overlay').classList.contains('hidden')`,'LOGIN_OVERLAY');
 await input(cdp,'auth-role',role);
 if(code)await input(cdp,'auth-code',code);
 await input(cdp,'auth-secret',secret);
 await evaluate(cdp,`document.getElementById('auth-form').requestSubmit();true`);
 await eventually(cdp,`document.getElementById('auth-overlay').classList.contains('hidden')&&
  document.getElementById('auth-session-status').textContent.includes(${JSON.stringify(role==='parent'?'家长已验证':'独立学习者已登录')})`,'LOGIN_'+role);
}
async function parentCookie(base,secret){
 const response=await fetch(base+'/api/auth/login',{
  method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({role:'parent',secret})
 });
 assert.equal(response.status,200,'家长独立 HTTP 授权失败');
 return response.headers.get('set-cookie')?.split(';')[0];
}
async function parentAction(base,cookie,path,data){
 const response=await fetch(base+path,{
  method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},
  body:JSON.stringify(data)
 });
 assert.equal(response.status,200,'家长操作失败：'+path);
 return response.json();
}
async function acceptance(){
 const root=await mkdtemp(join(tmpdir(),'alex-r54-browser-'));
 let server=null,chrome=null,cdp=null;
 const stages=[];
 try{
  await mkdir(join(root,'alex-state'));
  server=await startAlex(join(root,'alex-state'));
  chrome=await startChrome(root);
  cdp=await connectCdp(chrome.target);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate',{url:server.base});
  await browserLogin(cdp,'parent',server.env.ALEX_PARENT_PASSWORD);
  stages.push('parent-browser-login');
  await evaluate(cdp,`window.confirm=()=>true;location.hash='#family';true`);
  await input(cdp,'onboarding-name','R54模拟小朋友');
  await input(cdp,'onboarding-age','6-8');
  await input(cdp,'onboarding-pin','647219');
  await evaluate(cdp,`document.getElementById('onboarding-form').requestSubmit();true`);
  const result=await eventually(cdp,`(()=>{
    const t=document.getElementById('onboarding-result').textContent;
    return t.includes('初始化成功')?t:false;
  })()`,'FAMILY_ONBOARDING',16000);
  const match=result.match(/([a-f0-9]{12})/);
  assert.ok(match,'家长首次设置未返回孩子登录代码');
  const learnerCode=match[1];
  const parent=await parentCookie(server.base,server.env.ALEX_PARENT_PASSWORD);
  const second=await parentAction(server.base,parent,'/api/profiles',{
   nickname:'R54第二孩子',ageBand:'9-12',interests:[]
  });
  const secondCredentials=await parentAction(server.base,parent,'/api/learners/set-pin',{
   profileId:second.profile.id,pin:'647220'
  });
  const secondCode=secondCredentials.learner.code;
  stages.push('family-onboarding-ui');
  await click(cdp,'logout');
  await browserLogin(cdp,'learner','647219',learnerCode);
  stages.push('learner-browser-login');
  await evaluate(cdp,`location.hash='#overview';true`);
  await eventually(cdp,`!document.getElementById('companion-new').disabled`,'COMPANION_READY');
  await click(cdp,'companion-new');
  await eventually(cdp,`document.getElementById('companion-messages').children.length>0`,'CONVERSATION_OPEN');
  await input(cdp,'companion-text','Hello Alex, I am studying');
  await evaluate(cdp,`document.getElementById('companion-form').requestSubmit();true`);
  await eventually(cdp,`document.getElementById('companion-messages').textContent.includes('Hello Alex, I am studying')&&
   !document.getElementById('companion-send').disabled`,'CONVERSATION_TURN',16000);
  await click(cdp,'learner-journey-refresh');
  await eventually(cdp,`!document.getElementById('learner-journey-resume').disabled`,'RESUME_AVAILABLE');
  stages.push('lesson-turn-and-resume');
  await cdp.send('Page.reload',{ignoreCache:true});
  await eventually(cdp,`document.getElementById('auth-session-status').textContent.includes('独立学习者已登录')`,'RELOAD_LOGIN');
  await eventually(cdp,`!document.getElementById('learner-journey-resume').disabled`,'RELOAD_RESUME');
  await click(cdp,'learner-journey-resume');
  await eventually(cdp,`document.getElementById('companion-messages').textContent.includes('Hello Alex, I am studying')`,'RESTORED_MESSAGES');
  stages.push('reload-and-resume-ui');
  await click(cdp,'logout');
  await browserLogin(cdp,'learner','647220',secondCode);
  await eventually(cdp,`document.getElementById('learner-journey-status').textContent.includes('已有 0 个可恢复会话')`,
   'SECOND_CHILD_EMPTY_JOURNEY');
  assert.equal(await evaluate(cdp,`document.getElementById('learner-journey-resume').disabled`),true);
  assert.equal(await evaluate(cdp,`document.getElementById('companion-messages').children.length`),0);
  stages.push('two-child-browser-isolation');
  await click(cdp,'logout');
  await browserLogin(cdp,'learner','647219',learnerCode);
  await eventually(cdp,`!document.getElementById('learner-journey-resume').disabled`,'RETURN_TO_FIRST_CHILD');
  await click(cdp,'learner-journey-resume');
  await eventually(cdp,`document.getElementById('companion-messages').textContent.includes('Hello Alex, I am studying')`,
   'FIRST_CHILD_RESTORED_AFTER_SWITCH');
  stages.push('switch-back-and-resume-ui');

  const profiles=await (await fetch(server.base+'/api/profiles',{headers:{Cookie:parent}})).json();
  assert.equal(profiles.profiles.length,1);
  await parentAction(server.base,parent,'/api/learners/set-pin',{
   profileId:profiles.profiles[0].id,pin:'738291'
  });
  // 旧浏览器 Cookie 已被服务端废止；定时刷新必须清除原儿童对话界面。
  await eventually(cdp,`document.getElementById('auth-session-status').textContent.includes('未登录')&&
   document.getElementById('companion-messages').children.length===0`,'REVOKED_BROWSER_CLEARED',16000);
  assert.equal(await evaluate(cdp,`document.getElementById('learner-journey-resume').disabled`),true);
  stages.push('pin-revocation-browser-clears-ui');
  return {status:'passed',stages,browser:'chromium-cdp',
   testsBrowserRendered:true,cloudAudioTested:false,rosRuntimeTested:false,
   realFamilyDataUsed:false};
 }finally{
  cdp?.close();
  await stopProcess(chrome?.child);
  await stopProcess(server?.child);
  await rm(root,{recursive:true,force:true});
 }
}
try{
 const report=await acceptance();
 console.log(JSON.stringify(report,null,2));
}catch(error){
 // 不输出 DOM 文本、登录代码、私密 Cookie 或测试 PIN。
 console.error('R54 浏览器验收失败：'+error.message);
 process.exitCode=1;
}
