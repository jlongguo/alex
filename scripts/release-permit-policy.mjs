// R74 组合策略验证：Root -> Trust Policy -> Permit signer -> Permit -> Revocation Manifest。
// 这里仍只验证“许可是否可信”，不产生部署授权。
import {verifyReleasePermit} from './release-permit.mjs';
import {resolveTrustedPermitKey} from './release-trust-root.mjs';
import {assertPermitNotRevoked} from './release-permit-revocations.mjs';

export function verifyReleasePermitPolicy(permit,{
 trustPolicy,revocations,rootPublicKeyPem,expectedCommit=null,now=null,
 minTrustGeneration=1,minRevocationSequence=1
}={}){
 const publicKeyPem=resolveTrustedPermitKey(trustPolicy,permit?.signature?.keyId,{
  issuedAt:permit?.issuedAt,rootPublicKeyPem,minGeneration:minTrustGeneration
 });
 verifyReleasePermit(permit,{publicKeyPem,expectedCommit,now});
 assertPermitNotRevoked(permit,revocations,{
  rootPublicKeyPem,minSequence:minRevocationSequence
 });
 return {
  ok:true,permitId:permit.permitId,commitSha:permit.candidate.commitSha,
  signerKeyId:permit.signature.keyId,
  trustGeneration:trustPolicy.generation,
  revocationSequence:revocations.sequence,
  deployAuthorized:false,physicalSafetyCertified:false
 };
}
