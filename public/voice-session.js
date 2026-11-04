// Real browser Web Speech adapter with explicit parent preference gating.
// No audio capture in this module, no network requests, and no server-side
// audio storage. Browser vendors may process SpeechRecognition in the cloud.
// All callbacks are epoch-scoped to reject late speech/recognition events.
class AlexVoiceBridge {
  #epoch=0;
  #state='idle';
  #recognition=null;
  #consent={voiceInputAllowed:false,voiceOutputAllowed:false};
  constructor({recognitionFactory=null,synthesis=null,utteranceFactory=null,
    onState=()=>{},onTranscript=()=>{},onError=()=>{}}={}){
    for(const fn of [onState,onTranscript,onError])
      if(typeof fn!=='function')throw new Error('INVALID_VOICE_CALLBACK');
    this.recognitionFactory=recognitionFactory;
    this.synthesis=synthesis;
    this.utteranceFactory=utteranceFactory;
    this.onState=onState;this.onTranscript=onTranscript;this.onError=onError;
  }
  snapshot(){return Object.freeze({
    state:this.#state,epoch:this.#epoch,
    voiceInputAllowed:this.#consent.voiceInputAllowed,
    voiceOutputAllowed:this.#consent.voiceOutputAllowed,
    recognitionSupported:typeof this.recognitionFactory==='function',
    speechSupported:!!this.synthesis&&typeof this.utteranceFactory==='function'
  });}
  #set(state){
    if(this.#state===state)return;
    this.#state=state;
    this.onState(state);
  }
  setConsent(value){
    if(!value||typeof value.voiceInputAllowed!=='boolean'
      ||typeof value.voiceOutputAllowed!=='boolean')
      throw new Error('INVALID_VOICE_CONSENT');
    const revokeInput=this.#consent.voiceInputAllowed&&!value.voiceInputAllowed;
    const revokeOutput=this.#consent.voiceOutputAllowed&&!value.voiceOutputAllowed;
    this.#consent={voiceInputAllowed:value.voiceInputAllowed,
      voiceOutputAllowed:value.voiceOutputAllowed};
    if((revokeInput&&this.#state==='listening')
      ||(revokeOutput&&this.#state==='speaking'))this.interrupt('consent-revoked');
    return this.snapshot();
  }
  interrupt(reason='interrupted'){
    if(typeof reason!=='string'||reason.length>60)throw new Error('INVALID_VOICE_INTERRUPT');
    this.#epoch++;
    const recognition=this.#recognition;
    this.#recognition=null;
    try{recognition?.abort?.();}catch{}
    try{this.synthesis?.cancel?.();}catch{}
    this.#set('idle');
    return this.snapshot();
  }
  stopListening(){
    if(this.#state==='listening')this.interrupt('stop-listening');
  }
  stopSpeaking(){
    if(this.#state==='speaking')this.interrupt('stop-speaking');
  }
  startListening({lang='zh-CN'}={}){
    if(!this.#consent.voiceInputAllowed)throw new Error('VOICE_INPUT_NOT_ALLOWED');
    if(typeof this.recognitionFactory!=='function')throw new Error('VOICE_INPUT_UNSUPPORTED');
    if(!['zh-CN','en-US'].includes(lang))throw new Error('INVALID_VOICE_LANGUAGE');
    this.interrupt('start-listening');
    const epoch=++this.#epoch;
    const recognition=this.recognitionFactory();
    if(!recognition||typeof recognition.start!=='function')
      throw new Error('VOICE_INPUT_UNSUPPORTED');
    this.#recognition=recognition;
    recognition.lang=lang;
    recognition.interimResults=true;
    recognition.maxAlternatives=1;
    recognition.onresult=event=>{
      if(epoch!==this.#epoch||this.#recognition!==recognition
        ||!this.#consent.voiceInputAllowed)return;
      // Browser transcript is provisional until the user checks the text and
      // explicitly submits the chat form. Never auto-send recognized speech.
      const parts=[];
      let isFinal=false;
      for(const item of Array.from(event.results??[])){
        const text=item?.[0]?.transcript;
        if(typeof text==='string')parts.push(text);
        if(item?.isFinal)isFinal=true;
      }
      const transcript=parts.join(' ').trim().slice(0,500);
      if(transcript)this.onTranscript({text:transcript,isFinal});
    };
    recognition.onerror=()=>{
      if(epoch!==this.#epoch)return;
      this.#recognition=null;this.#set('error');
      this.onError('VOICE_RECOGNITION_FAILED');
    };
    recognition.onend=()=>{
      if(epoch!==this.#epoch)return;
      this.#recognition=null;
      if(this.#state==='listening')this.#set('idle');
    };
    try{recognition.start();}
    catch{
      this.#recognition=null;this.#set('error');
      throw new Error('VOICE_RECOGNITION_START_FAILED');
    }
    this.#set('listening');
    return this.snapshot();
  }
  speak(text,{lang='zh-CN',rate=1}={}){
    if(!this.#consent.voiceOutputAllowed)throw new Error('VOICE_OUTPUT_NOT_ALLOWED');
    if(!this.synthesis||typeof this.synthesis.speak!=='function'
      ||typeof this.utteranceFactory!=='function')
      throw new Error('VOICE_OUTPUT_UNSUPPORTED');
    if(typeof text!=='string'||!text.trim()||text.length>1200)
      throw new Error('INVALID_VOICE_TEXT');
    if(!['zh-CN','en-US'].includes(lang)||typeof rate!=='number'||rate<0.6||rate>1.3)
      throw new Error('INVALID_VOICE_PRESENTATION');
    this.interrupt('start-speaking');
    const epoch=++this.#epoch;
    // Chunk long text for browser implementations with small utterance caps.
    // No cross-chunk buffering on the server and no background speech.
    const chunks=text.trim().match(/[\s\S]{1,180}/g)??[];
    let index=0;
    const next=()=>{
      if(epoch!==this.#epoch||!this.#consent.voiceOutputAllowed)return;
      if(index>=chunks.length){this.#set('idle');return;}
      const utterance=this.utteranceFactory(chunks[index++]);
      if(!utterance)throw new Error('VOICE_OUTPUT_UNSUPPORTED');
      utterance.lang=lang;utterance.rate=rate;
      utterance.onend=()=>{if(epoch===this.#epoch)next();};
      utterance.onerror=()=>{
        if(epoch!==this.#epoch)return;
        this.#set('error');this.onError('VOICE_SYNTHESIS_FAILED');
      };
      this.synthesis.speak(utterance);
    };
    this.#set('speaking');
    try{next();}
    catch{this.interrupt('speech-start-failed');throw new Error('VOICE_SYNTHESIS_FAILED');}
    return this.snapshot();
  }
}
globalThis.AlexVoiceBridge=AlexVoiceBridge;
