// Browser / Node compatible simulation-only terminal turn state machine.
// It models UI consent and turn lifecycle, NOT recording or real ASR/TTS.
const STATES=['idle','listening','thinking','speaking','error'];
const TRANSITIONS=Object.freeze({
  idle:['listening','thinking','speaking','error'],
  listening:['idle','thinking','error'],
  thinking:['idle','speaking','error'],
  speaking:['idle','listening','thinking','error'],
  error:['idle','listening','thinking']
});
class AlexTerminalRuntime {
  #state='idle';
  #revision=0;
  #history=[];
  constructor({clock=()=>Date.now()}={}){
    if(typeof clock!=='function')throw new Error('INVALID_TERMINAL_CLOCK');
    this.clock=clock;
  }
  snapshot(){
    return Object.freeze({state:this.#state,revision:this.#revision,
      recent:this.#history.map(row=>Object.freeze({...row}))});
  }
  transition(next,{reason='user'}={}){
    if(!STATES.includes(next))throw new Error('INVALID_TERMINAL_STATE');
    if(typeof reason!=='string'||reason.length>60)throw new Error('INVALID_TERMINAL_REASON');
    if(this.#state===next)return this.snapshot();
    if(!TRANSITIONS[this.#state].includes(next))throw new Error('INVALID_TERMINAL_TRANSITION');
    this.#revision++;
    this.#state=next;
    this.#history.push({state:next,revision:this.#revision,reason,at:this.clock()});
    if(this.#history.length>20)this.#history.shift();
    return this.snapshot();
  }
  current(revision){return Number.isSafeInteger(revision)&&revision===this.#revision;}
  interrupt(reason='interrupted'){
    if(typeof reason!=='string'||reason.length>60)throw new Error('INVALID_TERMINAL_REASON');
    // Even when already idle, a new revision invalidates delayed browser
    // speech callbacks from the previously interrupted session.
    this.#revision++;
    this.#state='idle';
    this.#history.push({state:'idle',revision:this.#revision,reason,at:this.clock()});
    if(this.#history.length>20)this.#history.shift();
    return this.snapshot();
  }
}
globalThis.AlexTerminalRuntime=AlexTerminalRuntime;
