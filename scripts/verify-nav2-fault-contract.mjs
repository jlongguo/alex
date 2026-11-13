// R57 对内置伪 Nav2 故障报告进行只读校验；本工具绝不声明 Gazebo 运行成功。
import {readFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyNav2FaultContract} from './nav2-fault-contract.mjs';

async function main(args){
 let report=null,runId=null;
 for(let i=0;i<args.length;i+=2){
  if(!args[i+1])throw Error('NAV2_FAULT_INVALID_ARGS');
  if(args[i]==='--report'&&!report)report=args[i+1];
  else if(args[i]==='--run-id'&&runId===null)runId=args[i+1];
  else throw Error('NAV2_FAULT_INVALID_ARGS');
 }
 if(!report||!runId)throw Error('NAV2_FAULT_INVALID_ARGS');
 const metadata=await stat(report);
 if(!metadata.isFile()||metadata.size<2||metadata.size>32*1024)
  throw Error('NAV2_FAULT_INVALID_FILE');
 const data=JSON.parse(await readFile(report,'utf8'));
 verifyNav2FaultContract(data,runId);
 console.log('Nav2 injected fault contract validated; Gazebo runtime acceptance remains required');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{await main(process.argv.slice(2));}
 catch(error){
  const code=typeof error?.message==='string'&&/^NAV2_FAULT_[A-Z_]+$/.test(error.message)
   ?error.message:'NAV2_FAULT_INVALID_FILE';
  console.error(code);process.exitCode=1;
 }
}
