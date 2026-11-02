import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

/** Local-only JSON snapshots. Atomic rename + sequential writes avoid torn files. */
export class JsonStateStore {
  #pending=Promise.resolve();
  constructor(file){this.file=resolve(file);}
  async load(){
    let raw;
    try{raw=await readFile(this.file,'utf8');}
    catch(e){if(e.code==='ENOENT')return null;throw e;}
    // Corrupt data is fatal instead of silently losing family history.
    const value=JSON.parse(raw);
    if(!value || typeof value!=='object')throw new Error('INVALID_STATE_FILE');
    return value;
  }
  save(snapshot){
    const data=JSON.stringify(snapshot);
    this.#pending=this.#pending.catch(()=>{}).then(async()=>{
      await mkdir(dirname(this.file),{recursive:true,mode:0o700});
      const temp=`${this.file}.${randomUUID()}.tmp`;
      try{await writeFile(temp,data,{encoding:'utf8',mode:0o600,flag:'wx'});await rename(temp,this.file);}
      finally{await unlink(temp).catch(()=>{});}
    });
    return this.#pending;
  }
  async flush(){await this.#pending;}
}
