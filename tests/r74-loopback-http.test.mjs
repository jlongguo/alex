import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {getLoopbackJson} from '../scripts/loopback-http.mjs';

async function serve(handler){
 const server=createServer(handler);
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 return {server,url:'http://127.0.0.1:'+server.address().port};
}

test('loopback JSON probe 直接读取本地 HTTP，不依赖 fetch',async()=>{
 const {server,url}=await serve((req,res)=>{
  res.writeHead(200,{'Content-Type':'application/json'});
  res.end(JSON.stringify([{type:'page',webSocketDebuggerUrl:'ws://127.0.0.1/devtools'}]));
 });
 try{
  const value=await getLoopbackJson(url+'/json/list',{timeoutMs:500});
  assert.equal(value[0].type,'page');
 }finally{server.close();}
});

test('loopback JSON probe 拒绝非本机目标',async()=>{
 await assert.rejects(()=>getLoopbackJson('http://example.com/json/list'),/LOOPBACK_HTTP_ONLY/);
});

test('loopback JSON probe 对非 2xx 与无效 JSON fail closed',async()=>{
 const first=await serve((req,res)=>{res.writeHead(503);res.end('down');});
 try{await assert.rejects(()=>getLoopbackJson(first.url),/LOOPBACK_HTTP_STATUS_503/);}
 finally{first.server.close();}
 const second=await serve((req,res)=>{res.writeHead(200);res.end('not-json');});
 try{await assert.rejects(()=>getLoopbackJson(second.url),/LOOPBACK_HTTP_JSON_INVALID/);}
 finally{second.server.close();}
});
