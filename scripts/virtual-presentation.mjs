// Simulation-only virtual terminal presenter.
// "audio.output" produces a console caption; it NEVER plays sound, sends
// voice to cloud services, or talks to speakers/physical actuators.
const EXPRESSIONS=new Set(['neutral','happy','sleepy']);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class VirtualPresentationRuntime {
  constructor({write=line=>console.log(line),delay=wait}={}){
    if(typeof write!=='function'||typeof delay!=='function')
      throw new Error('INVALID_VIRTUAL_PRESENTATION_CONFIG');
    this.write=write;this.delay=delay;
    this.face='neutral';this.caption='';
    this.lastEvent=null;
  }
  snapshot(){return {face:this.face,caption:this.caption,
    lastEvent:this.lastEvent?{...this.lastEvent}:null,
    simulatedOnly:true,physicalAudio:false};}
  async render(job,{isCancelled=()=>false}={}){
    if(!job||!['audio.output','display.face'].includes(job.capability)
      ||typeof isCancelled!=='function')
      throw new Error('INVALID_VIRTUAL_PRESENTATION_JOB');
    const params=job.params;
    if(!params||typeof params!=='object'||Array.isArray(params))
      throw new Error('INVALID_VIRTUAL_PRESENTATION_JOB');
    let observed,caption,face;
    if(job.capability==='display.face'){
      if(!EXPRESSIONS.has(params.expression)
        ||Object.keys(params).length!==1)
        throw new Error('INVALID_VIRTUAL_PRESENTATION_FACE');
      face=params.expression;
      observed={expression:face};
    }else{
      if(typeof params.text!=='string'||!params.text.trim()
        ||params.text.length>200||Object.keys(params).length!==1)
        throw new Error('INVALID_VIRTUAL_PRESENTATION_TEXT');
      caption=params.text;
      observed={characters:caption.length};
    }
    if(isCancelled())return null;
    await this.delay(40);
    if(isCancelled())return null;
    if(face)this.face=face;
    if(caption)this.caption=caption;
    this.lastEvent={kind:job.capability,at:new Date().toISOString()};
    this.write(job.capability==='display.face'
      ?'[virtual-display] face='+face
      :'[virtual-caption] '+caption);
    return observed;
  }
}
