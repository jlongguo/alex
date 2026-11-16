// 仅用于本机/CI loopback readiness 探测，绕过代理环境变量与 fetch dispatcher 差异。
import {request} from 'node:http';

export function getLoopbackJson(url,{timeoutMs=800,maxBytes=256*1024}={}){
 const target=new URL(url);
 if(target.protocol!=='http:'||!['127.0.0.1','localhost','::1'].includes(target.hostname))
  return Promise.reject(Error('LOOPBACK_HTTP_ONLY'));
 if(!Number.isInteger(timeoutMs)||timeoutMs<50||timeoutMs>5000||
  !Number.isInteger(maxBytes)||maxBytes<1024||maxBytes>1024*1024)
  return Promise.reject(Error('LOOPBACK_HTTP_OPTIONS_INVALID'));
 return new Promise((resolve,reject)=>{
  const req=request(target,{method:'GET',headers:{Accept:'application/json'}},res=>{
   const chunks=[];let size=0;
   res.on('data',chunk=>{
    size+=chunk.length;
    if(size>maxBytes){
     req.destroy(Error('LOOPBACK_HTTP_RESPONSE_TOO_LARGE'));
     return;
    }
    chunks.push(chunk);
   });
   res.on('end',()=>{
    if((res.statusCode??500)<200||(res.statusCode??500)>=300){
     reject(Error('LOOPBACK_HTTP_STATUS_'+String(res.statusCode??0)));
     return;
    }
    try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}
    catch{reject(Error('LOOPBACK_HTTP_JSON_INVALID'));}
   });
  });
  req.setTimeout(timeoutMs,()=>req.destroy(Error('LOOPBACK_HTTP_TIMEOUT')));
  req.on('error',reject);
  req.end();
 });
}
