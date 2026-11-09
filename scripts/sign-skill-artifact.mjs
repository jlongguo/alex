#!/usr/bin/env node
// R34 offline signing helper. Never sends the private key or artifact to Alex.
// Usage: node scripts/sign-skill-artifact.mjs manifest.json artifact.bin private.pem publisher.id
import {readFile} from 'node:fs/promises';
import {createHash,createPrivateKey,sign} from 'node:crypto';
import {manifestDigest,signedPayload} from './skill-package-trust.mjs';
async function main(){
 const [manifestFile,artifactFile,privateKeyFile,publisherId]=process.argv.slice(2);
 if(!manifestFile||!artifactFile||!privateKeyFile||
  typeof publisherId!=='string'||!/^[a-z][a-z0-9.-]{2,79}$/.test(publisherId))
  throw Error('USAGE: node scripts/sign-skill-artifact.mjs manifest.json artifact.bin private.pem publisher.id');
 const manifest=JSON.parse(await readFile(manifestFile,'utf8'));
 if(!manifest||typeof manifest.id!=='string'||typeof manifest.version!=='string')
  throw Error('INVALID_SKILL_MANIFEST');
 const bytes=await readFile(artifactFile);
 if(bytes.length===0||bytes.length>4096)
  throw Error('ARTIFACT_TOO_LARGE_FOR_PARENT_HTTP_API');
 const privateKey=createPrivateKey(await readFile(privateKeyFile,'utf8'));
 if(privateKey.asymmetricKeyType!=='ed25519')throw Error('ED25519_REQUIRED');
 const mh=manifestDigest(manifest);
 const ah=createHash('sha256').update(bytes).digest('hex');
 const signature=sign(null,signedPayload(mh,ah),privateKey).toString('base64');
 // Only share this envelope with the parent API. Never emit key material.
 process.stdout.write(JSON.stringify({id:manifest.id,version:manifest.version,
  publisherId,artifactBase64:bytes.toString('base64'),signature},null,2)+'\n');
}
main().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
