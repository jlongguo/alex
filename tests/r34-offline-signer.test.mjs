import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {SkillPackageTrust} from '../scripts/skill-package-trust.mjs';
const shape={type:'object',properties:{value:{type:'string'}},required:[],additionalProperties:false};
test('R34 offline CLI produces a package attestation verifiable by trust API without exposing private key',{timeout:10000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r34-sign-cli-'));
 try{
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const manifest={schemaVersion:'alex.skill/v1',id:'family.offline',version:'2.0.0',
   name:'Offline',description:'Signature test',permissions:[],
   allowedActors:['parent'],dependencies:[],inputSchema:shape,outputSchema:shape};
  const manifestFile=join(dir,'manifest.json'),artifactFile=join(dir,'artifact.bin'),keyFile=join(dir,'private.pem');
  const bytes=Buffer.from('opaque offline content');
  await writeFile(manifestFile,JSON.stringify(manifest));
  await writeFile(artifactFile,bytes);
  await writeFile(keyFile,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  const result=spawnSync(process.execPath,['scripts/sign-skill-artifact.mjs',
   manifestFile,artifactFile,keyFile,'family.publisher'],{cwd:resolve(import.meta.dirname,'..'),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.includes('PRIVATE KEY'),false);
  const doc=JSON.parse(result.stdout);
  assert.equal(doc.artifactBase64,bytes.toString('base64'));
  const trust=new SkillPackageTrust({file:join(dir,'trust.json')});
  await trust.enroll('parent',{publisherId:'family.publisher',
   publicKeyPem:publicKey.export({type:'spki',format:'pem'}).toString()});
  const verified=await trust.attest('parent',{...doc,manifest});
  assert.equal(verified.artifactSha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(trust.assertTrusted(manifest).publisherId,'family.publisher');
  const malformed=spawnSync(process.execPath,['scripts/sign-skill-artifact.mjs',
   manifestFile,artifactFile,join(dir,'nonexistent.pem'),'family.publisher'],{cwd:resolve(import.meta.dirname,'..'),encoding:'utf8'});
  assert.notEqual(malformed.status,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
