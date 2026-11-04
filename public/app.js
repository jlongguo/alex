const $ = id => document.getElementById(id);
let state=null,lastTask=null,busy=false,refreshInFlight=false;
let companionActor=null,companionSessionId=null,companionBusy=false,companionProvider='offline';
let curriculum=[],currentLearningPlans=[];
const deniedVoice={voiceInputAllowed:false,voiceOutputAllowed:false,cloudTextAllowed:false};
let companionPrivacy={...deniedVoice};
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const color = {dock:'#8ac7a8',study_desk:'#79a4db',sofa:'#c4a4dc',story_corner:'#e7b76b'};
const labels={dock:'充电基站',study_desk:'学习书桌',sofa:'客厅沙发',story_corner:'故事角'};
async function api(path,data){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const json=await r.json();if(!r.ok||json.ok===false)throw new Error(json.message||json.error||'Request failed');return json;}
// One global status channel: action feedback must not disappear when a workspace is hidden.
function notify(message,isError=false){
 const text=String(message|| (isError?'操作失败':'操作已完成'));
 const el=$('notice');el.textContent=text;el.classList.remove('hidden');el.classList.toggle('error',isError);
 $('command-result').textContent=text;$('command-result').classList.toggle('error',isError);
}
async function act(path,data){
 const emergency=path==='/api/safety/stop';
 if(busy&&!emergency)return;
 if(!emergency)busy=true;
 try{const res=await api(path,data);notify(res.message||'操作已提交');await refresh();}
 catch(e){notify(e.message,true);}
 finally{if(!emergency)busy=false;}
}
async function refresh(){if(refreshInFlight)return;refreshInFlight=true;try{const r=await fetch('/api/state',{cache:'no-store'});if(r.status===401){await initAuth();$('connection').textContent='请登录家庭中枢';return;}if(!r.ok)throw new Error('Server unavailable');state=await r.json();render(state);$('connection').textContent='中枢已连接';$('connection').style.color='#269774';}catch(e){$('connection').textContent='连接失败';$('connection').style.color='#bc6854';}finally{refreshInFlight=false;}}
function mapDraw(s){const svgScale=10;const map=s.map;
 const rect=(r,fill,stroke='',rad=4)=>`<rect x="${r.x*svgScale}" y="${r.y*svgScale}" width="${r.w*svgScale}" height="${r.h*svgScale}" rx="${rad}" fill="${fill}" ${stroke?`stroke="${stroke}" stroke-width="1"`:''}/>`;
 const rooms=[{x:1.2,y:1.5,t:'学习区',w:18},{x:23,y:1.5,t:'客厅',w:17},{x:43,y:1.5,t:'阅读区',w:15},{x:2,y:31,t:'走廊',w:50}];
 $('rooms').innerHTML=rooms.map(r=>`<text x="${(r.x+r.w/2)*10}" y="${r.y*10+18}" font-size="12" text-anchor="middle" fill="#9bafc0" font-weight="600">${r.t}</text>`).join('')+
 map.furniture.map(f=>rect(f,'#c4d4e3')+`<text x="${(f.x+f.w/2)*10}" y="${(f.y+f.h/2)*10+4}" font-size="12" fill="#607b91" text-anchor="middle">${f.label}</text>`).join('')+map.walls.map(w=>rect(w,'#879cad','',0)).join('');
 const dests=Object.entries(map.destinations).map(([k,d])=>`<circle cx="${d.x*10}" cy="${d.y*10}" r="11" fill="${color[k]}25" stroke="${color[k]}" stroke-width="2"/><circle cx="${d.x*10}" cy="${d.y*10}" r="3.5" fill="${color[k]}"/>`).join('');
 $('obstacles').innerHTML=dests+(s.robot.obstaclePresent?'<circle cx="260" cy="170" r="25" fill="#e78d7455" stroke="#d76b52" stroke-width="2" stroke-dasharray="5 3"/><text x="260" y="174" font-size="10" text-anchor="middle" fill="#a74639">障碍</text>':'');
 const r=s.robot;const path=s.path;
 const segments=path.length?`<polyline points="${[[r.x,r.y],...path.map(p=>[p.x,p.y])].map(p=>p.map(q=>q*10).join(',')).join(' ')}" stroke="#2caa91" stroke-width="2.5" stroke-dasharray="7 6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`:'';
 $('routes').innerHTML=segments;
 $('robot').innerHTML=`<circle cx="${r.x*10}" cy="${r.y*10}" r="17" fill="#72c6ba55"/><g transform="translate(${r.x*10} ${r.y*10}) rotate(${r.heading*180/Math.PI})"><circle r="12" fill="#2f9d88" stroke="white" stroke-width="2.5"/><circle cx="4" cy="-4" r="2" fill="white"/><circle cx="4" cy="4" r="2" fill="white"/><path d="M 5 -2 L 10 0 L 5 2" fill="none" stroke="white" stroke-width="1.5"/></g>`;
}
function render(s){mapDraw(s);$('device-count').innerHTML='1 <sub>台</sub>';$('skill-count').innerHTML=s.skills.length+' <sub>项</sub>';$('task-count').innerHTML=s.tasks.length+' <sub>项</sub>';
 $('nav-skill-count').textContent=String(s.skills.length);
 const robot=s.robot;const active=s.tasks.find(t=>t.id===s.activeTaskId);const latest=s.tasks[0];
 $('battery').textContent=Math.round(robot.battery)+'%';$('position').textContent=`(${robot.x.toFixed(1)}, ${robot.y.toFixed(1)})`; $('active-task').textContent=active?labels[active.destination]:(latest?.status==='succeeded'?'已完成':'空闲');
 $('safety-state').textContent=robot.emergencyStopped?'急停锁定':robot.obstaclePresent?'障碍物存在':'正常';$('safety-state').style.color=robot.emergencyStopped?'#c4564b':'';
 $('global-safety-state').textContent=robot.emergencyStopped?'模拟急停锁定':robot.obstaclePresent?'检测到模拟障碍物':'模拟状态正常';
 const moving=robot.movement==='moving';$('motion-pill').textContent=robot.emergencyStopped?'⛔ 急停':moving?'↗ 移动中':'● 待命';$('motion-pill').className='pill '+(robot.emergencyStopped?'':moving?'green':'green');
 const p=active?.progress ?? (latest?.status==='succeeded'?100:0);$('progress-value').textContent=p+'%';$('progress-bar').style.width=p+'%';
 $('btn-reset').disabled=!robot.emergencyStopped;$('obstacle').checked=robot.obstaclePresent;
 const icons=['📚','📖','🏠']; const skillsMarkup=s.skills.map((skill,i)=>`<div class="skill-item"><div class="skill-icon">${icons[i]??'✳'}</div><div class="skill-info"><strong>${esc(skill.name)}</strong><small>${esc(skill.description)}</small></div><button type="button" data-skill="${esc(skill.id)}">启动</button></div>`).join('');
 $('skills-list').innerHTML=skillsMarkup;
 const filter=$('events-filter').value.trim().toLowerCase();
 const events=s.events.filter(e=>!filter||`${e.type} ${e.message}`.toLowerCase().includes(filter)).slice(-100).reverse();
 $('event-counter').textContent=s.events.length+' EVENTS';
 $('events').innerHTML=events.map(e=>`<div class="event-row"><span class="event-time">${new Date(e.timestamp).toLocaleTimeString('zh-CN',{hour12:false})}</span><span class="event-kind">${esc(e.type)}</span><span class="event-message" title="${esc(e.message)}">${esc(e.message)}</span></div>`).join('')||'<p class="helper">暂无符合条件的事件。</p>';
}
$('command-form').addEventListener('submit',async e=>{e.preventDefault();const t=$('command-text').value.trim();if(t)await act('/api/command',{text:t,actor:$('actor').value,requestId:'ui_'+crypto.randomUUID().replaceAll('-','')});});
document.querySelectorAll('[data-command]').forEach(b=>b.addEventListener('click',()=>{$('command-text').value=b.dataset.command;$('command-form').requestSubmit();}));
document.querySelectorAll('[data-dest]').forEach(b=>b.addEventListener('click',()=>act('/api/tasks',{capability:b.dataset.dest==='dock'?'navigation.dock':'navigation.goto',params:{destination:b.dataset.dest},actor:$('actor').value})));
$('skills-list').addEventListener('click',async e=>{
 const button=e.target.closest('[data-skill]');if(!button)return;
 const id=button.dataset.skill;
 if(authorizedActor&&['learning.english','story.interactive','quiz.science'].includes(id)){
  if(companionBusy)return;
  companionBusy=true;
  try{
   const picked=$('companion-lesson').value;
   const lesson=curriculum.find(c=>c.id===picked&&c.skillId===id);
   const res=await api('/api/skills/invoke',{id,...(lesson?{lessonId:picked}:{})});
   if(!res.session)throw new Error('SKILL_SESSION_NOT_CREATED');
   companionSessionId=res.session.id;
   $('companion-mode').value=res.session.mode;
   fillLessonOptions(res.session.mode,res.session.lessonId);
   showCompanion(res.session);
   await refreshCompanionInfo();
   window.location.hash='#overview';
   companionNotice('已从技能中心开启 '+(id==='learning.english'?'A1 英语':id==='quiz.science'?'科学小问答':'互动故事')+' 对话。');
   notify('互动技能已启动；请在 Alex 互动终端回复。');
  }catch(err){notify(err.message,true);}
  finally{companionBusy=false;}
 }else void act('/api/skills/invoke',{id,actor:$('actor').value});
});
$('btn-stop').addEventListener('click',()=>act('/api/safety/stop',{actor:$('actor').value}));
$('btn-reset').addEventListener('click',()=>act('/api/safety/reset',{actor:$('actor').value}));
$('obstacle').addEventListener('change',e=>act('/api/environment',{obstaclePresent:e.target.checked,actor:$('actor').value}));
$('events-filter').addEventListener('input',()=>{if(state)render(state);});
setInterval(()=>{$('clock').textContent=new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});},1000);
let eventStream=null,refreshTimer=null;
function refreshCurrentView(force=false){
 if(force){lastGatewayPoll=0;lastWorkflowRefresh=0;lastPlanPoll=0;lastProposalPoll=0;lastFamilyPoll=0;lastAuditPoll=0;}
 switch(document.body.dataset.currentPage){
  case 'devices':void refreshGateway();break;
  case 'tasks':void refreshWorkflows();void refreshPlans();void refreshProposals();break;
  case 'events':void refreshAudit();break;
  case 'family':void refreshFamily();break;
 }
}
function launchConsole(){
 void refresh();
 void refreshCompanionInfo();
 refreshCurrentView(true);
 if(refreshTimer===null)refreshTimer=setInterval(()=>{void refresh();refreshCurrentView();},1800);
 if(!eventStream){
  eventStream=new EventSource('/api/events');
  eventStream.addEventListener('home-event',()=>{void refresh();refreshCurrentView(true);});
 }
}
window.addEventListener('hashchange',()=>refreshCurrentView(true));
window.addEventListener('pagehide',stopConsole);
let currentAuthSession=null;
function stopConsole(){
 if(refreshTimer!==null){clearInterval(refreshTimer);refreshTimer=null;}
 eventStream?.close();eventStream=null;
}
function renderAuthEntry(session){
 currentAuthSession=session;
 const entry=$('auth-entry');
 const status=$('auth-session-status');
 const local=session.mode==='local';
 const verified=local&&session.authenticated;
 $('logout').classList.toggle('hidden',!verified);
 entry.classList.toggle('hidden',verified&&session.actor==='parent');
 if(!local){status.textContent='演示模式 · 无家长授权';entry.textContent='启用家长授权';}
 else if(!verified){status.textContent='未登录';entry.textContent='家长登录';}
 else if(session.actor==='child'){status.textContent=session.learnerId?'独立学习者已登录':'共享儿童（兼容旧版）';entry.textContent='切换为家长';}
 else {status.textContent='家长已验证';entry.textContent='家长登录';}
}
function openAuthDialog(session){
 const demo=session.mode==='demo';
 $('auth-form').classList.toggle('hidden',demo);
 $('auth-demo-guide').classList.toggle('hidden',!demo);
 $('auth-overlay').classList.remove('hidden');
 if(!demo){
  $('auth-role').value='parent';
  $('auth-code').value='';
  $('auth-code').classList.add('hidden');
  $('auth-code-label').classList.add('hidden');
  $('auth-code').required=false;
  $('auth-secret').minLength=12;
  $('auth-error').textContent='';
  $('auth-secret').value='';
  $('auth-secret').focus();
 }else $('auth-demo-close').focus();
}
function applySession(session){
 authorizedActor=session.mode==='local'&&session.authenticated?session.actor:null;
 const companionIdentity=session.learnerId?'learner:'+session.learnerId:authorizedActor;
 if(companionActor!==companionIdentity) {
  voiceBridge.interrupt('identity-changed');
  cloudAudioBridge.interrupt('identity-changed');
  audioCapabilities={inputAllowed:false,outputAllowed:false,provider:'disabled'};
  companionPrivacy={...deniedVoice};voiceBridge.setConsent(companionPrivacy);
  privacyPollAt=0;
  companionActor=companionIdentity;companionSessionId=null;
  $('companion-messages').replaceChildren();
 }
 for(const id of ['companion-new','companion-delete','companion-text','companion-send','companion-mode','companion-history','companion-progress-scope']){
  $(id).disabled=!authorizedActor;
 }
 $('companion-privacy').textContent=authorizedActor
  ?'当前为经过验证的 '+(authorizedActor==='parent'?'家长':'儿童')+' 会话；聊天不会控制设备。'
  :'需启用本地家庭认证并登录，才能进行 AI 对话。';
 const parent=authorizedActor==='parent',local=!!authorizedActor;
 $('gateway-section').classList.toggle('hidden',!parent);
 $('device-access-note').classList.toggle('hidden',parent);
 $('workflow-section').classList.toggle('hidden',!parent);
 $('plan-section').classList.toggle('hidden',!parent);
 // Only parents can review pending proposals; children may create inert proposals.
 $('proposal-section').classList.toggle('hidden',!local);
 $('proposal-review-panel').classList.toggle('hidden',!parent);
 $('tasks-access-note').classList.toggle('hidden',parent);
 $('family-private').classList.toggle('hidden',!parent);
 $('family-access-note').classList.toggle('hidden',parent);
 $('audit-access-note').classList.toggle('hidden',parent);
 $('audit-list').classList.toggle('hidden',!parent);
 if(parent){lastGatewayPoll=0;lastFamilyPoll=0;lastAuditPoll=0;}
}
async function initAuth(){
 try{
  const response=await fetch('/api/auth/session',{cache:'no-store'});
  if(!response.ok)throw new Error('认证服务不可用');
  const session=await response.json();
  renderAuthEntry(session);
  $('actor').disabled=session.mode!=='demo';
  applySession(session);
  if(session.mode==='local'&&!session.authenticated){
   stopConsole();
   openAuthDialog(session);
   return;
  }
  $('auth-overlay').classList.add('hidden');
  if(session.mode==='local')$('actor').value=session.actor;
  launchConsole();
  void refreshCompanionPrivacy(true);
 }catch(err){$('connection').textContent='认证服务连接失败';notify(err.message,true);}
}
$('auth-entry').addEventListener('click',async()=>{
 const session=currentAuthSession;
 if(!session)return;
 if(session.mode==='demo'){openAuthDialog(session);return;}
 if(!session.authenticated){openAuthDialog(session);return;}
 if(session.actor==='child'){
  if(!window.confirm('将退出儿童会话并切换到家长登录，是否继续？'))return;
  try{
   const r=await fetch('/api/auth/logout',{method:'POST'});
   if(!r.ok)throw new Error('退出儿童会话失败');
   location.reload();
  }catch(e){notify(e.message,true);}
 }
});
$('auth-demo-close').addEventListener('click',()=>{$('auth-overlay').classList.add('hidden');$('auth-entry').focus();});
document.querySelectorAll('[data-parent-auth-entry]').forEach(button=>button.addEventListener('click',()=>$('auth-entry').click()));
$('auth-role').addEventListener('change',()=>{
 const role=$('auth-role').value;
 $('auth-secret').minLength=role==='parent'?12:6;
 const learner=role==='learner';
 $('auth-code').classList.toggle('hidden',!learner);
 $('auth-code-label').classList.toggle('hidden',!learner);
 $('auth-code').required=learner;
});
$('auth-form').addEventListener('submit',async e=>{
  e.preventDefault();
  $('auth-error').textContent='';
  const role=$('auth-role').value,secret=$('auth-secret').value;
  const code=role==='learner'?$('auth-code').value.trim().toLowerCase():undefined;
  try{
    const response=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role,secret,...(code?{code}:{})})});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'登录失败');
    $('auth-secret').value='';
    $('auth-code').value='';
    await initAuth();
  }catch(err){$('auth-error').textContent=err.message;}
});
$('logout').addEventListener('click',async()=>{
  await fetch('/api/auth/logout',{method:'POST'});
  location.reload();
});
// v0.5 local-only virtual device dispatch. Device tokens are NEVER exposed to this console.
let lastGatewayPoll=0,gatewayBusy=false,authorizedActor=null;
async function refreshGateway(){
  if(!authorizedActor||authorizedActor!=='parent')return;
  const now=Date.now();if(now-lastGatewayPoll<1400)return;lastGatewayPoll=now;
  try{
    const [devicesResponse,jobsResponse,mapResponse]=await Promise.all([fetch('/api/devices'),fetch('/api/gateway/jobs'),fetch('/api/gateway/navigation-map')]);
    if(!devicesResponse.ok||!jobsResponse.ok)throw new Error('需要本地家长认证');
    const allDevices=(await devicesResponse.json()).devices.filter(d=>d.id?.startsWith('dev-'));
    const jobs=(await jobsResponse.json()).jobs;
    if(mapResponse.ok)renderGatewayNavigationMap((await mapResponse.json()).map,jobs);
    $('device-count').innerHTML=`${1+allDevices.length} <sub>台</sub>`;
    $('nav-device-count').textContent=String(1+allDevices.length);
    const select=$('gateway-device'),current=select.value;
    select.innerHTML=allDevices.filter(d=>!d.revoked).map(d=>`<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('');
    if(allDevices.some(d=>d.id===current&&!d.revoked))select.value=current;
    $('gateway-device-list').innerHTML=allDevices.length?allDevices.map(d=>{
      const needs=(d.declaredCapabilities||[]).filter(c=>!d.capabilities.includes(c));
      return `<div class="skill-item"><div class="skill-icon">🤖</div><div class="skill-info"><strong>${esc(d.name)}</strong><small>${d.revoked?'已撤销':`已授权：${esc((d.capabilities||[]).join(', ')||'暂无')} · 待批准：${esc(needs.join(', ')||'无')}`}</small></div>${needs.length&&!d.revoked?`<button type="button" data-approve="${esc(d.id)}">批准虚拟能力</button>`:''}</div>`;
    }).join(''):'<p class="helper">尚未配对设备。请在家长账户中生成配对码并运行 scripts/virtual-device.mjs。</p>';
    $('gateway-tasks').innerHTML=jobs.slice(0,8).map(j=>`<div class="event-row"><span class="event-time">${esc(j.status)}</span><span class="event-kind">${esc(j.capability)}</span><span class="event-message">${esc(j.deviceId)} · ${esc(JSON.stringify(j.params))}${j.telemetry?` · ${esc(j.telemetry.phase)} ${j.telemetry.progress}% · (${j.telemetry.pose.x.toFixed(1)},${j.telemetry.pose.y.toFixed(1)})`:''}</span>${['queued','running'].includes(j.status)?`<button type="button" data-cancel-job="${esc(j.id)}">取消</button>`:''}</div>`).join('')||'<p class="helper">暂无网关任务。</p>';
    $('gateway-notice').textContent=`已绑定 ${allDevices.length} 个设备；最近 ${jobs.length} 项任务。只有显式批准的虚拟能力才能执行。`;
  }catch(e){$('gateway-notice').textContent=e.message;}
}
function renderGatewayNavigationMap(map,jobs){
  const svg=$('gateway-navigation-map');if(!svg)return;
  const rects=[...map.walls,...map.furniture].map(x=>`<rect x="${x.x*10}" y="${x.y*10}" width="${x.w*10}" height="${x.h*10}" rx="2" fill="#c5d5e5"/>`).join('');
  const markers=Object.entries(map.destinations).map(([name,p])=>`<circle cx="${p.x*10}" cy="${p.y*10}" r="7" fill="#57b49c"/><text x="${p.x*10+10}" y="${p.y*10-8}" font-size="11" fill="#294e60">${esc(name)}</text>`).join('');
  const positions=new Map();for(const job of jobs)if(job.telemetry&&!positions.has(job.deviceId))positions.set(job.deviceId,job.telemetry);
  const robots=[...positions.values()].map(t=>`<g><circle cx="${t.pose.x*10}" cy="${t.pose.y*10}" r="9" fill="#2e7cc5" stroke="white" stroke-width="2"/><text x="${t.pose.x*10+11}" y="${t.pose.y*10+5}" font-size="12" fill="#17354b">${t.progress}%</text></g>`).join('');
  svg.innerHTML=rects+markers+robots;
}
$('gateway-pair-form').addEventListener('submit',async e=>{
  e.preventDefault();if(gatewayBusy)return;gatewayBusy=true;
  try{
    const name=$('gateway-pair-name').value.trim();if(!name)throw new Error('请填写设备名称');
    const started=await api('/api/devices/pair/start',{});
    const linked=await api('/api/devices/pair/complete',{code:started.code,name});
    const command=`ALEX_DEVICE_ID='${linked.deviceId}' ALEX_DEVICE_TOKEN='${linked.token}' npm run virtual-device`;
    $('gateway-pair-secret').textContent=`设备凭证仅显示一次，请勿分享：\n${command}\n\n在项目目录的另一个终端运行上述命令。随后在此批准设备声明的虚拟能力。`;
    $('gateway-pair-secret').classList.remove('hidden');
    $('gateway-pair-name').value='';lastGatewayPoll=0;await refreshGateway();
  }catch(err){$('gateway-notice').textContent=err.message;}
  finally{gatewayBusy=false;}
});
$('gateway-command-form').addEventListener('submit',async e=>{
  e.preventDefault();if(gatewayBusy)return;gatewayBusy=true;
  try{
    const deviceId=$('gateway-device').value,destination=$('gateway-action').value;
    if(!deviceId)throw new Error('请先配对一个虚拟设备');
    const requestId='ui_'+crypto.randomUUID().replaceAll('-','');
    const result=await api('/api/gateway/dispatch',{deviceId,capability:'sim.navigation.goto',params:{destination},requestId});
    $('gateway-notice').textContent=`已下发任务 ${result.job.id}`;lastGatewayPoll=0;await refreshGateway();
  }catch(err){$('gateway-notice').textContent=err.message;}
  finally{gatewayBusy=false;}
});
$('gateway-device-list').addEventListener('click',async e=>{
  const button=e.target.closest('[data-approve]');if(!button)return;
  try{
    const deviceId=button.dataset.approve;
    const response=await fetch('/api/devices');const devices=(await response.json()).devices;
    const device=devices.find(d=>d.id===deviceId);
    if(!device)throw new Error('设备不存在');
    await api('/api/devices/capabilities/approve',{deviceId,capabilities:device.declaredCapabilities||[]});
    $('gateway-notice').textContent='虚拟能力已获得家长授权';lastGatewayPoll=0;await refreshGateway();
  }catch(err){$('gateway-notice').textContent=err.message;}
});
$('gateway-tasks').addEventListener('click',async e=>{
  const button=e.target.closest('[data-cancel-job]');if(!button)return;
  try{await api('/api/gateway/cancel',{jobId:button.dataset.cancelJob});lastGatewayPoll=0;await refreshGateway();}
  catch(err){$('gateway-notice').textContent=err.message;}
});


// v0.6: parent-only, local-auth workflow console. No hardware actuation APIs.
let lastWorkflowRefresh=0,workflowBusy=false;
async function refreshWorkflows(){
  if(authorizedActor!=='parent')return;
  const now=Date.now();if(now-lastWorkflowRefresh<1200)return;lastWorkflowRefresh=now;
  try{
    const [workflowsResponse,devicesResponse]=await Promise.all([fetch('/api/workflows'),fetch('/api/devices')]);
    if(!workflowsResponse.ok||!devicesResponse.ok)throw new Error('需要家长登录');
    const workflows=(await workflowsResponse.json()).workflows;
    const devices=(await devicesResponse.json()).devices.filter(d=>d.id?.startsWith('dev-')&&!d.revoked&&['sim.navigation.goto','audio.output'].every(cap=>(d.capabilities||[]).includes(cap)));
    const select=$('workflow-device'),previous=select.value;
    select.innerHTML='<option value="">自动选择已授权设备</option>'+devices.map(d=>`<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('');
    if(devices.some(d=>d.id===previous))select.value=previous;
    $('workflow-list').innerHTML=workflows.slice(0,10).map(w=>{
      const steps=w.steps.map(s=>`${esc(s.name)}: ${esc(s.status)}`).join(' · ');
      return `<div class="event-row"><span class="event-time">${esc(w.status)}</span><span class="event-kind">${esc(w.recipe)}</span><span class="event-message">${esc(w.deviceId)} · ${steps}${w.reason?' · '+esc(w.reason):''}</span>${['dispatching','navigating','speaking'].includes(w.status)?`<button type="button" data-cancel-workflow="${esc(w.id)}">取消</button>`:''}</div>`;
    }).join('')||'<p class="helper">暂无工作流。请先启动一台已批准导航和音频输出能力的虚拟设备。</p>';
  }catch(err){$('workflow-notice').textContent=err.message;}
}
$('workflow-form').addEventListener('submit',async event=>{
  event.preventDefault();if(workflowBusy)return;workflowBusy=true;
  try{
    const recipe=$('workflow-recipe').value,deviceId=$('workflow-device').value||undefined;
    const requestId='wfui_'+crypto.randomUUID().replaceAll('-','');
    const result=await api('/api/workflows/start',{recipe,deviceId,requestId});
    $('workflow-notice').textContent=`工作流已创建：${result.workflow.id}，等待虚拟设备反馈。`;
    lastWorkflowRefresh=0;await refreshWorkflows();
  }catch(err){$('workflow-notice').textContent=err.message;}
  finally{workflowBusy=false;}
});
$('workflow-list').addEventListener('click',async event=>{
  const button=event.target.closest('[data-cancel-workflow]');if(!button)return;
  try{await api('/api/workflows/cancel',{workflowId:button.dataset.cancelWorkflow});lastWorkflowRefresh=0;await refreshWorkflows();}
  catch(err){$('workflow-notice').textContent=err.message;}
});


// v0.7 durable plan console. All state comes from authenticated server endpoints.
let lastPlanPoll=0,planBusy=false;
async function refreshPlans(){
  if(authorizedActor!=='parent')return;
  if(Date.now()-lastPlanPoll<1400)return;lastPlanPoll=Date.now();
  try{
    const [pr,er]=await Promise.all([fetch('/api/plans'),fetch('/api/plans/events?after=0')]);
    if(!pr.ok||!er.ok)throw new Error('需要家长登录');
    const ps=(await pr.json()).plans,ev=(await er.json()).events;
    $('plan-list').innerHTML=ps.slice(0,12).map(p=>{
      const steps=p.steps.map(s=>`${esc(s.id)}: ${esc(s.status)}`).join(' · ');
      return `<div class="event-row"><span class="event-time">${esc(p.status)}</span><span class="event-kind">${esc(p.templateId)}</span><span class="event-message">${esc(p.deviceId)} · ${steps}</span>${p.status==='running'?`<button type="button" data-cancel-plan="${esc(p.id)}">取消</button>`:''}</div>`;
    }).join('')||'<p class="helper">暂无计划。先配对并批准虚拟设备的 audio.output 与 sim.navigation.goto 能力。</p>';
    $('plan-events').innerHTML=ev.slice(-12).reverse().map(e=>`<div class="event-row"><span class="event-time">#${e.seq}</span><span class="event-kind">${esc(e.type)}</span><span class="event-message">${esc(e.planId)}${e.stepId?' · '+esc(e.stepId):''}</span></div>`).join('')||'<p class="helper">暂无计划事件。</p>';
  }catch(err){$('plan-notice').textContent=err.message;}
}
$('plan-form').addEventListener('submit',async e=>{
  e.preventDefault();if(planBusy)return;planBusy=true;
  try{
    const result=await api('/api/plans/start',{templateId:$('plan-template').value,requestId:'planui_'+crypto.randomUUID().replaceAll('-','')});
    $('plan-notice').textContent=`计划已创建 ${result.plan.id}，等待设备反馈。`;
    lastPlanPoll=0;await refreshPlans();
  }catch(err){$('plan-notice').textContent=err.message;}
  finally{planBusy=false;}
});
$('plan-list').addEventListener('click',async e=>{
  const button=e.target.closest('[data-cancel-plan]');if(!button)return;
  try{await api('/api/plans/cancel',{planId:button.dataset.cancelPlan});lastPlanPoll=0;await refreshPlans();}
  catch(err){$('plan-notice').textContent=err.message;}
});



// v0.8: family intent -> inert proposal -> parent approval -> guarded v0.7 plan.
let lastProposalPoll=0,proposalBusy=false;
const proposalNames={'learn.at.desk':'去书桌练习英语','story.at.corner':'去故事角讲故事','story.here':'原地讲故事'};
async function refreshProposals(){
  if(authorizedActor!=='parent')return;
  if(Date.now()-lastProposalPoll<1200)return;lastProposalPoll=Date.now();
  try{
    const response=await fetch('/api/proposals',{cache:'no-store'});
    if(!response.ok)throw new Error('需家长登录才能查看建议队列');
    const result=await response.json(),list=result.proposals;
    $('proposal-list').innerHTML=list.slice(0,15).map(p=>`<div class="event-row">
      <span class="event-time">${esc(p.status)}</span>
      <span class="event-kind">${esc(proposalNames[p.templateId]||p.templateId)}</span>
      <span class="event-message">${esc(p.actor)} · ${esc(p.deviceId||'自动选择')} ${p.planId?'· '+esc(p.planId):''}</span>
      ${p.status==='pending'?`<button type="button" data-proposal-approve="${esc(p.id)}">家长批准</button><button type="button" data-proposal-reject="${esc(p.id)}">拒绝</button>`:''}
      <button type="button" data-proposal-timeline="${esc(p.id)}">事件</button>
    </div>`).join('')||'<p class="helper">暂无待审核建议。</p>';
    $('proposal-notice').textContent=`建议分类器：${result.provider} · ${list.length} 条记录。请检查任务目标、权限与设备能力后再批准。`;
  }catch(err){$('proposal-notice').textContent=err.message;}
}
$('proposal-form').addEventListener('submit',async event=>{
  event.preventDefault();if(proposalBusy)return;proposalBusy=true;
  try{
    const result=await api('/api/proposals/create',{text:$('proposal-text').value.trim(),requestId:'pui_'+crypto.randomUUID().replaceAll('-','')});
    $('proposal-notice').textContent=result.ok?'计划建议已生成，尚未执行。':'无法生成：'+(result.message||'不支持的意图');
    lastProposalPoll=0;await refreshProposals();
  }catch(err){$('proposal-notice').textContent=err.message;}
  finally{proposalBusy=false;}
});
$('proposal-list').addEventListener('click',async event=>{
  const a=event.target.closest('[data-proposal-approve]'),r=event.target.closest('[data-proposal-reject]'),t=event.target.closest('[data-proposal-timeline]');
  if(!a&&!r&&!t)return;
  try{
    if(t){
      const response=await fetch('/api/proposals/timeline/'+encodeURIComponent(t.dataset.proposalTimeline));
      if(!response.ok)throw new Error('无法读取计划事件');
      const data=await response.json();
      $('proposal-timeline').innerHTML=data.events.map(e=>`<div class="event-row"><span class="event-time">#${esc(e.seq)}</span><span class="event-kind">${esc(e.type)}</span><span class="event-message">${esc(e.source)} · ${esc(e.planId||e.proposalId)}</span></div>`).join('');
      return;
    }
    if(proposalBusy)return;proposalBusy=true;
    const result=await api(a?'/api/proposals/approve':'/api/proposals/reject',{proposalId:a?a.dataset.proposalApprove:r.dataset.proposalReject});
    $('proposal-notice').textContent=result.ok?(a?'计划已通过审核并进入执行器':'计划已拒绝'):'操作未执行：'+(result.message||'失败');
    lastProposalPoll=0;await refreshProposals();
  }catch(err){$('proposal-notice').textContent=err.message;}
  finally{proposalBusy=false;}
});


// Family and privacy controls. Private writes require server-validated parent session.
let lastFamilyPoll=0,lastAuditPoll=0,familyBusy=false;
async function refreshFamily(){
 if(authorizedActor!=='parent')return;
 if(Date.now()-lastFamilyPoll<1500)return;lastFamilyPoll=Date.now();
 try{
  const [pr,mr,lr,cr,plansResponse]=await Promise.all([
    fetch('/api/profiles',{cache:'no-store'}),
    fetch('/api/memory',{cache:'no-store'}),
    fetch('/api/learners/access',{cache:'no-store'}),
    fetch('/api/learning/catalog',{cache:'no-store'}),
    fetch('/api/learning/overview',{cache:'no-store'})
  ]);
  if(!pr.ok||!mr.ok||!lr.ok||!cr.ok||!plansResponse.ok)
    throw new Error('需要家长身份读取家庭资料');
  const profiles=(await pr.json()).profiles,memories=(await mr.json()).entries;
  const learners=(await lr.json()).learners;
  curriculum=(await cr.json()).courses;
  const plans=(await plansResponse.json()).overview;
  currentLearningPlans=plans;
  const profileSelect=$('learner-profile'),selectedProfile=profileSelect.value;
  profileSelect.replaceChildren();
  for(const profile of profiles){
   const option=document.createElement('option');
   option.value=profile.id;option.textContent=profile.nickname;profileSelect.append(option);
  }
  if(profiles.some(p=>p.id===selectedProfile))profileSelect.value=selectedProfile;
  const privacySelect=$('learner-privacy-profile'),priorPrivacy=privacySelect.value;
  privacySelect.replaceChildren();
  for(const profile of profiles){
    const option=document.createElement('option');
    option.value=profile.id;option.textContent=profile.nickname;privacySelect.append(option);
  }
  if(profiles.some(p=>p.id===priorPrivacy))privacySelect.value=priorPrivacy;
  await loadSelectedLearnerPrivacy();
  const pSelect=$('learning-plan-profile'),priorProfile=pSelect.value;
  pSelect.replaceChildren();
  for(const profile of profiles){
    const item=document.createElement('option');
    item.value=profile.id;item.textContent=profile.nickname;pSelect.append(item);
  }
  if(profiles.some(p=>p.id===priorProfile))pSelect.value=priorProfile;
  const cSelect=$('learning-plan-course'),priorCourse=cSelect.value;
  cSelect.replaceChildren();
  for(const course of curriculum){
    const item=document.createElement('option');
    item.value=course.id;item.textContent=course.title+' · '+course.version;
    cSelect.append(item);
  }
  if(curriculum.some(c=>c.id===priorCourse))cSelect.value=priorCourse;
  $('learning-plan-list').innerHTML=plans.map(plan=>{
    const profile=profiles.find(p=>p.id===plan.profileId);
    const course=curriculum.find(c=>c.id===plan.courseId);
    return `<div class="skill-item"><div class="skill-info"><strong>${esc(profile?.nickname||'学习者')}：${esc(course?.title||plan.courseId)}</strong><small>已完成 ${plan.completed}/${plan.targetCompletions} 次 · ${plan.status==='active'?'进行中':'已暂停'} · 内容版本 ${esc(course?.version||'未知')}</small></div><button type="button" data-learning-pause="${esc(plan.id)}" data-next-status="${plan.status==='active'?'paused':'active'}">${plan.status==='active'?'暂停':'恢复'}</button><button type="button" data-learning-delete="${esc(plan.id)}">删除计划</button></div>`;
  }).join('')||'<p class="helper">暂无已分配课程。</p>';
  $('learner-access-list').innerHTML=learners.map(row=>{
   const profile=profiles.find(p=>p.id===row.profileId);
   return `<div class="skill-item"><div class="skill-info"><strong>${esc(profile?.nickname||'已删除的学习者')}</strong><small>登录代码：<code>${esc(row.code)}</code>（与 PIN 分开保管）</small></div><button type="button" data-revoke-learner="${esc(row.profileId)}">撤销登录</button></div>`;
  }).join('')||'<p class="helper">尚未给任何学习者设置独立 PIN。</p>';
  $('profile-list').innerHTML=profiles.map(p=>`<div class="skill-item"><div class="skill-icon">♧</div><div class="skill-info"><strong>${esc(p.nickname)}</strong><small>${esc(p.ageBand)} · ${esc(p.interests.join('、')||'无兴趣标签')}</small></div><button type="button" data-remove-profile="${esc(p.id)}">删除档案</button></div>`).join('')||'<p class="helper">尚无学习者档案。</p>';
  $('memory-list').innerHTML=memories.slice(-40).reverse().map(m=>`<div class="event-row"><span class="event-time">${esc(m.scope)}</span><span class="event-kind">记忆</span><span class="event-message" title="${esc(m.text)}">${esc(m.text)}</span><button type="button" data-remove-memory="${esc(m.id)}">删除</button></div>`).join('')||'<p class="helper">没有已保存的长期记忆。</p>';
 }catch(err){$('family-notice').textContent=err.message;notify(err.message,true);}
}
async function refreshAudit(){
 if(authorizedActor!=='parent')return;
 if(Date.now()-lastAuditPoll<1800)return;lastAuditPoll=Date.now();
 try{
  const response=await fetch('/api/audit',{cache:'no-store'});
  if(!response.ok)throw new Error('需要家长身份读取操作审计');
  const events=(await response.json()).events;
  $('audit-list').innerHTML=events.slice(-50).reverse().map(e=>`<div class="event-row"><span class="event-time">${esc(e.timestamp||e.at||'—')}</span><span class="event-kind">${esc(e.action||e.type||'操作')}</span><span class="event-message">${esc(e.actor||'—')} · ${esc(e.outcome||'—')}</span></div>`).join('')||'<p class="helper">暂无审计记录。</p>';
 }catch(err){$('audit-access-note').textContent=err.message;}
}
$('learning-plan-form').addEventListener('submit',async event=>{
 event.preventDefault();
 if(authorizedActor!=='parent'||familyBusy)return;
 familyBusy=true;
 try{
  const result=await api('/api/learning/assign',{
   profileId:$('learning-plan-profile').value,courseId:$('learning-plan-course').value,
   targetCompletions:Number($('learning-plan-target').value)
  });
  lastFamilyPoll=0;await refreshFamily();
  notify('已为学习者安排文字课程：'+result.plan.courseId);
 }catch(error){notify(error.message,true);}
 finally{familyBusy=false;}
});
$('learning-plan-list').addEventListener('click',async event=>{
 if(authorizedActor!=='parent'||familyBusy)return;
 const changed=event.target.closest('[data-learning-pause]');
 const removed=event.target.closest('[data-learning-delete]');
 if(!changed&&!removed)return;
 if(removed&&!window.confirm('仅删除课程计划，不删除已完成的文字练习成果。确定？'))return;
 familyBusy=true;
 try{
  if(changed)await api('/api/learning/change',{id:changed.dataset.learningPause,status:changed.dataset.nextStatus});
  else await api('/api/learning/delete',{id:removed.dataset.learningDelete});
  lastFamilyPoll=0;await refreshFamily();notify('学习计划已更新');
 }catch(error){notify(error.message,true);}
 finally{familyBusy=false;}
});
async function loadSelectedLearnerPrivacy(){
 if(authorizedActor!=='parent')return;
 const id=$('learner-privacy-profile').value;
 if(!id){$('learner-privacy-status').textContent='请先创建学习者档案。';return;}
 try{
  const response=await fetch('/api/learner/privacy?profileId='+encodeURIComponent(id),{cache:'no-store'});
  if(!response.ok)throw new Error('无法加载学习者隐私授权');
  const data=(await response.json()).preferences;
  if($('learner-privacy-profile').value!==id)return;
  $('learner-privacy-mic').checked=data.voiceInputAllowed;
  $('learner-privacy-speech').checked=data.voiceOutputAllowed;
  $('learner-privacy-cloud-asr').checked=!!data.cloudAudioInputAllowed;
  $('learner-privacy-cloud-tts').checked=!!data.cloudAudioOutputAllowed;
  $('learner-privacy-cloud').checked=data.cloudTextAllowed;
  $('learner-privacy-language').value=data.preferredLanguage;
  $('learner-privacy-pace').value=data.learningPace;
  $('learner-privacy-topic').value=data.topics?.[0]??'';
  $('learner-privacy-status').textContent='当前孩子授权已加载。云端文字：'+
    (data.cloudTextAllowed?'允许':'禁止')+'；语音输入：'+
    (data.voiceInputAllowed?'允许':'禁止')+'；朗读：'+
    (data.voiceOutputAllowed?'允许':'禁止')+'。';
 }catch(err){$('learner-privacy-status').textContent=err.message;}
}
$('learner-privacy-profile').addEventListener('change',()=>void loadSelectedLearnerPrivacy());
$('learner-privacy-form').addEventListener('submit',async event=>{
 event.preventDefault();
 if(authorizedActor!=='parent'||familyBusy)return;
 const profileId=$('learner-privacy-profile').value;
 const cloudTextAllowed=$('learner-privacy-cloud').checked;
 if(cloudTextAllowed&&!window.confirm('启用云端文字模型会将该孩子输入的文字和近期聊天发送给家长配置的第三方模型服务商。确认授权？'))return;
 const cloudAudioInputAllowed=$('learner-privacy-cloud-asr').checked;
 const cloudAudioOutputAllowed=$('learner-privacy-cloud-tts').checked;
 if((cloudAudioInputAllowed||cloudAudioOutputAllowed)&&
   !window.confirm('云端语音会向家长配置的第三方供应商上传短音频（识别）或选中的文字（合成）；与浏览器权限不同。确认单独授权？'))return;
 familyBusy=true;
 try{
  await api('/api/learner/privacy',{
   profileId,preferences:{
    voiceInputAllowed:$('learner-privacy-mic').checked,
    voiceOutputAllowed:$('learner-privacy-speech').checked,
    cloudTextAllowed,cloudAudioInputAllowed,cloudAudioOutputAllowed,
    preferredLanguage:$('learner-privacy-language').value,
    learningPace:$('learner-privacy-pace').value,
    topics:$('learner-privacy-topic').value?[$('learner-privacy-topic').value]:[]
   }
  });
  lastFamilyPoll=0;await refreshFamily();notify('学习者隐私授权与偏好已保存');
 }catch(err){notify(err.message,true);}
 finally{familyBusy=false;}
});
$('learner-pin-form').addEventListener('submit',async e=>{
 e.preventDefault();
 if(authorizedActor!=='parent'||familyBusy)return;
 familyBusy=true;
 try{
  const profileId=$('learner-profile').value;
  const pin=$('learner-pin').value;
  const result=await api('/api/learners/set-pin',{profileId,pin});
  $('learner-pin').value='';
  lastFamilyPoll=0;await refreshFamily();
  notify('学习者专属登录代码：'+result.learner.code+'。请私下保存，PIN 不会再次显示。');
 }catch(error){notify(error.message,true);}
 finally{familyBusy=false;}
});
$('learner-access-list').addEventListener('click',async event=>{
 const button=event.target.closest('[data-revoke-learner]');
 if(!button||authorizedActor!=='parent'||familyBusy)return;
 if(!window.confirm('撤销此学习者的登录凭据并使已登录会话失效？历史对话暂保留，删除档案时将一起删除。'))return;
 familyBusy=true;
 try{
  await api('/api/learners/revoke',{profileId:button.dataset.revokeLearner});
  lastFamilyPoll=0;await refreshFamily();
  notify('已撤销此学习者专属登录凭据。');
 }catch(error){notify(error.message,true);}
 finally{familyBusy=false;}
});
$('profile-form').addEventListener('submit',async e=>{
 e.preventDefault();if(familyBusy||authorizedActor!=='parent')return;familyBusy=true;
 try{
  const interests=$('profile-interests').value.split(/[,，]/).map(v=>v.trim()).filter(Boolean);
  await api('/api/profiles',{nickname:$('profile-name').value.trim(),ageBand:$('profile-age').value,interests});
  $('profile-form').reset();lastFamilyPoll=0;await refreshFamily();notify('学习者档案已保存');
 }catch(err){notify(err.message,true);}finally{familyBusy=false;}
});
$('memory-form').addEventListener('submit',async e=>{
 e.preventDefault();if(familyBusy||authorizedActor!=='parent')return;familyBusy=true;
 try{await api('/api/memory',{scope:$('memory-scope').value,text:$('memory-text').value.trim()});$('memory-text').value='';lastFamilyPoll=0;await refreshFamily();notify('记忆已保存');}
 catch(err){notify(err.message,true);}finally{familyBusy=false;}
});
$('profile-list').addEventListener('click',async e=>{
 const button=e.target.closest('[data-remove-profile]');if(!button||authorizedActor!=='parent')return;
 if(!window.confirm('删除此学习者档案会同时撤销专属登录凭据、注销会话并清除其聊天及文字学习记录。确定继续？'))return;
 try{await api('/api/profiles/delete',{id:button.dataset.removeProfile});lastFamilyPoll=0;await refreshFamily();notify('档案已删除');}catch(err){notify(err.message,true);}
});
$('memory-list').addEventListener('click',async e=>{
 const button=e.target.closest('[data-remove-memory]');if(!button||authorizedActor!=='parent')return;
 if(!window.confirm('确定永久删除这条记忆？'))return;
 try{await api('/api/memory/delete',{id:button.dataset.removeMemory});lastFamilyPoll=0;await refreshFamily();notify('记忆已删除');}catch(err){notify(err.message,true);}
});
$('privacy-export').addEventListener('click',async()=>{
 if(authorizedActor!=='parent')return;
 try{
  const r=await fetch('/api/privacy/export',{cache:'no-store'});if(!r.ok)throw new Error('导出需要家长登录');
  const payload=await r.json();
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='alex-family-private-export.json';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  notify('隐私数据已导出至本地文件。请妥善保管');
 }catch(err){notify(err.message,true);}
});
$('privacy-erase').addEventListener('click',async()=>{
 if(authorizedActor!=='parent')return;
 const scope=$('privacy-erase-scope').value;
 if(!window.confirm(`确定清除 ${scope} 范围的记忆及相关聊天记录？此操作不可撤销，审计、档案及第三方模型已接收的数据不会被删除。`))return;
 try{const r=await api('/api/privacy/erase',{scope});lastFamilyPoll=0;await refreshFamily();companionSessionId=null;$('companion-messages').replaceChildren();await refreshCompanionInfo();notify(`清理完成：${r.deletedMemoryEntries} 条记忆，${r.deletedConversations??0} 组对话`);}catch(err){notify(err.message,true);}
});


function fillLessonOptions(mode,selected){
 const picker=$('companion-lesson'),previous=selected??picker.value;
 picker.replaceChildren();
 const choices=curriculum.filter(c=>c.mode===mode);
 for(const lesson of choices){
   const option=document.createElement('option');
   option.value=lesson.id;option.textContent=lesson.title+' · '+lesson.version;
   picker.append(option);
 }
 if(choices.some(x=>x.id===previous))picker.value=previous;
 picker.disabled=!authorizedActor||mode==='chat';
}
$('companion-mode').addEventListener('change',()=>{
 if(!companionBusy)fillLessonOptions($('companion-mode').value);
});
// Alex text-first virtual terminal. No model or browser audio event may invoke
// device controls. Provisional tokens only become history on committed SSE.
let companionAbort=null;
const cloudAudioBridge=new globalThis.AlexCloudAudioBridge({
 onTranscript:({text})=>{
  $('companion-text').value=text.slice(0,500);
  companionNotice('云端转写已完成。请检查文字，再手动点击发送。');
 },
 onStatus:({state,message})=>{
  const mapped={recording:'listening',transcribing:'thinking',
    synthesizing:'thinking',speaking:'speaking',error:'error',idle:'idle'}[state];
  if(mapped&&$('companion-runtime').dataset.state!==mapped)
    companionState(mapped);
  $('companion-audio-policy').textContent=message??'云端语音短音频操作';
  $('companion-cloud-record').textContent=state==='recording'?'结束并转写短录音':'开始云端短录音';
  $('companion-audio-cancel').disabled=state==='idle'||state==='error';
 }
});
let audioCapabilities={inputAllowed:false,outputAllowed:false,provider:'disabled'};
async function refreshAudioCapabilities(){
 const identity=companionActor;
 if(!authorizedActor){
  audioCapabilities={inputAllowed:false,outputAllowed:false,provider:'disabled'};
  cloudAudioBridge.interrupt('not-authenticated');
  $('companion-cloud-record').disabled=true;$('companion-cloud-speak').disabled=true;return;
 }
 try{
  const response=await fetch('/api/audio/capabilities',{cache:'no-store'});
  if(!response.ok)throw new Error('AUDIO_POLICY_UNAVAILABLE');
  const next=await response.json();
  if(identity!==companionActor)return;
  const state=cloudAudioBridge.snapshot().state;
  if((!next.inputAllowed&&['recording','transcribing'].includes(state))
     ||(!next.outputAllowed&&['synthesizing','speaking'].includes(state)))
    cloudAudioBridge.interrupt('parent-revoked');
  audioCapabilities=next;
  $('companion-cloud-record').disabled=!next.inputAllowed||
    !(navigator.mediaDevices?.getUserMedia&&globalThis.MediaRecorder);
  $('companion-cloud-speak').disabled=!next.outputAllowed;
  if(state==='idle')$('companion-audio-cancel').disabled=true;
  $('companion-audio-policy').textContent=
    '第三方 ASR：'+(next.inputAllowed?'已授权':'禁止或未配置')+
    '；第三方 TTS：'+(next.outputAllowed?'已授权':'禁止或未配置')+
    '。录音不超过 '+Math.round(next.maxDurationMs/1000)+' 秒；识别结果须手动发送。';
 }catch{
  if(identity!==companionActor)return;
  audioCapabilities={inputAllowed:false,outputAllowed:false,provider:'disabled'};
  cloudAudioBridge.interrupt('policy-unavailable');
  $('companion-cloud-record').disabled=true;$('companion-cloud-speak').disabled=true;
  $('companion-audio-policy').textContent='无法验证云端音频权限，已停止录音与播放。';
 }
}
const voiceBridge=new globalThis.AlexVoiceBridge({
 recognitionFactory:(window.SpeechRecognition||window.webkitSpeechRecognition)
   ?()=>new (window.SpeechRecognition||window.webkitSpeechRecognition)():null,
 synthesis:window.speechSynthesis??null,
 utteranceFactory:typeof window.SpeechSynthesisUtterance==='function'
   ?text=>new window.SpeechSynthesisUtterance(text):null,
 onState:next=>companionState(next),
 onTranscript:({text,isFinal})=>{
  $('companion-text').value=text;
  companionNotice(isFinal?'识别文字已完成，请检查后手动发送。':
    '语音识别文字预览（可能调用浏览器厂商服务）。');
 },
 onError:code=>{companionState('error');companionNotice('语音失败：'+code,true);}
});
let privacyPollAt=0;
async function refreshCompanionPrivacy(force=false){
 if(!authorizedActor){
  companionPrivacy={...deniedVoice};voiceBridge.setConsent(companionPrivacy);return;
 }
 if(!force&&Date.now()-privacyPollAt<3000)return;
 const identity=companionActor;privacyPollAt=Date.now();
 try{
  const response=await fetch('/api/learner/privacy',{cache:'no-store'});
  if(!response.ok)throw new Error('VOICE_POLICY_UNAVAILABLE');
  const next=(await response.json()).preferences;
  if(identity!==companionActor)return;
  companionPrivacy=next;voiceBridge.setConsent(next);
  await refreshAudioCapabilities();
  const support=voiceBridge.snapshot();
  $('companion-microphone').disabled=!next.voiceInputAllowed||!support.recognitionSupported;
  $('companion-read-aloud').disabled=!next.voiceOutputAllowed||!support.speechSupported;
  if($('companion-read-aloud').disabled)$('companion-read-aloud').checked=false;
  $('companion-voice-policy').textContent='当前：麦克风'+(next.voiceInputAllowed?'已授权':'已关闭')+
    ' · 朗读'+(next.voiceOutputAllowed?'已授权':'已关闭')+
    ' · 云模型文字'+(next.cloudTextAllowed?'已授权':'禁止')+
    '。识别可能使用浏览器厂商云端；需检查文字并手动发送。';
 }catch{
  if(identity!==companionActor)return;
  companionPrivacy={...deniedVoice};voiceBridge.setConsent(companionPrivacy);
  cloudAudioBridge.interrupt('policy-error');
  $('companion-cloud-record').disabled=true;$('companion-cloud-speak').disabled=true;
  $('companion-microphone').disabled=true;$('companion-read-aloud').disabled=true;
  $('companion-read-aloud').checked=false;
  $('companion-voice-policy').textContent='隐私授权暂无法验证：语音和云端文字使用默认关闭。';
 }
}
const terminalRuntime=new globalThis.AlexTerminalRuntime();
function companionState(next) {
 terminalRuntime.transition(next,{reason:'browser-ui'});
 const labels={
  idle:'Alex · 等待交流',listening:'Alex · 正在听写（浏览器识别）',
  thinking:'Alex · 正在生成文字',speaking:'Alex · 本地朗读中',
  error:'Alex · 本轮未完成'
 };
 if(!(next in labels))return;
 $('companion-runtime').dataset.state=next;
 $('companion-runtime-label').textContent=labels[next];
}
function companionNotice(text,error=false){
 $('companion-notice').textContent=text;
 $('companion-notice').style.color=error?'#bc6854':'';
}
function makeCompanionBubble(role,text,source='offline',preview=false) {
 const line=document.createElement('div');
 line.className='companion-message';
 line.dataset.role=role;
 if(preview)line.dataset.preview='true';
 const who=document.createElement('small');
 who.textContent=role==='user'?'你':preview?'Alex · 尚未保存的预览':
  source==='model'?'Alex · AI 模型':source==='offline'?'Alex · 离线互动':'Alex · 开场';
 const body=document.createElement('p');
 body.textContent=text; // All untrusted user/model content is plain text, never HTML.
 line.append(who,body);
 return {line,body};
}
function showCompanion(session) {
 const container=$('companion-messages');
 container.replaceChildren();
 for(const message of session.messages)
  container.append(makeCompanionBubble(message.role,message.text,message.source).line);
 container.scrollTop=container.scrollHeight;
}
function stopCompanionSpeech(){
 voiceBridge.stopSpeaking();
 cloudAudioBridge.interrupt('stop-speech');
}
function speakCompanion(text,mode){
 if(!$('companion-read-aloud').checked)return;
 if(!companionPrivacy.voiceOutputAllowed){
  $('companion-read-aloud').checked=false;companionNotice('家长尚未授权朗读。',true);return;
 }
 try{
  voiceBridge.speak(text,{lang:mode==='english'?'en-US':'zh-CN',
    rate:mode==='english'?.85:1});
 }catch(err){companionNotice(err.message,true);companionState('error');}
}
async function refreshCompanionProgress(){
 if(!authorizedActor){$('companion-progress-summary').textContent='请登录后查看学习记录。';return;}
 try{
  const selector=$('companion-progress-scope');
  const scope=selector.value==='self'?'self':selector.value;
  const res=await fetch('/api/companion/progress?scope='+encodeURIComponent(scope),{cache:'no-store'});
  if(!res.ok)throw new Error('学习记录暂时不可用');
  const progress=(await res.json()).progress;
  $('companion-progress-summary').textContent='A1 文字练习完成 '+progress.englishTextExercisesCompleted
    +' 次；分支故事完成 '+progress.storyBranchesCompleted
    +' 次；科学文字问答完成 '+(progress.scienceTextQuizzesCompleted??0)
    +' 次。有界独立成果记录不因会话自动轮换而消失；删除或隐私擦除会清理。非发音／成绩测评。';
  $('companion-course-progress').replaceChildren();
  for(const course of curriculum){
   const times=progress.byCourse?.[course.id]??0;
   const line=document.createElement('p');
   line.textContent=course.title+'：'+times+' 次文本练习完成';
   $('companion-course-progress').append(line);
  }
 }catch(error){companionNotice(error.message,true);}
}
async function refreshCompanionInfo(){
 if(!authorizedActor){
  $('companion-provider').textContent='需登录';
  $('companion-privacy').textContent='需要本地家长/儿童身份认证；演示模式不会开启私密会话。';
  return;
 }
 try{
  const r=await fetch('/api/companion/sessions',{cache:'no-store'});
  if(!r.ok)throw new Error('无法获取对话服务');
  const data=await r.json();
  await refreshCompanionPrivacy(true);
  const courseResponse=await fetch('/api/learning/catalog',{cache:'no-store'});
  if(courseResponse.ok)curriculum=(await courseResponse.json()).courses;
  fillLessonOptions($('companion-mode').value);
  const assigned=await fetch('/api/learning/overview',{cache:'no-store'});
  const assignedPlans=assigned.ok?(await assigned.json()).overview:[];
  $('companion-assignments').replaceChildren();
  for(const plan of assignedPlans.filter(p=>p.status==='active')){
    const course=curriculum.find(c=>c.id===plan.courseId);
    if(!course)continue;
    const el=document.createElement('p');
    el.textContent='家长建议：'+course.title+'（已完成 '+plan.completed+' / '+plan.targetCompletions+' 次文字练习）';
    $('companion-assignments').append(el);
  }
  const history=$('companion-history');
  const selected=companionSessionId;
  history.replaceChildren();
  const empty=document.createElement('option');empty.value='';empty.textContent='选择历史会话';history.append(empty);
  for(const entry of data.sessions){
   const option=document.createElement('option');option.value=entry.id;
   option.textContent=(entry.mode==='english'?'A1 英语':entry.mode==='story'?'互动故事':entry.mode==='quiz'?'科学小问答':'自由聊天')
     +' · '+entry.turns+' 轮 · '+new Date(entry.updatedAt).toLocaleString('zh-CN');
   history.append(option);
  }
  if(selected&&data.sessions.some(x=>x.id===selected))history.value=selected;
  companionProvider=data.provider;
  $('companion-provider').textContent=data.provider==='compatible'?'模型已配置':'离线互动';
  $('companion-privacy').textContent=(data.transcriptsPersisted?'已开启本地对话持久化':'对话仅在服务进程内存中保留，重启即消失')
   +' · 不会自动控制设备 · 浏览器语音识别可能使用厂商在线服务';
  const scopeSelector=$('companion-progress-scope');
  const oldScope=scopeSelector.value;
  scopeSelector.replaceChildren();
  const scopes=[{value:'self',text:'当前身份'}];
  if(authorizedActor==='parent'){
   scopes.push({value:'child',text:'所有儿童（含共享账号）'});
   const profilesResponse=await fetch('/api/profiles',{cache:'no-store'});
   if(profilesResponse.ok){
    const learnerProfiles=(await profilesResponse.json()).profiles;
    for(const profile of learnerProfiles)
      scopes.push({value:'learner:'+profile.id,text:'学习者：'+profile.nickname});
   }
  }
  for(const item of scopes){
   const option=document.createElement('option');
   option.value=item.value;option.textContent=item.text;scopeSelector.append(option);
  }
  if(scopes.some(x=>x.value===oldScope))scopeSelector.value=oldScope;
  if(companionSessionId){
   const owned=data.sessions.some(x=>x.id===companionSessionId);
   if(!owned){companionSessionId=null;$('companion-messages').replaceChildren();}
   else{
    const response=await fetch('/api/companion/session?id='+encodeURIComponent(companionSessionId),{cache:'no-store'});
    if(response.ok)showCompanion((await response.json()).session);
   }
  }
  await refreshCompanionProgress();
 }catch(err){companionNotice(err.message,true);}
}
async function restoreCompanion(id) {
 const res=await fetch('/api/companion/session?id='+encodeURIComponent(id),{cache:'no-store'});
 if(!res.ok)throw new Error('无法读取当前身份的历史会话');
 const session=(await res.json()).session;
 companionSessionId=session.id;
 $('companion-mode').value=session.mode;
 fillLessonOptions(session.mode,session.lessonId);
 showCompanion(session);
 return session;
}
$('companion-progress-scope').addEventListener('change',()=>void refreshCompanionProgress());
$('companion-history').addEventListener('change',async()=>{
 if(!authorizedActor||companionBusy)return;
 const id=$('companion-history').value;
 if(!id){companionSessionId=null;$('companion-messages').replaceChildren();return;}
 try{await restoreCompanion(id);companionNotice('已恢复历史会话，继续输入即可对话。');}
 catch(err){companionSessionId=null;companionNotice(err.message,true);}
});
$('companion-new').addEventListener('click',async()=>{
 if(!authorizedActor||companionBusy)return;
 companionBusy=true;stopCompanionSpeech();
 try{
  const res=await api('/api/companion/open',{mode:$('companion-mode').value,
   ...($('companion-mode').value!=='chat'?{lessonId:$('companion-lesson').value}:{})});
  companionSessionId=res.session.id;
  showCompanion(res.session);
  await refreshCompanionInfo();
  companionState('idle');
  companionNotice('新的文字对话已开始。');
  $('companion-text').focus();
 }catch(err){companionNotice(err.message,true);companionState('error');}
 finally{companionBusy=false;}
});

// Browser fetch reads standard SSE frames. A client-side preview is discarded
// after an incomplete stream, cancel, server error or connection loss.
async function receiveCompanionStream(response,onDelta) {
 if(!response.ok){
  const failure=await response.json().catch(()=>({}));
  throw new Error(failure.error||'无法开始流式对话');
 }
 if(!response.body)throw new Error('STREAM_BODY_UNAVAILABLE');
 const reader=response.body.getReader(),decoder=new TextDecoder();
 let buffer='',committed=null;
 try{
  for(;;){
   const part=await reader.read();
   if(part.done)break;
   buffer+=decoder.decode(part.value,{stream:true});
   buffer=buffer.replace(/\r\n/g,'\n');
   if(buffer.length>150000)throw new Error('STREAM_DATA_TOO_LARGE');
   let boundary;
   while((boundary=buffer.indexOf('\n\n'))>=0){
    const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
    const event=frame.split('\n').find(x=>x.startsWith('event:'))?.slice(6).trim();
    const raw=frame.split('\n').filter(x=>x.startsWith('data:'))
      .map(x=>x.slice(5).trimStart()).join('\n');
    if(!event||!raw)continue;
    const data=JSON.parse(raw);
    if(event==='delta'){
     if(committed)throw new Error('INVALID_STREAM_ORDER');
     if(typeof data.text!=='string')throw new Error('INVALID_STREAM_DELTA');
     onDelta(data.text);
    }else if(event==='committed'){
     if(committed||!data.session||!data.assistant)throw new Error('INVALID_STREAM_COMMIT');
     committed=data;
    }else if(event==='error'){
     throw new Error(data.error||'STREAM_FAILED');
    }
   }
  }
  if(!committed)throw new Error('STREAM_INCOMPLETE_NO_COMMIT');
  return committed;
 }finally{reader.releaseLock();}
}
$('companion-form').addEventListener('submit',async e=>{
 e.preventDefault();
 if(!authorizedActor||companionBusy)return;
 const text=$('companion-text').value.trim();
 if(!text)return;
 companionBusy=true;$('companion-send').disabled=true;
 $('companion-cancel').disabled=false;
 voiceBridge.interrupt('chat-submit');cloudAudioBridge.interrupt('chat-submit');
 companionState('thinking');
 const controller=new AbortController();companionAbort=controller;
 try{
  if(!companionSessionId){
   const created=await api('/api/companion/open',{mode:$('companion-mode').value,
    ...($('companion-mode').value!=='chat'?{lessonId:$('companion-lesson').value}:{})});
   companionSessionId=created.session.id;
   showCompanion(created.session);
  }
  const baseId=companionSessionId,container=$('companion-messages');
  container.append(makeCompanionBubble('user',text,'user',true).line);
  const preview=makeCompanionBubble('assistant','', 'model',true);
  container.append(preview.line);container.scrollTop=container.scrollHeight;
  const response=await fetch('/api/companion/stream',{
   method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({id:baseId,text}),signal:controller.signal
  });
  const result=await receiveCompanionStream(response,delta=>{
   preview.body.textContent+=delta;container.scrollTop=container.scrollHeight;
  });
  $('companion-text').value='';
  showCompanion(result.session);
  await refreshCompanionInfo();
  companionNotice(result.source==='model'
    ?'模型回复已完整保存；不能生成教学达标证明，也未执行设备动作。'
    :result.milestone
      ?'已完成这组离线文字练习，记录为一项学习成果（非发音或语言能力评分）。'
      :'离线互动已完成；未调用云端模型。');
  companionState('idle');speakCompanion(result.assistant.text,result.session.mode);
 }catch(err){
  if(companionSessionId){
   try{await restoreCompanion(companionSessionId);}
   catch{$('companion-messages').replaceChildren();}
  }
  companionState(controller.signal.aborted?'idle':'error');
  companionNotice(controller.signal.aborted?'已取消本轮，未完成的预览不作为会话记录。':
    '回复未完成，已丢弃页面预览：'+err.message,!controller.signal.aborted);
 }finally{
  if(companionAbort===controller)companionAbort=null;
  companionBusy=false;$('companion-send').disabled=!authorizedActor;
  $('companion-cancel').disabled=true;
 }
});
$('companion-cancel').addEventListener('click',()=>{
 companionAbort?.abort();companionNotice('已请求取消本轮生成。');
});
$('companion-stop-speaking').addEventListener('click',()=>stopCompanionSpeech());
$('companion-delete').addEventListener('click',async()=>{
 if(!authorizedActor||!companionSessionId||companionBusy)return;
 if(!window.confirm('删除当前对话记录及其关联的文字练习记录？'))return;
 companionBusy=true;
 try{
  await api('/api/companion/delete',{id:companionSessionId});
  companionSessionId=null;$('companion-messages').replaceChildren();
  stopCompanionSpeech();
  await refreshCompanionInfo();companionState('idle');
  companionNotice('当前对话已删除。');
 }catch(err){companionNotice(err.message,true);}
 finally{companionBusy=false;}
});
$('companion-microphone').disabled=true;
$('companion-read-aloud').disabled=true;
$('companion-microphone').addEventListener('click',async()=>{
 if(!authorizedActor||companionBusy)return;
 await refreshCompanionPrivacy(true);
 if(!companionPrivacy.voiceInputAllowed){
  companionNotice('家长未授予此学习者麦克风权限。',true);return;
 }
 try{
  if(voiceBridge.snapshot().state==='listening'){
   voiceBridge.stopListening();companionNotice('已停止语音识别。');return;
  }
  voiceBridge.startListening({lang:$('companion-mode').value==='english'?'en-US':'zh-CN'});
  companionNotice('浏览器开始识别；可能使用厂商在线服务。文字须检查并手动发送。');
 }catch(err){companionNotice(err.message,true);}
});
window.addEventListener('pagehide',()=>{
 terminalRuntime.interrupt('pagehide');
 companionAbort?.abort();
 voiceBridge.interrupt('pagehide');
 cloudAudioBridge.interrupt('pagehide');
});
document.addEventListener('visibilitychange',()=>{
 if(document.hidden){
  voiceBridge.interrupt('page-hidden');cloudAudioBridge.interrupt('page-hidden');
 }
 else void refreshCompanionPrivacy(true);
});
setInterval(()=>{if(authorizedActor)void refreshCompanionPrivacy();},3000);

// All listeners and state are installed before authentication can launch any polling.
void initAuth();
