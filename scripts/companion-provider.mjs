// One opt-in, tool-free OpenAI-compatible chat adapter.
// This provider only returns user-visible text. It cannot dispatch tasks,
// invoke SkillRegistry actions, call DeviceGateway, or drive a robot.
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
  async reply({mode,actor,messages}) {
    if(!['chat','english','story'].includes(mode)||!['parent','child'].includes(actor))
      throw new Error('INVALID_COMPANION_CONTEXT');
    if(!Array.isArray(messages)||messages.length<1||messages.length>32)
      throw new Error('INVALID_COMPANION_HISTORY');
    const history=messages.slice(-12).map(message=>{
      if(!['user','assistant'].includes(message.role) || typeof message.text!=='string'
        || !message.text.trim()||message.text.length>1200)
        throw new Error('INVALID_COMPANION_HISTORY');
      return {role:message.role,content:message.text};
    });
    const system = [
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
          :'Use concise, conversational, age-appropriate answers.',
    ].join(' ');
    const endpoint=new URL(this.url.toString().replace(/\/$/,'')+'/chat/completions');
    let response;
    try {
      response=await this.fetchFn(endpoint,{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(this.timeout),
        headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.apiKey},
        body:JSON.stringify({model:this.model,temperature:0.5,max_tokens:320,
          messages:[{role:'system',content:system},...history]})
      });
    } catch {
      throw new Error('CHAT_PROVIDER_UNAVAILABLE');
    }
    if(!response || !response.ok)throw new Error('CHAT_PROVIDER_HTTP_'+String(response?.status??'UNAVAILABLE'));
    let payload;
    try {payload=await response.json();}catch {throw new Error('CHAT_PROVIDER_INVALID_RESPONSE');}
    const text=payload?.choices?.[0]?.message?.content;
    if(typeof text!=='string'||!text.trim()||text.length>1200)
      throw new Error('CHAT_PROVIDER_INVALID_RESPONSE');
    return text.trim();
  }
}
