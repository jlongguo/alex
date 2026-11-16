import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {createReleaseTrustPolicy,verifyReleaseTrustPolicy,resolveTrustedPermitKey} from '../scripts/release-trust-root.mjs';
import {createReleaseRevocations,verifyReleaseRevocations,assertPermitNotRevoked} from '../scripts/release-permit-revocations.mjs';
import {verifyWorkflowSource,ACTION_PINS} from '../scripts/ci-workflow-provenance.mjs';

const pem=()=>{
 const {privateKey,publicKey}=generateKeyPairSync('ed25519');
 return {
  privateKeyPem:privateKey.export({type:'pkcs8',format:'pem'}).toString(),
  publicKeyPem:publicKey.export({type:'spki',format:'pem'}).toString()
 };
};

test('R74 Root 签名 Trust Policy 并解析 active Permit signer',()=>{
 const root=pem(),signer=pem();
 const policy=createReleaseTrustPolicy({
  keys:[{keyId:'permit-key-v1',algorithm:'Ed25519',publicKeyPem:signer.publicKeyPem,
   status:'active',notBefore:'2026-11-16T00:00:00.000Z',revokedAt:null}],
  rootPrivateKeyPem:root.privateKeyPem,rootKeyId:'offline-root-v1',generation:3,
  createdAt:'2026-11-16T01:00:00.000Z'
 });
 assert.equal(verifyReleaseTrustPolicy(policy,{rootPublicKeyPem:root.publicKeyPem,minGeneration:3}),true);
 assert.equal(resolveTrustedPermitKey(policy,'permit-key-v1',{
  issuedAt:'2026-11-16T02:00:00.000Z',rootPublicKeyPem:root.publicKeyPem
 }),signer.publicKeyPem);
});

test('R74 Trust Policy 被修改时 Root 签名校验失败',()=>{
 const root=pem(),signer=pem();
 const policy=createReleaseTrustPolicy({
  keys:[{keyId:'permit-key-v1',algorithm:'Ed25519',publicKeyPem:signer.publicKeyPem,
   status:'active',notBefore:'2026-11-16T00:00:00.000Z',revokedAt:null}],
  rootPrivateKeyPem:root.privateKeyPem,rootKeyId:'offline-root-v1',
  createdAt:'2026-11-16T01:00:00.000Z'
 });
 policy.keys[0].status='revoked';
 policy.keys[0].revokedAt='2026-11-16T01:30:00.000Z';
 assert.throws(()=>verifyReleaseTrustPolicy(policy,{rootPublicKeyPem:root.publicKeyPem}),
  /RELEASE_TRUST_POLICY_DIGEST_MISMATCH/);
});

test('R74 revoked signer 不能继续验证 Permit 信任',()=>{
 const root=pem(),signer=pem();
 const policy=createReleaseTrustPolicy({
  keys:[{keyId:'permit-key-v1',algorithm:'Ed25519',publicKeyPem:signer.publicKeyPem,
   status:'revoked',notBefore:'2026-11-16T00:00:00.000Z',revokedAt:'2026-11-16T03:00:00.000Z'}],
  rootPrivateKeyPem:root.privateKeyPem,rootKeyId:'offline-root-v1',
  createdAt:'2026-11-16T04:00:00.000Z'
 });
 assert.throws(()=>resolveTrustedPermitKey(policy,'permit-key-v1',{
  issuedAt:'2026-11-16T02:00:00.000Z',rootPublicKeyPem:root.publicKeyPem
 }),/RELEASE_TRUST_SIGNER_REVOKED/);
});

test('R74 Root 签名 Permit revocation manifest 并拒绝命中的 Permit',()=>{
 const root=pem();
 const permit={permitId:'rp-'+'a'.repeat(24),permitDigestSha256:'b'.repeat(64)};
 const value=createReleaseRevocations({
  revocations:[{...permit,revokedAt:'2026-11-16T05:00:00.000Z',reason:'superseded candidate'}],
  rootPrivateKeyPem:root.privateKeyPem,rootKeyId:'offline-root-v1',sequence:7,
  createdAt:'2026-11-16T05:01:00.000Z'
 });
 assert.equal(verifyReleaseRevocations(value,{rootPublicKeyPem:root.publicKeyPem,minSequence:7}),true);
 assert.throws(()=>assertPermitNotRevoked(permit,value,{
  rootPublicKeyPem:root.publicKeyPem,minSequence:7
 }),/RELEASE_PERMIT_REVOKED/);
});

test('R74 旧 revocation sequence 会 fail closed',()=>{
 const root=pem();
 const value=createReleaseRevocations({
  revocations:[],rootPrivateKeyPem:root.privateKeyPem,rootKeyId:'offline-root-v1',
  sequence:2,createdAt:'2026-11-16T05:01:00.000Z'
 });
 assert.throws(()=>verifyReleaseRevocations(value,{
  rootPublicKeyPem:root.publicKeyPem,minSequence:3
 }),/RELEASE_REVOCATIONS_INVALID/);
});

test('R74 workflow provenance 拒绝浮动 @v4',()=>{
 assert.throws(()=>verifyWorkflowSource('steps:\n  - uses: actions/checkout@v4\n'),
  /WORKFLOW_PROVENANCE_ACTION_NOT_PINNED/);
});

test('R74 workflow provenance 接受固定官方 action SHA',()=>{
 const source='steps:\n  - uses: actions/checkout@'+ACTION_PINS['actions/checkout']+'\n';
 const report=verifyWorkflowSource(source,'.github/workflows/example.yml');
 assert.equal(report.officialActions.length,1);
 assert.match(report.digestSha256,/^[0-9a-f]{64}$/);
});
