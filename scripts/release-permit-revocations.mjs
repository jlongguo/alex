#!/usr/bin/env node
// R74 Permit 撤销清单：Root 签名的只读快照；不提供浏览器写 API，也不触发部署/回滚。
// sequence 用于调用方防止旧清单回滚；真正的持久化单调性由外部保存的 last-known sequence 负责。
import {createHash,createPrivateKey,createPublicKey,sign as cryptoSign,verify as cryptoVerify} from 'node:crypto';

export const RELEASE_REVOCATIONS_SCHEMA='alex.dev/release-revocations/v1';
const HASH=/^[0-9a-f]{64}$/;
const PERMIT=/^rp-[0-9a-f]{24}$/;
const KEY_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const fail=code=>{throw Error(code);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);

function canonical(value){
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
}
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const validIso=value=>typeof value==='string'&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString()===value;

function normalizeRevocation(item){
 if(!object(item)||!PERMIT.test(item.permitId??'')||!HASH.test(item.permitDigestSha256??'')||
  !validIso(item.revokedAt)||typeof item.reason!=='string'||item.reason.trim().length<3||
  item.reason.length>240)
  fail('RELEASE_REVOCATION_ENTRY_INVALID');
 return {
  permitId:item.permitId,permitDigestSha256:item.permitDigestSha256,
  revokedAt:item.revokedAt,reason:item.reason.trim()
 };
}

export function createReleaseRevocations({
 revocations=[],rootPrivateKeyPem,rootKeyId,sequence=1,
 createdAt=new Date().toISOString()
}={}){
 if(!Array.isArray(revocations)||revocations.length>5000||
  !Number.isSafeInteger(sequence)||sequence<1||!validIso(createdAt)||
  !KEY_ID.test(rootKeyId??'')||typeof rootPrivateKeyPem!=='string'||!rootPrivateKeyPem.trim())
  fail('RELEASE_REVOCATIONS_INPUT_INVALID');
 const normalized=revocations.map(normalizeRevocation)
  .sort((a,b)=>a.permitId.localeCompare(b.permitId));
 if(new Set(normalized.map(r=>r.permitId+'\0'+r.permitDigestSha256)).size!==normalized.length)
  fail('RELEASE_REVOCATIONS_DUPLICATE');
 const root=createPrivateKey(rootPrivateKeyPem);
 if(root.asymmetricKeyType!=='ed25519')fail('RELEASE_REVOCATIONS_ROOT_KEY_TYPE_INVALID');
 const base={
  schema:RELEASE_REVOCATIONS_SCHEMA,sequence,createdAt,rootKeyId,
  revocations:normalized,
  note:'撤销清单只使指定 Permit 失效，不执行回滚、不修改 Candidate 或 Approval Ledger'
 };
 const revocationsDigestSha256=digest(base);
 const signature=cryptoSign(null,Buffer.from(canonical(base)),root).toString('base64');
 return {...base,revocationsDigestSha256,rootSignature:{algorithm:'Ed25519',valueBase64:signature}};
}

export function verifyReleaseRevocations(value,{rootPublicKeyPem,minSequence=1}={}){
 if(!object(value)||value.schema!==RELEASE_REVOCATIONS_SCHEMA||
  !Number.isSafeInteger(value.sequence)||value.sequence<minSequence||
  !validIso(value.createdAt)||!KEY_ID.test(value.rootKeyId??'')||
  !Array.isArray(value.revocations)||value.revocations.length>5000||
  !HASH.test(value.revocationsDigestSha256??'')||
  !object(value.rootSignature)||value.rootSignature.algorithm!=='Ed25519'||
  typeof value.rootSignature.valueBase64!=='string')
  fail('RELEASE_REVOCATIONS_INVALID');
 const normalized=value.revocations.map(normalizeRevocation)
  .sort((a,b)=>a.permitId.localeCompare(b.permitId));
 if(JSON.stringify(normalized)!==JSON.stringify(value.revocations)||
  new Set(normalized.map(r=>r.permitId+'\0'+r.permitDigestSha256)).size!==normalized.length)
  fail('RELEASE_REVOCATIONS_ENTRIES_INVALID');
 const {revocationsDigestSha256,rootSignature,...base}=value;
 if(digest(base)!==revocationsDigestSha256)fail('RELEASE_REVOCATIONS_DIGEST_MISMATCH');
 if(typeof rootPublicKeyPem!=='string'||!rootPublicKeyPem.trim())
  fail('RELEASE_REVOCATIONS_ROOT_PUBLIC_KEY_REQUIRED');
 const root=createPublicKey(rootPublicKeyPem);
 if(root.asymmetricKeyType!=='ed25519')fail('RELEASE_REVOCATIONS_ROOT_KEY_TYPE_INVALID');
 if(!cryptoVerify(null,Buffer.from(canonical(base)),root,Buffer.from(rootSignature.valueBase64,'base64')))
  fail('RELEASE_REVOCATIONS_ROOT_SIGNATURE_INVALID');
 return true;
}

export function assertPermitNotRevoked(permit,revocations,options={}){
 verifyReleaseRevocations(revocations,options);
 const hit=revocations.revocations.find(item=>
  item.permitId===permit.permitId&&item.permitDigestSha256===permit.permitDigestSha256);
 if(hit)fail('RELEASE_PERMIT_REVOKED');
 return true;
}
