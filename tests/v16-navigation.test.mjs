import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
const root=resolve(import.meta.dirname,'..');
const html=await readFile(join(root,'public/index.html'),'utf8');
const navSource=await readFile(join(root,'public/navigation.js'),'utf8');
const appSource=await readFile(join(root,'public/app.js'),'utf8');
const css=await readFile(join(root,'public/styles.css'),'utf8');

function runNav(initialHash='') {
  const events=new Map();
  const elements=new Map(['page-eyebrow','page-title','page-description'].map(id=>[id,{textContent:''}]));
  const links=['overview','tasks','devices','skills','events','family'].map(page=>{
    const attrs=new Map([['href',`#${page}`]]);
    const classes=new Set(page==='overview'?['selected']:[]);
    const handlers=new Map();
    return {dataset:{pageLink:page},
      getAttribute:key=>attrs.get(key),setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k),
      classList:{contains:name=>classes.has(name),toggle:(name,enabled)=>enabled?classes.add(name):classes.delete(name)},
      addEventListener:(type,handler)=>handlers.set(type,handler),click:()=>handlers.get('click')?.()
    };
  });
  let scrolls=0;
  const window={location:{hash:initialHash},addEventListener:(type,fn)=>events.set(type,fn),scrollTo:()=>{scrolls++;}};
  const document={body:{dataset:{}},querySelectorAll:()=>links,getElementById:id=>elements.get(id)};
  runInNewContext(navSource,{window,document});
  function navigate(page) {window.location.hash=`#${page}`;events.get('hashchange')();}
  return {links,window,document,elements,navigate,getScrolls:()=>scrolls};
}

test('sidebar links are accessible and every workspace has an actual destination',()=>{
  assert.match(html,/<nav class="nav" aria-label="工作区导航">/);
  for(const page of ['overview','tasks','devices','skills','events','family']){
    assert.match(html,new RegExp(`<a class="nav-item[^>]*href="#${page}"[^>]*data-page-link="${page}"`));
    assert.match(html,new RegExp(`data-nav-view="${page}"`));
  }
  assert.match(html,/id="skills-explorer"/);
  assert.match(html,/id="global-safety"/);
  assert.match(html,/id="tasks-intro"/);
  assert.match(html,/id="family-private"/);
  assert.match(html,/id="device-access-note"/);
  assert.match(html,/id="events-section"/);
  assert.match(html,/src="\/navigation\.js" defer/);
  assert.match(css,/body\[data-current-page="devices"\]/);
  assert.match(css,/@media\s*\(max-width:620px\)\s*\{[\s\S]*?\.sidebar\s*\{display:flex;position:fixed/);
  assert.match(appSource,/\$\('skills-list'\)\.innerHTML=skillsMarkup/);
  assert.match(appSource,/\$\('device-access-note'\)\.classList\.toggle\('hidden',parent\)/);
});

test('sidebar changes the selected workspace, ARIA state and visible heading',()=>{
  const nav=runNav();
  assert.equal(nav.document.body.dataset.currentPage,'overview');
  for(const [page,title] of [['tasks','Agent 与任务'],['devices','设备与机器人'],['skills','技能中心'],['events','事件与审计'],['family','家庭与设置'],['overview','总览']]) {
    nav.navigate(page);
    assert.equal(nav.document.body.dataset.currentPage,page);
    assert.equal(nav.elements.get('page-title').textContent,title);
    assert.equal(nav.links.filter(link=>link.classList.contains('selected')).length,1);
    for(const link of nav.links){
      assert.equal(link.getAttribute('aria-current'),link.dataset.pageLink===page?'page':undefined);
    }
  }
  assert.equal(nav.getScrolls(),6);
});

test('sidebar supports bookmarked views, browser back/forward and unexpected hashes',()=>{
  const nav=runNav('#skills');
  assert.equal(nav.document.body.dataset.currentPage,'skills');
  nav.navigate('devices');
  nav.navigate('skills');
  nav.navigate('made-up');
  assert.equal(nav.document.body.dataset.currentPage,'overview');
  assert.equal(nav.links[0].getAttribute('aria-current'),'page');
  nav.window.location.hash='#overview';
  nav.links[0].click();
  assert.equal(nav.links[0].classList.contains('selected'),true);
});

test('server exposes navigation JS with the same security headers as other assets',{timeout:12000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'alex-nav-html-'));
  const port=40000+Math.floor(Math.random()*15000);
  const child=spawn(process.execPath,['scripts/server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),AUTH_MODE:'demo',STATE_FILE:join(dir,'state.json')},stdio:'ignore'});
  try {
    let ready=false;
    for(let i=0;i<65;i++){try{const r=await fetch(`http://127.0.0.1:${port}/api/health`);if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,80));}
    assert.equal(ready,true,'server did not start');
    const r=await fetch(`http://127.0.0.1:${port}/navigation.js`);
    assert.equal(r.status,200);
    assert.match(r.headers.get('content-type'),/text\/javascript/);
    assert.match(r.headers.get('content-security-policy'),/script-src 'self'/);
    assert.match(await r.text(),/renderNavigation/);
  } finally {
    child.kill('SIGTERM');
    if(child.exitCode===null)await Promise.race([once(child,'exit'),new Promise(r=>setTimeout(r,900))]);
    await rm(dir,{recursive:true,force:true});
  }
});
