// R8 outbound-only WebSocket for HTTPS-authorized realtime ASR.
// Small RFC 6455 subset: masked client frames, bounded uncompressed text,
// continuation, ping/pong, close. No browser-facing WebSocket or raw-audio
// server log. The endpoint is administrator configured, never user supplied.
import {EventEmitter} from 'node:events';
import {request as httpsRequest} from 'node:https';
import {randomBytes,createHash} from 'node:crypto';

const GUID='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const REALTIME_WS_MAX_INBOUND=128*1024;
export const REALTIME_WS_MAX_BUFFERED=192*1024;

export function validateRealtimeUrl(raw){
  let url;
  try{url=new URL(raw);}catch{throw new Error('INVALID_REALTIME_URL');}
  const host=url.hostname.toLowerCase();
  if(url.protocol!=='wss:'||url.username||url.password||url.hash
    ||host==='localhost'||host==='127.0.0.1'||host==='[::1]'
    ||host.endsWith('.localhost')||host.endsWith('.local')||url.port)
    throw new Error('INVALID_REALTIME_URL');
  if(!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host))
    throw new Error('INVALID_REALTIME_URL');
  return url;
}
function maskFrame(opcode,bytes){
  if(!Buffer.isBuffer(bytes))bytes=Buffer.from(bytes);
  if(bytes.length>65535)throw new Error('AUDIO_WS_OUTBOUND_TOO_LARGE');
  const extra=bytes.length<126?2:4;
  const head=Buffer.alloc(extra+4);
  head[0]=0x80|opcode;
  if(extra===2)head[1]=0x80|bytes.length;
  else{head[1]=0x80|126;head.writeUInt16BE(bytes.length,2);}
  const mask=randomBytes(4);mask.copy(head,extra);
  const coded=Buffer.alloc(bytes.length);
  for(let i=0;i<bytes.length;i++)coded[i]=bytes[i]^mask[i%4];
  return Buffer.concat([head,coded]);
}
export class SecureJsonSocket extends EventEmitter {
  #buffer=Buffer.alloc(0);
  #fragment=null;
  #closed=false;
  constructor(socket,{maxInbound=REALTIME_WS_MAX_INBOUND,
    maxBuffered=REALTIME_WS_MAX_BUFFERED}={}){
    super();
    this.socket=socket;this.maxInbound=maxInbound;this.maxBuffered=maxBuffered;
    socket.on('data',bytes=>this.#ingest(bytes));
    socket.on('error',()=>this.#stop('AUDIO_WS_CONNECTION_LOST'));
    socket.on('end',()=>this.#stop('AUDIO_WS_CONNECTION_LOST'));
    socket.on('close',()=>this.#stop('AUDIO_WS_CONNECTION_LOST'));
  }
  get closed(){return this.#closed;}
  #stop(reason){
    if(this.#closed)return;
    this.#closed=true;this.#buffer=Buffer.alloc(0);this.#fragment=null;
    this.emit('closed',reason);
  }
  #write(opcode,bytes){
    if(this.#closed)throw new Error('AUDIO_WS_CLOSED');
    const frame=maskFrame(opcode,bytes);
    if(this.socket.writableLength+frame.length>this.maxBuffered)
      throw new Error('AUDIO_WS_BACKPRESSURE');
    this.socket.write(frame);
  }
  send(value){
    const encoded=Buffer.from(JSON.stringify(value));
    if(encoded.length>64*1024)throw new Error('AUDIO_WS_OUTBOUND_TOO_LARGE');
    this.#write(1,encoded);
  }
  close(){
    if(this.#closed)return;
    try{this.#write(8,Buffer.from([0x03,0xe8]));}catch{}
    this.#stop('AUDIO_WS_CLOSED');
    this.socket.end();
    this.socket.destroy?.();
  }
  #fail(reason){
    this.#stop(reason);
    this.socket.destroy?.();
  }
  #ingest(data){
    if(this.#closed)return;
    this.#buffer=Buffer.concat([this.#buffer,data]);
    if(this.#buffer.length>this.maxInbound+32){
      this.#fail('AUDIO_WS_OVERSIZE');return;
    }
    try{
      while(this.#buffer.length>=2){
        const a=this.#buffer[0],b=this.#buffer[1];
        const opcode=a&15,fin=!!(a&0x80);
        if(a&0x70||b&0x80)throw new Error('AUDIO_WS_BAD_FRAME');
        let count=b&127,offset=2;
        if(count===126){
          if(this.#buffer.length<4)return;
          count=this.#buffer.readUInt16BE(2);offset=4;
        }else if(count===127){
          if(this.#buffer.length<10)return;
          const high=this.#buffer.readUInt32BE(2),low=this.#buffer.readUInt32BE(6);
          if(high||low>this.maxInbound)throw new Error('AUDIO_WS_OVERSIZE');
          count=low;offset=10;
        }
        if(count>this.maxInbound)throw new Error('AUDIO_WS_OVERSIZE');
        if(this.#buffer.length<offset+count)return;
        const payload=this.#buffer.subarray(offset,offset+count);
        this.#buffer=this.#buffer.subarray(offset+count);
        if(opcode===8){this.#fail('AUDIO_WS_REMOTE_CLOSE');return;}
        if(opcode===9){
          if(!fin||count>125)throw new Error('AUDIO_WS_BAD_FRAME');
          this.#write(10,payload);continue;
        }
        if(opcode===10)continue;
        if(![0,1].includes(opcode))throw new Error('AUDIO_WS_BAD_FRAME');
        if(opcode===1){
          if(this.#fragment)throw new Error('AUDIO_WS_BAD_FRAME');
          this.#fragment=Buffer.from(payload);
        }else{
          if(!this.#fragment)throw new Error('AUDIO_WS_BAD_FRAME');
          this.#fragment=Buffer.concat([this.#fragment,payload]);
        }
        if(this.#fragment.length>this.maxInbound)throw new Error('AUDIO_WS_OVERSIZE');
        if(fin){
          const text=this.#fragment.toString('utf8');
          this.#fragment=null;
          let value;
          try{value=JSON.parse(text);}catch{
            throw new Error('AUDIO_WS_INVALID_JSON');
          }
          if(!value||typeof value!=='object'||Array.isArray(value))
            throw new Error('AUDIO_WS_INVALID_JSON');
          this.emit('json',value);
        }
      }
    }catch(error){
      this.#fail(error.message.startsWith('AUDIO_WS_')
        ?error.message:'AUDIO_WS_BAD_FRAME');
    }
  }
}
export function connectSecureJsonSocket({
  url,apiKey,timeoutMs=10_000,requestFactory=httpsRequest,
  maxInbound=REALTIME_WS_MAX_INBOUND}={}){
  const target=validateRealtimeUrl(url);
  if(typeof apiKey!=='string'||!apiKey||apiKey.length>4096
    ||!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>30000)
    throw new Error('INVALID_REALTIME_CONFIG');
  return new Promise((resolve,reject)=>{
    const nonce=randomBytes(16).toString('base64');
    const accept=createHash('sha1').update(nonce+GUID).digest('base64');
    const req=requestFactory(target,{
      method:'GET',timeout:timeoutMs,
      headers:{
        Authorization:'Bearer '+apiKey,
        Connection:'Upgrade',Upgrade:'websocket',
        'Sec-WebSocket-Version':'13','Sec-WebSocket-Key':nonce
      }
    });
    let done=false;
    const fail=reason=>{
      if(done)return;
      done=true;req.destroy?.();
      reject(new Error(reason));
    };
    req.on('upgrade',(res,socket,head)=>{
      if(done){socket.destroy();return;}
      const headers=res.headers??{};
      if(res.statusCode!==101
        ||String(headers.upgrade??'').toLowerCase()!=='websocket'
        ||headers['sec-websocket-accept']!==accept
        ||headers['sec-websocket-extensions']){
        socket.destroy();fail('AUDIO_WS_HANDSHAKE_FAILED');return;
      }
      done=true;
      const ws=new SecureJsonSocket(socket,{maxInbound});
      if(head?.length)socket.emit('data',head);
      resolve(ws);
    });
    req.on('response',res=>{
      res.resume?.();
      fail('AUDIO_WS_HANDSHAKE_FAILED');
    });
    req.on('timeout',()=>fail('AUDIO_WS_CONNECT_TIMEOUT'));
    req.on('error',()=>fail('AUDIO_WS_CONNECT_FAILED'));
    req.end();
  });
}
