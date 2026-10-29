import { mkdirSync, lstatSync, readFileSync, writeFileSync, realpathSync, openSync, closeSync, constants } from 'node:fs';
import { join, basename, extname, resolve, parse } from 'node:path';
import { createHash } from 'node:crypto';
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export function noLinks(path) {
  const full=resolve(path);let current=parse(full).root;
  for(const part of full.slice(current.length).split(/[\\/]/).filter(Boolean)) { current=join(current,part); if(lstatSync(current).isSymbolicLink())throw Error('不能使用链接路径'); }
  return realpathSync(full);
}
export function importMaterial(directory, path, index) {
  const source=noLinks(path),stat=lstatSync(source),name=basename(source);
  if(!stat.isFile() || stat.size>5*1024*1024)throw Error('材料必须是小于 5MB 的普通文件');
  if(name.startsWith('.') || /\.(key|pem|pfx|env|log)$/i.test(name))throw Error('不接收配置、密钥或日志材料');
  const bytes=readFileSync(source);let text;
  if(['.txt','.md','.csv','.json'].includes(extname(name).toLowerCase())) {
    try { text=new TextDecoder('utf-8',{fatal:true}).decode(bytes); if(text.includes('\0'))text=undefined; }catch{ /* Explicit unsupported below. */ }
  }
  const id=`S${index}`,file=`${id}${extname(name).replace(/[^a-zA-Z0-9.]/g,'')}`;
  mkdirSync(directory,{recursive:true});writeFileSync(join(directory,file),bytes,{flag:'wx',mode:0o600});
  return {id,name,file,size:bytes.length,hash:digest(bytes),status:text===undefined?'unsupported':'readable',...(text!==undefined?{text:text.slice(0,60000),truncated:text.length>60000}:{})};
}
export function materialContext(materials) {
  return materials.map(m=>m.status==='readable'?`来源 ${m.id}：${m.name}${m.truncated?'（已截断）':''}\n${m.text.split('\n').map((line,i)=>`[${m.id}:L${i+1}] ${line}`).join('\n')}`:`来源 ${m.id}：${m.name}（未能读取，不得声称已读或引用内容）`).join('\n\n').slice(0,100000);
}
export function exportNew(target,files) {
  const directory=noLinks(target);if(!lstatSync(directory).isDirectory())throw Error('输出位置必须是目录');
  for(const name of Object.keys(files)) {
    if(basename(name)!==name || name.startsWith('.'))throw Error('成果文件名无效');
    try{lstatSync(join(directory,name));throw Error('输出目录存在同名文件，请另选空文件夹');}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  // Exclusive creation also protects against a collision after the preflight check.
  for(const [name,content] of Object.entries(files)) {
    const fd=openSync(join(directory,name),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);
    try{writeFileSync(fd,content,{flush:true});}finally{closeSync(fd);}
  }
  return {files:Object.keys(files)};
}
