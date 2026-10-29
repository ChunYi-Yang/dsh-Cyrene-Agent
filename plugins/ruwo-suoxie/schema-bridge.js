/** Convert Schemastery's reference envelope into a bounded declarative tree. Never forward schema defaults. */
export function configurationSchema(input) {
  const refs=input?.refs??{};let count=0;
  const visit=(reference,ancestors=new Set(),depth=0)=>{
    if(depth>24||++count>4000)return {type:'unsupported'};
    const node=typeof reference==='number'||typeof reference==='string'?refs[reference]:reference;
    if(!node||typeof node!=='object'||ancestors.has(node))return {type:'unsupported'};
    const stack=new Set(ancestors);stack.add(node);
    const meta={};for(const key of ['description','role','disabled','required','min','max','step']){
      const value=node.meta?.[key];if(['string','number','boolean'].includes(typeof value))meta[key]=value;
    }
    if(meta.role==='secret')return {type:'string',meta:{role:'secret'}};
    const result={type:typeof node.type==='string'?node.type:'unsupported',meta};
    if(node.dict)result.dict=Object.fromEntries(Object.entries(node.dict).filter(([key])=>!['__proto__','constructor','prototype'].includes(key)).map(([key,value])=>[key,visit(value,stack,depth+1)]));
    if(node.inner!==undefined)result.inner=visit(node.inner,stack,depth+1);
    if(Array.isArray(node.list))result.list=node.list.map(value=>visit(value,stack,depth+1));
    if(node.type==='const'&&['string','number','boolean'].includes(typeof node.value))result.value=node.value;
    return result;
  };return visit(input?.uid!==undefined&&input?.refs?input.uid:input);
}
