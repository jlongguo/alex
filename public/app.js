const $ = id => document.getElementById(id);
let state=null,lastTask=null,busy=false;
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const color = {dock:'#8ac7a8',study_desk:'#79a4db',sofa:'#c4a4dc',story_corner:'#e7b76b'};
const labels={dock:'充电基站',study_desk:'学习书桌',sofa:'客厅沙发',story_corner:'故事角'};
async function api(path,data){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const json=await r.json();if(!r.ok||json.ok===false)throw new Error(json.message||json.error||'Request failed');return json;}
function notify(message,isError=false){const el=$('notice');el.textContent=message;el.classList.toggle('hidden',!isError);if(!isError)$('command-result').textContent=message;else $('command-result').textContent=message; $('command-result').classList.toggle('error',isError);}
async function act(path,data){if(busy)return;busy=true;try{const res=await api(path,data);notify(res.message);await refresh();}catch(e){notify(e.message,true);}finally{busy=false;}}
async function refresh(){try{const r=await fetch('/api/state',{cache:'no-store'});if(!r.ok)throw new Error('Server unavailable');state=await r.json();render(state);$('connection').textContent='中枢已连接';$('connection').style.color='#269774';}catch(e){$('connection').textContent='连接失败';$('connection').style.color='#bc6854';}}
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
 const robot=s.robot;const active=s.tasks.find(t=>t.id===s.activeTaskId);const latest=s.tasks[0];
 $('battery').textContent=Math.round(robot.battery)+'%';$('position').textContent=`(${robot.x.toFixed(1)}, ${robot.y.toFixed(1)})`; $('active-task').textContent=active?labels[active.destination]:(latest?.status==='succeeded'?'已完成':'空闲');
 $('safety-state').textContent=robot.emergencyStopped?'急停锁定':robot.obstaclePresent?'障碍物存在':'正常';$('safety-state').style.color=robot.emergencyStopped?'#c4564b':'';
 const moving=robot.movement==='moving';$('motion-pill').textContent=robot.emergencyStopped?'⛔ 急停':moving?'↗ 移动中':'● 待命';$('motion-pill').className='pill '+(robot.emergencyStopped?'':moving?'green':'green');
 const p=active?.progress ?? (latest?.status==='succeeded'?100:0);$('progress-value').textContent=p+'%';$('progress-bar').style.width=p+'%';
 $('btn-reset').disabled=!robot.emergencyStopped;$('obstacle').checked=robot.obstaclePresent;
 const icons=['📚','📖','🏠']; $('skills-list').innerHTML=s.skills.map((skill,i)=>`<div class="skill-item"><div class="skill-icon">${icons[i]??'✳'}</div><div class="skill-info"><strong>${esc(skill.name)}</strong><small>${esc(skill.description)}</small></div><button data-skill="${esc(skill.id)}">启动</button></div>`).join('');
 const events=s.events.slice(-9).reverse();$('event-counter').textContent=s.events.length+' EVENTS';$('events').innerHTML=events.map(e=>`<div class="event-row"><span class="event-time">${new Date(e.timestamp).toLocaleTimeString('zh-CN',{hour12:false})}</span><span class="event-kind">${esc(e.type)}</span><span class="event-message" title="${esc(e.message)}">${esc(e.message)}</span></div>`).join('');
}
$('command-form').addEventListener('submit',async e=>{e.preventDefault();const t=$('command-text').value.trim();if(t)await act('/api/command',{text:t,actor:$('actor').value});});
document.querySelectorAll('[data-command]').forEach(b=>b.addEventListener('click',()=>{$('command-text').value=b.dataset.command;$('command-form').requestSubmit();}));
document.querySelectorAll('[data-dest]').forEach(b=>b.addEventListener('click',()=>act('/api/tasks',{capability:b.dataset.dest==='dock'?'navigation.dock':'navigation.goto',params:{destination:b.dataset.dest},actor:$('actor').value})));
$('skills-list').addEventListener('click',e=>{const b=e.target.closest('[data-skill]');if(b)act('/api/skills/invoke',{id:b.dataset.skill,actor:$('actor').value});});
$('btn-stop').addEventListener('click',()=>act('/api/safety/stop',{actor:$('actor').value}));
$('btn-reset').addEventListener('click',()=>act('/api/safety/reset',{actor:$('actor').value}));
$('obstacle').addEventListener('change',e=>act('/api/environment',{obstaclePresent:e.target.checked,actor:$('actor').value}));
setInterval(()=>{$('clock').textContent=new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});},1000);
setInterval(refresh,500);refresh();
try{const stream=new EventSource('/api/events');stream.addEventListener('home-event',()=>refresh());stream.onerror=()=>{};}catch{}
