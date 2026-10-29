import {createInterface} from 'node:readline';
import {workspaceTools,workspaceTool} from './workspace-tools.js';
const task={workspace:process.argv[2],writeMode:process.argv[3]==='write'};
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
createInterface({input:process.stdin}).on('line',line=>{
  let request;try{if(line.length>2*1024*1024)throw Error();request=JSON.parse(line);}catch{return;}
  if(request.id===undefined)return;const reply=result=>send({jsonrpc:'2.0',id:request.id,result});
  if(request.method==='initialize')reply({protocolVersion:request.params?.protocolVersion??'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'cyrene-workspace',version:'1.0.0'}});
  else if(request.method==='ping')reply({});
  else if(request.method==='tools/list')reply({tools:workspaceTools(task).map(({type,...tool})=>tool)});
  else if(request.method==='tools/call'){
    try{reply({content:[{type:'text',text:workspaceTool(task,request.params?.name,request.params?.arguments)}]});}
    catch{reply({isError:true,content:[{type:'text',text:'文件操作被拒绝：只能访问当前工作副本中的普通文件，并需具备相应读写权限。'}]});}
  }else send({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'不支持此操作'}});
});
