// R15 one logical PCM stream across at most four committed sentences.
// Wraps the existing single-sentence provider and retains R9 playback/ACK.
// At most current + one prefetched upstream source are open simultaneously.
const MAX_SEGMENTS=4,MAX_CHARS=1200,MAX_SENTENCE=500;
const safeText=x=>typeof x==='string'&&!!x.trim()&&x.length<=MAX_SENTENCE
  &&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(x);
const cancelError=()=>Error('AUDIO_REQUEST_CANCELLED');
async function raced(promise,signal){
 if(signal.aborted)throw cancelError();
 let listener;
 const aborted=new Promise((_,reject)=>{
  listener=()=>reject(cancelError());
  signal.addEventListener('abort',listener,{once:true});
 });
 try{return await Promise.race([promise,aborted]);}
 finally{signal.removeEventListener('abort',listener);}
}
export class SegmentedPcmSpeechProvider {
 kind='compatible-pcm-stream';
 constructor({provider}={}){
  if(typeof provider?.open!=='function')throw Error('INVALID_SEGMENTED_PROVIDER');
  this.provider=provider;
 }
 async open({text,segments,signal}={}){
  if(segments===undefined)return this.provider.open({text,signal});
  if(!Array.isArray(segments)||segments.length<1||segments.length>MAX_SEGMENTS
    ||segments.some(x=>!safeText(x))
    ||segments.reduce((n,x)=>n+x.length,0)>MAX_CHARS
    ||text!==segments[0])
   throw Error('INVALID_COMMITTED_SPEECH_SEGMENTS');
  if(segments.length===1)return this.provider.open({text,signal});
  if(signal?.aborted)throw cancelError();
  const controller=new AbortController(),sources=new Set();
  let closed=false,index=0,current=null,prefetched=null,preparedFor=-1;
  const stop=()=>controller.abort();
  signal?.addEventListener('abort',stop,{once:true});
  const cleanup=source=>{
   if(!source)return;
   sources.delete(source);
   try{void Promise.resolve(source.close()).catch(()=>{});}catch{}
  };
  const openOne=async i=>{
   if(closed||controller.signal.aborted)throw cancelError();
   const promise=Promise.resolve().then(()=>this.provider.open({
    text:segments[i],signal:controller.signal
   }));
   // If a provider returns a session after cancellation, dispose it.
   promise.then(source=>{
    if(closed||controller.signal.aborted)cleanup(source);
   },()=>{});
   const source=await raced(promise,controller.signal);
   if(closed||controller.signal.aborted){cleanup(source);throw cancelError();}
   if(!source||typeof source.read!=='function'
     ||typeof source.close!=='function'){
    cleanup(source);throw Error('INVALID_SEGMENTED_SOURCE');
   }
   sources.add(source);
   return source;
  };
  const prepare=i=>{
   if(i>=segments.length){prefetched=null;preparedFor=-1;return;}
   preparedFor=i;
   prefetched=openOne(i);
   void prefetched.catch(()=>{}); // handled when current sentence drains
  };
  try{
   current=await openOne(0);
   prepare(1);
  }catch(error){
   closed=true;controller.abort();
   signal?.removeEventListener('abort',stop);
   for(const source of [...sources])cleanup(source);
   throw error;
  }
  const close=async()=>{
   if(closed)return;
   closed=true;controller.abort();
   signal?.removeEventListener('abort',stop);
   for(const source of [...sources])cleanup(source);
   current=null;prefetched=null;
  };
  const read=async()=>{
   if(closed||controller.signal.aborted)throw cancelError();
   try{
    while(true){
     const block=await raced(Promise.resolve().then(()=>current.read()),
       controller.signal);
     if(closed||controller.signal.aborted)throw cancelError();
     if(!block||typeof block.done!=='boolean')
      throw Error('INVALID_SEGMENTED_PCM_FRAME');
     if(!block.done)return {...block,sentenceIndex:index,
      sentenceCount:segments.length};
     cleanup(current);current=null;
     index++;
     if(index===segments.length)return {done:true};
     if(preparedFor!==index||!prefetched)
      throw Error('SEGMENT_PREFETCH_MISSING');
     current=await raced(prefetched,controller.signal);
     if(closed||controller.signal.aborted)throw cancelError();
     prepare(index+1);
    }
   }catch(error){
    await close();throw error;
   }
  };
  return {format:'pcm16-mono-24khz',read,close,
   stats:()=>({sentenceIndex:index,sentenceCount:segments.length,closed,
    maxConcurrentSources:2})};
 }
}
