// Conversation-only OpenAI-compatible text adapter.
// No function tools, device commands, agent actions or raw media inputs.
import {collectCompanionSse} from './companion-stream.mjs';

function ensureHttps(url) {
  const value = new URL(url);
  if(value.protocol!=='https:' || value.username || value.password || value.search || value.hash)
    throw new Error('INVALID_CHAT_PROVIDER_URL');
  return value;
}

export class CompatibleCompanionProvider {
  kind='compatible';
  constructor({baseUrl,apiKey,model,fetchFn=fetch,timeoutMs=15000}) {
    this.url=ensureHttps(baseUrl);
    if(typeof apiKey!=='string'||!apiKey||typeof model!=='string'||!model||model.length>120)
      throw new Error('INVALID_CHAT_PROVIDER_CONFIG');
    this.apiKey=apiKey;
    this.model=model;
    this.fetchFn=fetchFn;
    this.timeout=Math.min(25000,Math.max(1000,timeoutMs));
  }
  #messages(mode,actor,messages) {
    if(!['chat','english','story','quiz'].includes(mode)||!['parent','child'].includes(actor))
      throw new Error('INVALID_COMPANION_CONTEXT');
    if(!Array.isArray(messages)||messages.length<1||messages.length>32)
      throw new Error('INVALID_COMPANION_HISTORY');
    const history=messages.slice(-12).map(message=>{
      if(!['user','assistant'].includes(message.role) || typeof message.text!=='string'
        || !message.text.trim()||message.text.length>1200)
        throw new Error('INVALID_COMPANION_HISTORY');
      return {role:message.role,content:message.text};
    });
    const system=[
      'You are Alex, a warm and respectful text companion in a family software simulator.',
      'This is a conversation only. Never claim to have executed actions, moved any robot,',
      'controlled devices, checked sensors, recorded audio, or verified pronunciation.',
      'Never output device commands, URLs requesting secrets, or pretend to perform tools.',
      'Do not ask a child for legal name, school, home address, phone, contact details or secrets.',
      'Do not solicit private information. Avoid romantic or exclusive emotional dependency.',
      'Answer in the language the speaker uses. Avoid unsupported factual claims.',
      mode==='english'
        ?'Use simple CEFR A1 English; one short question per turn; help with one or two mistakes without pretending to hear voice.'
        :mode==='story'
          ?'Co-create a family-friendly interactive story, offer concise A/B choices, respect the reader choices.'
          :mode==='quiz'
            ?'Give a short age-appropriate everyday science question with A/B choices. Explain only after the learner answers, but do not self-grade or certify real learning.'
            :'Use concise, conversational, age-appropriate answers.',
    ].join(' ');
    return [{role:'system',content:system},...history];
  }
  #endpoint() {return new URL(this.url.toString().replace(/\/$/,'')+'/chat/completions');}
  #request(messages,{stream=false,signal}={}) {
    const deadline=AbortSignal.timeout(this.timeout);
    return {
      method:'POST',redirect:'error',
      signal:signal?AbortSignal.any([signal,deadline]):deadline,
      headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.apiKey},
      body:JSON.stringify({model:this.model,temperature:0.5,max_tokens:320,stream,messages})
    };
  }
  async reply({mode,actor,messages,signal}) {
    const prompt=this.#messages(mode,actor,messages);
    let response;
    try{response=await this.fetchFn(this.#endpoint(),this.#request(prompt,{signal}));}
    catch{throw new Error(signal?.aborted?'COMPANION_TURN_CANCELLED':'CHAT_PROVIDER_UNAVAILABLE');}
    if(!response?.ok)throw new Error('CHAT_PROVIDER_HTTP_'+String(response?.status??'UNAVAILABLE'));
    let payload;
    try{payload=await response.json();}
    catch{throw new Error('CHAT_PROVIDER_INVALID_RESPONSE');}
    if(payload?.choices?.[0]?.message?.tool_calls||payload?.choices?.[0]?.message?.function_call)
      throw new Error('CHAT_STREAM_TOOLS_FORBIDDEN');
    const finish=payload?.choices?.[0]?.finish_reason;
    if(finish&&finish!=='stop')throw new Error('CHAT_STREAM_INCOMPLETE_FINISH');
    const text=payload?.choices?.[0]?.message?.content;
    if(typeof text!=='string'||!text.trim()||text.length>1200)
      throw new Error('CHAT_PROVIDER_INVALID_RESPONSE');
    if(signal?.aborted)throw new Error('COMPANION_TURN_CANCELLED');
    return text.trim();
  }
  async streamReply({mode,actor,messages,signal,onDelta}) {
    const prompt=this.#messages(mode,actor,messages);
    let response;
    try{response=await this.fetchFn(this.#endpoint(),this.#request(prompt,{stream:true,signal}));}
    catch{throw new Error(signal?.aborted?'COMPANION_TURN_CANCELLED':'CHAT_PROVIDER_UNAVAILABLE');}
    if(!response?.ok)throw new Error('CHAT_PROVIDER_HTTP_'+String(response?.status??'UNAVAILABLE'));
    const contentType=response.headers?.get?.('content-type')??'';
    if(!/^text\/event-stream(?:\s*;|$)/i.test(contentType))
      throw new Error('CHAT_STREAM_UNAVAILABLE');
    try {
      return await collectCompanionSse(response.body,{signal:response.signal??signal,onDelta});
    } catch(err) {
      if(signal?.aborted)throw new Error('COMPANION_TURN_CANCELLED');
      throw err;
    }
  }
}
