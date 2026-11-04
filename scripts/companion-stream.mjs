// OpenAI-compatible SSE response parser. No device actions or tool calls.
// A partial stream is only a provisional UI preview until a [DONE] sentinel.
const MAX_STREAM_BYTES = 131072;
const MAX_OUTPUT_CHARS = 1200;

export async function collectCompanionSse(body,{signal,onDelta=()=>{}}={}) {
  if(!body||typeof body.getReader!=='function')throw new Error('CHAT_STREAM_UNAVAILABLE');
  const reader=body.getReader();
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let buffer='',bytes=0,text='',done=false;
  const parseEvent=async raw=>{
    const lines=raw.split('\n');
    const payload=lines.filter(line=>line.startsWith('data:'))
      .map(line=>line.slice(5).trimStart()).join('\n').trim();
    if(!payload)return;
    if(payload==='[DONE]'){done=true;return;}
    let event;
    try{event=JSON.parse(payload);}catch{throw new Error('CHAT_STREAM_INVALID_JSON');}
    if(event.error)throw new Error('CHAT_STREAM_PROVIDER_ERROR');
    const choice=event?.choices?.[0];
    if(!choice||typeof choice!=='object')throw new Error('CHAT_STREAM_INVALID_CHUNK');
    if(choice.delta?.tool_calls||choice.delta?.function_call
      ||choice.message?.tool_calls||choice.finish_reason==='tool_calls'
      ||choice.finish_reason==='function_call')
      throw new Error('CHAT_STREAM_TOOLS_FORBIDDEN');
    // Do not save a model response that was cut off by token limits or
    // suppressed by an upstream content filter as a completed answer.
    if(choice.finish_reason&&choice.finish_reason!=='stop')
      throw new Error('CHAT_STREAM_INCOMPLETE_FINISH');
    const delta=choice.delta?.content;
    if(delta!==undefined&&delta!==null){
      if(typeof delta!=='string')throw new Error('CHAT_STREAM_INVALID_CHUNK');
      if(text.length+delta.length>MAX_OUTPUT_CHARS)throw new Error('CHAT_STREAM_OUTPUT_TOO_LONG');
      text+=delta;
      if(signal?.aborted)throw new Error('COMPANION_TURN_CANCELLED');
      if(delta)await onDelta(delta);
    }
  };
  try{
    while(!done){
      if(signal?.aborted)throw new Error('COMPANION_TURN_CANCELLED');
      const {value,done:ended}=await reader.read();
      if(ended)break;
      bytes+=value.byteLength;
      if(bytes>MAX_STREAM_BYTES)throw new Error('CHAT_STREAM_TOO_LARGE');
      buffer+=decoder.decode(value,{stream:true}).replace(/\r\n/g,'\n');
      if(buffer.length>MAX_STREAM_BYTES)throw new Error('CHAT_STREAM_TOO_LARGE');
      let end;
      while((end=buffer.indexOf('\n\n'))!==-1){
        const raw=buffer.slice(0,end);buffer=buffer.slice(end+2);
        await parseEvent(raw);
        if(done)break;
      }
    }
    if(!done)throw new Error('CHAT_STREAM_INCOMPLETE');
    if(signal?.aborted)throw new Error('COMPANION_TURN_CANCELLED');
    if(!text.trim())throw new Error('CHAT_PROVIDER_INVALID_RESPONSE');
    return text.trim();
  }finally{
    // Always close the reader: an upstream may keep its socket open even
    // after the logical [DONE] event and shouldn't leak connections.
    await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}
