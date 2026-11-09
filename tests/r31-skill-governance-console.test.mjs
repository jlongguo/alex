import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const html=readFileSync(resolve(root,'public/index.html'),'utf8');
const app=readFileSync(resolve(root,'public/app.js'),'utf8');
test('R31 trusted Skill controls are inside parent-private family settings',()=>{
 const privateStart=html.indexOf('id="family-private"');
 const panelStart=html.indexOf('id="skill-governance-list"');
 assert.ok(privateStart>=0&&panelStart>privateStart);
 for(const id of ['skill-governance-list','skill-governance-refresh','skill-governance-notice'])
  assert.ok(html.includes('id="'+id+'"'));
});
test('R31 console updates enable flags with version pins and escaped manifest fields',()=>{
 assert.ok(app.includes("fetch('/api/skills/governance'"));
 assert.ok(app.includes("api('/api/skills/governance'"));
 assert.ok(app.includes("if(authorizedActor!=='parent'"));
 for(const field of ['skill.name','skill.id','skill.version'])
  assert.ok(app.includes('esc('+field+')'),field);
 assert.ok(app.includes('expectedVersion'));
 assert.ok(app.includes('refreshSkillGovernance()'));
});
