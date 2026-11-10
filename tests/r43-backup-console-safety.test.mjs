import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const html=readFileSync(resolve(root,'public/index.html'),'utf8');
const server=readFileSync(resolve(root,'scripts/server.mjs'),'utf8');
const backup=readFileSync(resolve(root,'scripts/offline-state-backup.mjs'),'utf8');

test('R43 备份提示只放在家长私有区，不生成暴露家庭数据的下载接口',()=>{
 const at=html.indexOf('R43 · 离线数据备份及恢复演练');
 assert.ok(at>html.indexOf('id="family-private"'));
 assert.ok(at<html.indexOf('id="release-readiness-title"')+2500);
 assert.match(html,/必须先正常停止 Alex 服务/);
 assert.match(html,/自定义 STATE_FILE/);
 assert.ok(!server.includes("pathname==='/api/recovery/export'"));
 assert.ok(!server.includes("pathname==='/api/recovery/restore'"));
});
test('R43 CLI 保持离线本地边界，完整备份标志不可伪造',()=>{
 assert.ok(backup.includes("fullApplicationBackup:false"));
 assert.ok(backup.includes("ALEX_BACKUP_REQUIRES_STOPPED_SERVER"));
 assert.ok(backup.includes("ALEX_RESTORE_TARGET_NOT_EMPTY"));
 assert.ok(backup.includes("await open(path,'wx',0o600)"));
 assert.ok(!backup.includes('fetch('));
});
