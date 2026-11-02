import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

const MAX_ENTRIES = 200;
const scopes = new Set(['family','parent','child']);
export class FamilyMemory {
  constructor(file){this.file=resolve(file);this.entries=[];this.queue=Promise.resolve();}
  async load(){
    let raw;
    try{raw=await readFile(this.file,'utf8');}catch(e){if(e.code==='ENOENT')return;throw e;}
    const data=JSON.parse(raw);
    if(!Array.isArray(data) || data.length>MAX_ENTRIES || data.some(v=>!v || typeof v.id!=='string'||!scopes.has(v.scope)||typeof v.text!=='string'||v.text.length>1000||typeof v.createdAt!=='string')) throw new Error('INVALID_MEMORY_FILE');
    this.entries=data;
  }
  list(actor){return this.entries.filter(x=>actor==='parent'||x.scope==='family'||x.scope==='child').map(x=>({...x}));}
  async add(actor,scope,text){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    if(!scopes.has(scope)||typeof text!=='string'||text.trim().length<1||text.trim().length>1000)throw new Error('INVALID_MEMORY_ENTRY');
    if(this.entries.length>=MAX_ENTRIES)throw new Error('MEMORY_LIMIT_REACHED');
    const entry={id:randomUUID(),scope,text:text.trim(),createdAt:new Date().toISOString()};
    this.entries.push(entry);
    try{await this.save();}catch(err){this.entries=this.entries.filter(x=>x.id!==entry.id);throw err;}
    return {...entry};
  }
  async remove(actor,id){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    if(typeof id!=='string')throw new Error('INVALID_MEMORY_ID');
    const i=this.entries.findIndex(x=>x.id===id);
    if(i===-1)return false;
    const [deleted]=this.entries.splice(i,1);
    try{await this.save();}catch(err){this.entries.splice(i,0,deleted);throw err;}
    return true;
  }
  async save(){
    const data=JSON.stringify(this.entries);
    this.queue=this.queue.catch(()=>{}).then(async()=>{
      await mkdir(dirname(this.file),{recursive:true,mode:0o700});
      const tmp=`${this.file}.${randomUUID()}.tmp`;
      try{await writeFile(tmp,data,{encoding:'utf8',flag:'wx',mode:0o600});await rename(tmp,this.file);}finally{await unlink(tmp).catch(()=>{});}
    });
    await this.queue;
  }
}
