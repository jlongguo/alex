import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const html=readFileSync(resolve(root,'public/index.html'),'utf8');
const app=readFileSync(resolve(root,'public/app.js'),'utf8');
test('R35 upgrade impact is parent-only and has accessible status region',()=>{
 assert.ok(html.indexOf('id="skill-package-impact"')>html.indexOf('id="family-private"'));
 assert.match(html,/id="skill-package-impact"[^>]*role="status"/);
 assert.ok(app.includes("action:'preview'"));
 assert.ok(app.includes('esc(p.addedPermissions.join('));
 assert.ok(app.includes('esc(p.missingDependencies.map('));
 assert.ok(app.includes('esc(p.blockers.join('));
});
test('R35 rollback is explicitly confirmed and never client-triggered automatically',()=>{
 assert.ok(app.includes("data-package-action=\"rollback\""));
 assert.ok(app.includes("action==='rollback'&&"));
 assert.ok(app.includes("window.confirm("));
 assert.ok(app.includes("expectedCurrentVersion:button.dataset.packageCurrent"));
});
