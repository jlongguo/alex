// OpenAI-compatible realtime *transcription-only* adapter.
// Expected wire protocol: session.update(type=transcription), 24kHz mono
// PCM16 input_audio_buffer.append, explicit commit and transcript deltas.
// No assistant audio generation, automatic chat, model tools or microphone
// activation. Input data is not stored to disk by this adapter.
import {connectSecureJsonSocket,validateRealtimeUrl} from './realtime-wss.mjs';

const MAX_PCM_BYTES=720_000; // 15s * 24kHz * 2 bytes
const MAX_FRAME_BYTES=9600; // <= 200 ms at 24k mono
const MAX_TRANSCRIPT=500;
const fail=code=>new Error(code);

export class RealtimeTranscriptionProvider {
  kind='realtime-transcription';
  constructor({url='wss://api.openai.com/v1/realtime?intent=transcription',
    apiKey,model='gpt-live-transcribe',
    connect=connectSecureJsonSocket,now=()=>Date.now(),
    readyTimeoutMs=8000,finalTimeoutMs=30_000}={}){
    validateRealtimeUrl(url);
    if(typeof apiKey!=='string'||!apiKey||apiKey.length>4096
      ||!/^[-\w.]{1,100}$/.test(model)||typeof connect!=='function'
      ||readyTimeoutMs<1000||readyTimeoutMs>30_000
      ||finalTimeoutMs<3000||finalTimeoutMs>60_000)
      throw fail('INVALID_REALTIME_CONFIG');
    this.url=url;this.apiKey=apiKey;this.model=model;this.connect=connect;
    this.now=now;this.readyTimeoutMs=readyTimeoutMs;this.finalTimeoutMs=finalTimeoutMs;
  }
  async open({signal,onPartial=()=>{}}={}){
    if(signal?.aborted)throw fail('AUDIO_REQUEST_CANCELLED');
    if(typeof onPartial!=='function')throw fail('INVALID_REALTIME_CALLBACK');
    let ws;
    try{ws=await this.connect({url:this.url,apiKey:this.apiKey,
      timeoutMs:this.readyTimeoutMs});}
    catch{
      if(signal?.aborted)throw fail('AUDIO_REQUEST_CANCELLED');
      throw fail('AUDIO_REALTIME_CONNECT_FAILED');
    }
    if(signal?.aborted){ws.close();throw fail('AUDIO_REQUEST_CANCELLED');}
    const clock=this.now;
    let stage='starting',failure=null,text='',frames=0,bytesSent=0;
    let firstDeltaMs=null,commitAt=null;
    let readyResolve,readyReject,commitResolve,commitReject;
    const ready=new Promise((resolve,reject)=>{
      readyResolve=resolve;readyReject=reject;
    });
    // Promise rejection is consumed if connection is cancelled before ready.
    void ready.catch(()=>{});
    let committed=null;
    const close=()=>{
      if(stage==='closed')return;
      stage='closed';ws.close();
    };
    const rejectAll=code=>{
      if(failure)return;
      failure=code;
      if(stage==='starting')readyReject(fail(code));
      if(commitReject)commitReject(fail(code));
      close();
    };
    const aborted=()=>rejectAll('AUDIO_REQUEST_CANCELLED');
    signal?.addEventListener('abort',aborted,{once:true});
    const onClosed=()=>rejectAll(signal?.aborted?'AUDIO_REQUEST_CANCELLED':
      'AUDIO_REALTIME_CONNECTION_CLOSED');
    ws.on('closed',onClosed);
    ws.on('json',event=>{
      if(stage==='closed'||!event||typeof event.type!=='string')return;
      if(event.type==='error'
        ||event.type==='conversation.item.input_audio_transcription.failed'){
        rejectAll('AUDIO_REALTIME_UPSTREAM_ERROR');return;
      }
      if(event.type==='session.updated'){
        if(stage==='starting'){stage='ready';readyResolve();}
        return;
      }
      if(event.type==='conversation.item.input_audio_transcription.delta'){
        if(stage!=='ready'&&stage!=='committing')return;
        if(typeof event.delta!=='string')return;
        if(text.length+event.delta.length>MAX_TRANSCRIPT){
          rejectAll('AUDIO_REALTIME_TRANSCRIPT_TOO_LARGE');return;
        }
        if(firstDeltaMs===null)firstDeltaMs=clock();
        text+=event.delta;
        try{onPartial({text,final:false});}catch{}
        return;
      }
      if(event.type==='conversation.item.input_audio_transcription.completed'){
        if(stage!=='committing')return;
        const output=typeof event.transcript==='string'?event.transcript:text;
        if(!output.trim()||output.length>MAX_TRANSCRIPT){
          rejectAll('AUDIO_REALTIME_INVALID_TRANSCRIPT');return;
        }
        stage='complete';
        const result={
          text:output.trim(),source:'realtime-cloud-asr',validated:false,
          requiresManualSubmit:true,
          metrics:{
            pcmBytes:bytesSent,frames,
            firstPartialMs:firstDeltaMs===null?null:
              Math.max(0,firstDeltaMs-(committed?.startedAt??firstDeltaMs)),
            finalizeMs:Math.max(0,clock()-(commitAt??clock()))
          }
        };
        if(commitResolve)commitResolve(result);
        try{onPartial({text:output.trim(),final:true});}catch{}
        close();
      }
    });
    const timer=setTimeout(()=>rejectAll('AUDIO_REALTIME_READY_TIMEOUT'),
      this.readyTimeoutMs);
    timer.unref?.();
    try{
      ws.send({
        type:'session.update',
        session:{
          type:'transcription',
          audio:{input:{
            format:{type:'audio/pcm',rate:24000},
            transcription:{model:this.model},
            turn_detection:null
          }}
        }
      });
      await ready;
    }catch{
      rejectAll(failure??'AUDIO_REALTIME_SETUP_FAILED');
      throw fail(failure??'AUDIO_REALTIME_SETUP_FAILED');
    }finally{clearTimeout(timer);}
    const openedAt=clock();
    return {
      get state(){return stage;},
      append:async pcm=>{
        if(signal?.aborted)throw fail('AUDIO_REQUEST_CANCELLED');
        if(stage!=='ready')throw fail('AUDIO_REALTIME_NOT_READY');
        if(!(pcm instanceof Uint8Array)||pcm.byteLength<2
          ||pcm.byteLength>MAX_FRAME_BYTES||pcm.byteLength%2
          ||bytesSent+pcm.byteLength>MAX_PCM_BYTES)
          throw fail('INVALID_REALTIME_PCM_BYTES');
        // This is a synchronous bounded send. Socket writableLength is
        // guarded by SecureJsonSocket. Never queue raw audio without limit.
        try{
          ws.send({type:'input_audio_buffer.append',
            audio:Buffer.from(pcm).toString('base64')});
        }catch{
          rejectAll('AUDIO_REALTIME_BACKPRESSURE');
          throw fail('AUDIO_REALTIME_BACKPRESSURE');
        }
        bytesSent+=pcm.byteLength;frames++;
        return {frames,pcmBytes:bytesSent};
      },
      commit:async()=>{
        if(signal?.aborted)throw fail('AUDIO_REQUEST_CANCELLED');
        if(stage!=='ready')throw fail('AUDIO_REALTIME_NOT_READY');
        if(bytesSent<4800)throw fail('INVALID_REALTIME_AUDIO_TOO_SHORT');
        stage='committing';commitAt=clock();
        committed={startedAt:openedAt};
        const outcome=new Promise((resolve,reject)=>{
          commitResolve=resolve;commitReject=reject;
        });
        const timeout=setTimeout(()=>rejectAll('AUDIO_REALTIME_FINAL_TIMEOUT'),
          this.finalTimeoutMs);
        timeout.unref?.();
        try{
          ws.send({type:'input_audio_buffer.commit'});
          return await outcome;
        }catch{
          rejectAll(failure??'AUDIO_REALTIME_COMMIT_FAILED');
          throw fail(failure??'AUDIO_REALTIME_COMMIT_FAILED');
        }finally{clearTimeout(timeout);}
      },
      cancel:()=>{
        rejectAll('AUDIO_REQUEST_CANCELLED');
      },
      close:()=>{
        signal?.removeEventListener('abort',aborted);
        close();
      },
      snapshot:()=>({
        state:stage,pcmBytes:bytesSent,frames,
        elapsedMs:Math.max(0,clock()-openedAt),
        partialAvailable:!!text, // no text exposed in diagnostics
        format:'pcm16-mono-24khz'
      })
    };
  }
}
