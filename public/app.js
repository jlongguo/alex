const $ = id => document.getElementById(id);
let state=null,lastTask=null,busy=false,refreshInFlight=false;
let companionActor=null,companionSessionId=null,companionBusy=false,companionProvider='offline';
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
 if(authorizedActor&&['learning.english','story.interactive'].includes(id)){
  if(companionBusy)return;
  companionBusy=true;
  try{
   const res=await api('/api/skills/invoke',{id});
   if(!res.session)throw new Error('SKILL_SESSION_NOT_CREATED');
   companionSessionId=res.session.id;
   $('companion-mode').value=res.session.mode;
   showCompanion(res.session);
   window.location.hash='#overview';
   companionNotice('已从技能中心开启 '+(id==='learning.english'?'A1 英语':'互动故事')+' 对话。');
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
 else if(session.actor==='child'){status.textContent='儿童已登录';entry.textContent='切换为家长';}
 else {status.textContent='家长已验证';entry.textContent='家长登录';}
}
function openAuthDialog(session){
 const demo=session.mode==='demo';
 $('auth-form').classList.toggle('hidden',demo);
 $('auth-demo-guide').classList.toggle('hidden',!demo);
 $('auth-overlay').classList.remove('hidden');
 if(!demo){
  $('auth-role').value='parent';
  $('auth-secret').minLength=12;
  $('auth-error').textContent='';
  $('auth-secret').value='';
  $('auth-secret').focus();
 }else $('auth-demo-close').focus();
}
function applySession(session){
 authorizedActor=session.mode==='local'&&session.authenticated?session.actor:null;
 if(companionActor!==authorizedActor) {
  companionActor=authorizedActor;companionSessionId=null;
  $('companion-messages').replaceChildren();
 }
 for(const id of ['companion-new','companion-delete','companion-text','companion-send','companion-mode']){
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
$('auth-role').addEventListener('change',()=>{$('auth-secret').minLength=$('auth-role').value==='parent'?12:6;});
$('auth-form').addEventListener('submit',async e=>{
  e.preventDefault();
  $('auth-error').textContent='';
  const role=$('auth-role').value,secret=$('auth-secret').value;
  try{
    const response=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role,secret})});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'登录失败');
    $('auth-secret').value='';
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
  const [pr,mr]=await Promise.all([fetch('/api/profiles',{cache:'no-store'}),fetch('/api/memory',{cache:'no-store'})]);
  if(!pr.ok||!mr.ok)throw new Error('需要家长身份读取家庭资料');
  const profiles=(await pr.json()).profiles,memories=(await mr.json()).entries;
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
 if(!window.confirm('确定删除这个学习者档案？'))return;
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


// Companion console: no client-side tool dispatch, device-control shortcuts,
// automatic microphone start, audio recording uploads or misleading LLM status.
function companionNotice(text,error=false){
 $('companion-notice').textContent=text;
 $('companion-notice').style.color=error?'#bc6854':'';
}
function showCompanion(session) {
 const container=$('companion-messages');
 container.replaceChildren();
 for(const message of session.messages){
  const line=document.createElement('div');
  line.className='companion-message';
  line.dataset.role=message.role;
  const who=document.createElement('small');
  who.textContent=message.role==='user'?'你':message.source==='model'?'Alex · AI 模型':message.source==='offline'?'Alex · 离线互动':'Alex · 开场';
  const body=document.createElement('p');
  body.textContent=message.text; // NOT innerHTML: all model/user text is untrusted.
  line.append(who,body);container.append(line);
 }
 container.scrollTop=container.scrollHeight;
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
  companionProvider=data.provider;
  $('companion-provider').textContent=data.provider==='compatible'?'真实模型已配置':'离线互动';
  $('companion-privacy').textContent=(data.transcriptsPersisted?'已由家长开启本地对话持久化':'对话仅在服务进程内存中保留，重启即消失')+' · 不会自动控制设备';
  if(companionSessionId){
   const owned=data.sessions.some(x=>x.id===companionSessionId);
   if(!owned){companionSessionId=null;$('companion-messages').replaceChildren();return;}
   const response=await fetch('/api/companion/session?id='+encodeURIComponent(companionSessionId),{cache:'no-store'});
   if(response.ok)showCompanion((await response.json()).session);
  }
 }catch(err){companionNotice(err.message,true);}
}
$('companion-new').addEventListener('click',async()=>{
 if(!authorizedActor||companionBusy)return;
 companionBusy=true;
 try {
  const res=await api('/api/companion/open',{mode:$('companion-mode').value});
  companionSessionId=res.session.id;
  showCompanion(res.session);
  companionNotice('新的文字对话已开始。');
  $('companion-text').focus();
 }catch(err){companionNotice(err.message,true);}
 finally{companionBusy=false;}
});
$('companion-form').addEventListener('submit',async e=>{
 e.preventDefault();
 if(!authorizedActor||companionBusy)return;
 const text=$('companion-text').value.trim();
 if(!text)return;
 companionBusy=true;$('companion-send').disabled=true;
 try {
  if(!companionSessionId){
   const created=await api('/api/companion/open',{mode:$('companion-mode').value});
   companionSessionId=created.session.id;
   showCompanion(created.session);
  }
  const res=await api('/api/companion/turn',{id:companionSessionId,text});
  $('companion-text').value='';
  showCompanion(res.session);
  companionNotice(res.source==='model'?'AI 模型已回复；没有触发任何设备动作。':'离线互动已回复；未调用云端模型。');
  if($('companion-read-aloud').checked && 'speechSynthesis' in window){
   window.speechSynthesis.cancel();
   const utterance=new SpeechSynthesisUtterance(res.assistant.text);
   utterance.lang=res.mode==='english'?'en-US':'zh-CN';
   utterance.rate=res.mode==='english'?0.85:1;
   window.speechSynthesis.speak(utterance);
  }
 }catch(err){companionNotice(err.message,true);}
 finally{companionBusy=false;$('companion-send').disabled=!authorizedActor;}
});
$('companion-delete').addEventListener('click',async()=>{
 if(!authorizedActor||!companionSessionId||companionBusy)return;
 if(!window.confirm('删除当前对话记录？'))return;
 companionBusy=true;
 try{
  await api('/api/companion/delete',{id:companionSessionId});
  companionSessionId=null;$('companion-messages').replaceChildren();
  window.speechSynthesis?.cancel();
  companionNotice('已删除当前对话。');
 }catch(err){companionNotice(err.message,true);}
 finally{companionBusy=false;}
});
const CompanionSpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;
$('companion-microphone').disabled=!CompanionSpeechRecognition;
$('companion-microphone').addEventListener('click',()=>{
 if(!authorizedActor||!CompanionSpeechRecognition||companionBusy)return;
 const recognition=new CompanionSpeechRecognition();
 recognition.lang=$('companion-mode').value==='english'?'en-US':'zh-CN';
 recognition.interimResults=false;recognition.maxAlternatives=1;
 recognition.onresult=event=>{$('companion-text').value=event.results?.[0]?.[0]?.transcript?.slice(0,500)??'';companionNotice('语音已转为文本，请检查后点击发送。');};
 recognition.onerror=()=>companionNotice('当前浏览器语音识别不可用，请使用文字输入。',true);
 try{recognition.start();companionNotice('正在等待浏览器语音权限，仅用于语音转文字。');}
 catch{companionNotice('浏览器无法启动语音识别，请使用文字输入。',true);}
});
window.addEventListener('pagehide',()=>window.speechSynthesis?.cancel());

// All listeners and state are installed before authentication can launch any polling.
void initAuth();
