import { createHash } from 'node:crypto';
import { configurationSchema } from './schema-bridge.js';
const own=(value,key)=>value && typeof value==='object' && Object.hasOwn(value,key)?value[key]:undefined;
export const profileRevision=entry=>parseInt(createHash('sha256').update(JSON.stringify([entry.fiber?.uid,entry.options.config??{},entry.fiber?.runtime?.Config?.toJSON()])).digest('hex').slice(0,13),16);

// Structural projection mirrors DSH's schema redaction: every union branch is conservative.
function redact(node,value,path,secrets) {
  if(node?.meta?.role==='secret'){secrets.push({path,set:value!==undefined||node.meta.default!==undefined});return undefined;}
  if(value===undefined&&node?.meta?.default!==undefined)value=structuredClone(node.meta.default);
  if(node?.type==='object'){
    const result={};
    // Other union branches may own these keys. Preserve them until all branches redact their secrets.
    if(value&&typeof value==='object'&&!Array.isArray(value))for(const[key,item]of Object.entries(value)){
      if(!Object.hasOwn(node.dict??{},key))Object.defineProperty(result,key,{value:item,enumerable:true,writable:true,configurable:true});
    }
    for(const[key,child]of Object.entries(node.dict??{})){
      const next=redact(child,own(value,key),[...path,key],secrets);if(next!==undefined)Object.defineProperty(result,key,{value:next,enumerable:true,writable:true,configurable:true});
    }return result;
  }
  if(node?.type==='dict' && value && typeof value==='object' && !Array.isArray(value))return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,redact(node.inner,item,[...path,key],secrets)]).filter(([,item])=>item!==undefined));
  if(node?.type==='array'&&Array.isArray(value))return value.map((item,index)=>redact(node.inner,item,[...path,String(index)],secrets));
  if(['union','intersect'].includes(node?.type))return(node.list??[]).reduce((current,child)=>redact(child,current,path,secrets),value);
  if(node?.type==='transform')return redact(node.inner,value,path,secrets);
  return value;
}
export function profileConfiguration(entry){
  const schema=entry.fiber?.runtime?.Config;if(!schema?.toJSON)return;
  const secrets=[];
  const value=redact(schema,entry.options.config??{},[],secrets);
  // A later union branch must never reintroduce a path classified secret by another branch.
  for(const secret of secrets){let target=value;for(const key of secret.path.slice(0,-1))target=own(target,key);if(target&&typeof target==='object')delete target[secret.path.at(-1)];}
  const positions=new Map();for(const item of secrets){const key=JSON.stringify(item.path);positions.set(key,{...item,set:item.set||positions.get(key)?.set===true});}
  return {ns:'profile:'+entry.options.id,revision:profileRevision(entry),autoGenerate:true,mode:'reload',schema:configurationSchema(schema.toJSON()),value,
    secrets:[...positions.values()]};
}
const at=(value,path)=>path.reduce((node,key)=>own(node,key),value);
function apply(root,op,inherited){
  const copy=structuredClone(root);let target=copy;
  for(const key of op.path.slice(0,-1)){
    if(!target[key]||typeof target[key]!=='object')target[key]={};target=target[key];
  }
  const key=op.path.at(-1),base=at(inherited,op.path);
  if(op.op==='set'||base!==undefined)Object.defineProperty(target,key,{value:op.op==='set'?op.value:base,enumerable:true,writable:true,configurable:true});
  else if(Array.isArray(target)){if(!/^(0|[1-9][0-9]*)$/.test(key))throw Error('invalid array index');target.splice(Number(key),1);}
  else delete target[key];return copy;
}
export async function writeProfileConfiguration(editor,entry,revision,ops){
  try{
    await editor.edit(entry,(current,inherited)=>{
      if(profileRevision(entry)!==revision)throw Object.assign(Error('configuration changed'),{code:'SETTINGS_CONFLICT'});
      return ops.reduce((result,op)=>apply(result,op,inherited),current);
    });
    const current=editor.entries().find(item=>item.options.id===entry.options.id);
    const view=current&&profileConfiguration(current);
    return view?{saved:true,...view}:{saved:false,error:'unconfirmed'};
  }catch(error){return {saved:false,error:error?.code==='SETTINGS_CONFLICT'?'conflict':'rejected'};}
}
