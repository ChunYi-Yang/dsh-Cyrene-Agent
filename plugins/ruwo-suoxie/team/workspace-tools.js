import {lstatSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve,relative,isAbsolute,join,dirname} from 'node:path';
import {noLinks} from './materials.js';
const definition=(name,description,properties)=>({type:'function',name,description,inputSchema:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}});
const pathSchema={type:'string',description:'工作副本内的相对路径；禁止绝对路径、上级路径和链接'};
const present=path=>{try{lstatSync(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
export function workspaceTools(task) {
  if(task.roomSealed)return [];
  return [definition('cyrene_list_files','列出工作副本内文件，根目录传入 .',{path:pathSchema}),definition('cyrene_read_file','读取工作副本内 UTF-8 文本，超过 64KB 显式截断',{path:pathSchema}),
    ...(task.writeMode?[definition('cyrene_write_file','在已批准的工作副本中生成或修改文本，不会写回源文件',{path:pathSchema,content:{type:'string',description:'完整文本，最多 1MB'}})]:[])];
}
export function workspaceTool(task,name,args) {
  if(task.roomSealed||!workspaceTools(task).some(t=>t.name===name))throw Error('该任务未获准使用此工具或写入');
  if(!args||typeof args.path!=='string'||args.path.length>512||isAbsolute(args.path)||args.path.includes(':')||args.path.split(/[\\/]/).some(p=>p==='..'))throw Error('文件路径无效');
  const root=noLinks(task.workspace),target=resolve(root,args.path),rel=relative(root,target);
  if(isAbsolute(rel)||rel==='..'||rel.startsWith('../')||rel.startsWith('..\\'))throw Error('文件路径越界');
  if(rel.split(/[\\/]/).some(p=>p.startsWith('.')))throw Error('不能访问隐藏路径');
  if(rel.split(/[\\/]/).some(p=>/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(p)))throw Error('文件路径无效');
  let ancestor=target;while(!present(ancestor)&&ancestor!==root)ancestor=dirname(ancestor);noLinks(ancestor);
  if(name==='cyrene_list_files') {
    if(!lstatSync(target).isDirectory())throw Error('路径不是目录');
    return readdirSync(target,{withFileTypes:true}).filter(e=>!e.name.startsWith('.')&&!e.isSymbolicLink()).slice(0,256).map(e=>`${e.isDirectory()?'目录':'文件'} ${e.name}`).join('\n')||'空目录';
  }
  if(name==='cyrene_read_file') {
    const stat=lstatSync(target);if(!stat.isFile()||stat.size>5*1024*1024)throw Error('不支持读取此材料');
    let value;try{value=new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(target));}catch{throw Error('此文件不是可读取的 UTF-8 文本');}
    if(value.includes('\0'))throw Error('此文件不是可读取的文本');return value.length>65536?`${value.slice(0,65536)}\n（文件内容已截断）`:value;
  }
  if(typeof args.content!=='string'||Buffer.byteLength(args.content)>1048576)throw Error('写入文本超出限额');
  if(present(target)&&!lstatSync(target).isFile())throw Error('写入目标不是普通文件');
  mkdirSync(dirname(target),{recursive:true});noLinks(dirname(target));writeFileSync(target,args.content,{mode:0o600,flush:true});return'已写入工作副本';
}
