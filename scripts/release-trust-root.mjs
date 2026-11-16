#!/usr/bin/env node
// R74 发布信任根：由离线 Root Ed25519 密钥签署 Permit signer 策略。
// verifier 必须先用预置 Root 公钥验签，不能把调用方任意提供的 signer 公钥当作可信。
import {createHash,createPrivateKey,createPublicKey,sign as cryptoSign,verify as cryptoVerify} from 'node:crypto';

export const RELEASE_TRUST_SCHEMA='alex.dev/release-trust-policy/v1';
const KEY_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const HASH=/^[0-9a-f]{64}$/;
const fail=code=>{throw Error(code);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);

function canonical(value){
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
}
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const validIso=value=>typeof value==='string'&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString()===value;

function normalizeKey(entry){
 if(!object(entry)||!KEY_ID.test(entry.keyId??'')||entry.algorithm!=='Ed25519'||
  typeof entry.publicKeyPem!=='string'||!entry.publicKeyPem.trim()||
  !['active','revoked'].includes(entry.status)||!validIso(entry.notBefore)||
  (entry.status==='revoked'&&!validIso(entry.revokedAt))||
  (entry.status==='active'&&entry.revokedAt!==null))
  fail('RELEASE_TRUST_KEY_INVALID');
 const key=createPublicKey(entry.publicKeyPem);
 if(key.asymmetricKeyType!=='ed25519')fail('RELEASE_TRUST_KEY_TYPE_INVALID');
 return {
  keyId:entry.keyId,algorithm:'Ed25519',publicKeyPem:entry.publicKeyPem,
  status:entry.status,notBefore:entry.notBefore,revokedAt:entry.revokedAt
 };
}

export function createReleaseTrustPolicy({
 keys,rootPrivateKeyPem,rootKeyId,generation=1,
 createdAt=new Date().toISOString()
}={}){
 if(!Array.isArray(keys)||keys.length<1||keys.length>64||
  !Number.isSafeInteger(generation)||generation<1||!validIso(createdAt)||
  !KEY_ID.test(rootKeyId??'')||typeof rootPrivateKeyPem!=='string'||!rootPrivateKeyPem.trim())
  fail('RELEASE_TRUST_INPUT_INVALID');
 const normalized=keys.map(normalizeKey).sort((a,b)=>a.keyId.localeCompare(b.keyId));
 if(new Set(normalized.map(k=>k.keyId)).size!==normalized.length)
  fail('RELEASE_TRUST_DUPLICATE_KEY');
 const root=createPrivateKey(rootPrivateKeyPem);
 if(root.asymmetricKeyType!=='ed25519')fail('RELEASE_TRUST_ROOT_KEY_TYPE_INVALID');
 const base={
  schema:RELEASE_TRUST_SCHEMA,generation,createdAt,rootKeyId,
  keys:normalized,
  note:'该策略只信任列出的 Permit signer；Root 私钥必须离线保存，策略文件本身不授权部署'
 };
 const policyDigestSha256=digest(base);
 const signature=cryptoSign(null,Buffer.from(canonical(base)),root).toString('base64');
 return {...base,policyDigestSha256,rootSignature:{algorithm:'Ed25519',valueBase64:signature}};
}

export function verifyReleaseTrustPolicy(policy,{rootPublicKeyPem,minGeneration=1}={}){
 if(!object(policy)||policy.schema!==RELEASE_TRUST_SCHEMA||
  !Number.isSafeInteger(policy.generation)||policy.generation<minGeneration||
  !validIso(policy.createdAt)||!KEY_ID.test(policy.rootKeyId??'')||
  !Array.isArray(policy.keys)||policy.keys.length<1||policy.keys.length>64||
  !HASH.test(policy.policyDigestSha256??'')||
  !object(policy.rootSignature)||policy.rootSignature.algorithm!=='Ed25519'||
  typeof policy.rootSignature.valueBase64!=='string')
  fail('RELEASE_TRUST_POLICY_INVALID');
 const normalized=policy.keys.map(normalizeKey).sort((a,b)=>a.keyId.localeCompare(b.keyId));
 if(JSON.stringify(normalized)!==JSON.stringify(policy.keys)||
  new Set(normalized.map(k=>k.keyId)).size!==normalized.length)
  fail('RELEASE_TRUST_POLICY_KEYS_INVALID');
 const {policyDigestSha256,rootSignature,...base}=policy;
 if(digest(base)!==policyDigestSha256)fail('RELEASE_TRUST_POLICY_DIGEST_MISMATCH');
 if(typeof rootPublicKeyPem!=='string'||!rootPublicKeyPem.trim())
  fail('RELEASE_TRUST_ROOT_PUBLIC_KEY_REQUIRED');
 const root=createPublicKey(rootPublicKeyPem);
 if(root.asymmetricKeyType!=='ed25519')fail('RELEASE_TRUST_ROOT_KEY_TYPE_INVALID');
 if(!cryptoVerify(null,Buffer.from(canonical(base)),root,Buffer.from(rootSignature.valueBase64,'base64')))
  fail('RELEASE_TRUST_ROOT_SIGNATURE_INVALID');
 return true;
}

export function resolveTrustedPermitKey(policy,keyId,{issuedAt,rootPublicKeyPem,minGeneration=1}={}){
 verifyReleaseTrustPolicy(policy,{rootPublicKeyPem,minGeneration});
 if(!validIso(issuedAt)||!KEY_ID.test(keyId??''))fail('RELEASE_TRUST_LOOKUP_INVALID');
 const key=policy.keys.find(item=>item.keyId===keyId);
 if(!key)fail('RELEASE_TRUST_SIGNER_UNKNOWN');
 if(key.status!=='active')fail('RELEASE_TRUST_SIGNER_REVOKED');
 if(Date.parse(issuedAt)<Date.parse(key.notBefore))fail('RELEASE_TRUST_SIGNER_NOT_YET_VALID');
 return key.publicKeyPem;
}
