import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SkillPackageTrust,manifestDigest,signedPayload,canonicalJson} from '../scripts/skill-package-trust.mjs';
import {SkillPackageRegistry} from '../scripts/skill-package-registry.mjs';
const shape={type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false};
const manifest=(version='1.0.0')=>({schemaVersion:'alex.skill/v1',id:'family.skill',version,
 name:'Signed metadata',description:'Signed, not executable',permissions:[],
 allowedActors:['parent'],dependencies:[],inputSchema:shape,outputSchema:shape});
const sha=b=>createHash('sha256').update(b).digest('hex');
const keys=()=>generateKeyPairSync('ed25519');
const pem=key=>key.export({format:'pem',type:'spki'}).toString();
const artifact=Buffer.from('declarative static package bytes');
const signature=(priv,m,bytes=artifact)=>sign(null,signedPayload(manifestDigest(m),sha(bytes)),priv).toString('base64');
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'alex-r34-trust-'));
 const trust=new SkillPackageTrust({file:join(dir,'trust.json')});
 const packages=new SkillPackageRegistry({file:join(dir,'packages.json'),
  authorizePackage:m=>trust.assertTrusted(m)});
 return {dir,trust,packages,close:()=>rm(dir,{recursive:true,force:true})};
}
test('R34 domain-separated signatures are key-order-independent and bind artifact bytes',()=>{
 const m=manifest(),reordered=Object.fromEntries(Object.entries(m).reverse());
 assert.equal(manifestDigest(m),manifestDigest(reordered));
 assert.equal(canonicalJson(m),canonicalJson(reordered));
 assert.notEqual(sha(artifact),sha(Buffer.from('other bytes')));
});
test('R34 no package can be reviewed or installed without verified attestation',async()=>{
 const f=await fixture();try{
  const {trust,packages}=f;
  const k=keys(),m=manifest();
  await packages.submit('parent',m);
  await assert.rejects(packages.review('parent',{id:m.id,version:m.version,decision:'approve'}),/SKILL_ATTESTATION_REQUIRED/);
  const active=await trust.enroll('parent',{publisherId:'family.publisher',publicKeyPem:pem(k.publicKey)});
  assert.match(active.fingerprint,/^[a-f0-9]{64}$/);
  await trust.attest('parent',{manifest:m,publisherId:'family.publisher',
   artifactBase64:artifact.toString('base64'),signature:signature(k.privateKey,m)});
  await packages.review('parent',{id:m.id,version:m.version,decision:'approve'});
  assert.equal((await packages.install('parent',{id:m.id,version:m.version})).executable,false);
  assert.equal(trust.list('parent').events.length,2);
  assert.throws(()=>trust.list('child'),/PARENT_REQUIRED/);
  const restarted=new SkillPackageTrust({file:join(f.dir,'trust.json')});
  await restarted.load();assert.deepEqual(restarted.assertTrusted(m),trust.assertTrusted(m));
  await trust.revoke('parent',{publisherId:'family.publisher'});
  await assert.rejects(packages.install('parent',{id:m.id,version:m.version,
   expectedCurrentVersion:m.version}),/PUBLISHER_NOT_ACTIVE/);
 }finally{await f.close();}
});
test('R34 signatures cannot be replayed against changed version, bytes or signer',async()=>{
 const f=await fixture();try{
  const k=keys(),other=keys(),m=manifest();
  await f.trust.enroll('parent',{publisherId:'family.publisher',publicKeyPem:pem(k.publicKey)});
  const valid=signature(k.privateKey,m);
  await assert.rejects(f.trust.attest('parent',{manifest:manifest('1.0.1'),
   artifactBase64:artifact.toString('base64'),publisherId:'family.publisher',
   signature:valid}),/INVALID_SKILL_SIGNATURE/);
  await assert.rejects(f.trust.attest('parent',{manifest:m,
   artifactBase64:Buffer.from('forged').toString('base64'),publisherId:'family.publisher',
   signature:valid}),/INVALID_SKILL_SIGNATURE/);
  await assert.rejects(f.trust.attest('parent',{manifest:m,
   artifactBase64:artifact.toString('base64'),publisherId:'family.publisher',
   signature:signature(other.privateKey,m)}),/INVALID_SKILL_SIGNATURE/);
  assert.throws(()=>f.trust.attest('parent',{manifest:m,
   artifactBase64:'*invalid*',publisherId:'family.publisher',
   signature:valid}),/INVALID_ARTIFACT_BASE64/);
  assert.equal(f.trust.list('parent').attestations.length,0);
 }finally{await f.close();}
});
test('R34 fail closed on altered audit chain, unsigned state or publisher key replacement',async()=>{
 const f=await fixture();try{
  const k=keys(),m=manifest();
  await f.trust.enroll('parent',{publisherId:'family.publisher',publicKeyPem:pem(k.publicKey)});
  await f.trust.attest('parent',{manifest:m,publisherId:'family.publisher',
   artifactBase64:artifact.toString('base64'),signature:signature(k.privateKey,m)});
  const file=join(f.dir,'trust.json');
  const original=JSON.parse(await readFile(file,'utf8'));
  const tampered=structuredClone(original);tampered.events[0].target='someone.else';
  await writeFile(file,JSON.stringify(tampered));
  await assert.rejects(new SkillPackageTrust({file}).load(),/INVALID_SKILL_TRUST_STATE/);
  tampered.events=structuredClone(original.events);
  tampered.publishers[0].publicKeyPem=pem(keys().publicKey);
  await writeFile(file,JSON.stringify(tampered));
  await assert.rejects(new SkillPackageTrust({file}).load(),/INVALID_SKILL_TRUST_STATE/);
 }finally{await f.close();}
});
test('R34 parent revocation, duplicate submissions and invalid publisher key are rejected',async()=>{
 const f=await fixture();try{
  const k=keys();
  assert.throws(()=>f.trust.enroll('child',{publisherId:'family.publisher',publicKeyPem:pem(k.publicKey)}),/PARENT_REQUIRED/);
  assert.throws(()=>f.trust.enroll('parent',{publisherId:'family.publisher',publicKeyPem:'invalid'}),/INVALID_PUBLISHER_KEY/);
  await f.trust.enroll('parent',{publisherId:'family.publisher',publicKeyPem:pem(k.publicKey)});
  await assert.rejects(f.trust.enroll('parent',{publisherId:'family.publisher',publicKeyPem:pem(k.publicKey)}),/PUBLISHER_ALREADY_EXISTS/);
  await f.trust.revoke('parent',{publisherId:'family.publisher'});
  await assert.rejects(f.trust.revoke('parent',{publisherId:'family.publisher'}),/PUBLISHER_NOT_ACTIVE/);
 }finally{await f.close();}
});
,publisherId:'family.publisher',
   signature:valid}),/INVALID_ARTIFACT_BASE64/);
  assert.equal(f.trust.list('parent').attestations.length,0);
 }finally{await f.close();}
});
test('R34 fail closed on altered audit chain, unsigned state or publisher key replacement',async()=>{
 const f=await fixture();try{
  const k=keys(),m=manifest();
  await f.trust.enroll('parent',{publisherId:'family.publisher',publicKeyPem:pem(k.publicKey)});
  await f.trust.attest('parent',{manifest:m,publisherId:'family.publisher',
   artifactBase64:artifact.toString('base64'),signature:signature(k.privateKey,m)});
  const file=join(f.dir,'trust.json');
  const original=JSON.parse(await readFile(file,'utf8'));
  const tampered=structuredClone(original);tampered.events[0].target='someone.else';
  await writeFile(file,JSON.stringify(tampered));
  await assert.rejects(new SkillPackageTrust({file}).load(),/INVALID_SKILL_TRUST_STATE/);
  tampered.events=structuredClone(original.events);
  tampered.publishers[0].publicKeyPem=pem(keys().publicKey);
  await writeFile(file,JSON.stringify(tampered));
  await assert.rejects(new SkillPackageTrust({file}).load(),/INVALID_SKILL_TRUST_STATE/);
 }finally{await f.close();}
});
test('R34 parent revocation, duplicate submissions and invalid publisher key are rejected',async()=>{
 const f=await fixture();try{
  const k=keys();
  assert.throws(()=>f.trust.enroll('child',{publisherId:'family.publisher',publicKeyPem:pem(k.publicKey)}),/PARENT_REQUIRED/);
  assert.throws(()=>f.trust.enroll('parent',{publisherId:'family.publisher',publicKeyPem:'invalid'}),/INVALID_PUBLISHER_KEY/);
  await f.trust.enroll('parent',{publisherId:'family.publisher',publicKeyPem:pem(k.publicKey)});
  await assert.rejects(f.trust.enroll('parent',{publisherId:'family.publisher',publicKeyPem:pem(k.publicKey)}),/PUBLISHER_ALREADY_EXISTS/);
  await f.trust.revoke('parent',{publisherId:'family.publisher'});
  await assert.rejects(f.trust.revoke('parent',{publisherId:'family.publisher'}),/PUBLISHER_NOT_ACTIVE/);
 }finally{await f.close();}
});
