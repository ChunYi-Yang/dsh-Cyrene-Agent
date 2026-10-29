import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync } from 'node:fs';

/** Dedicated DSH sessions, scoped down to publishing their current room turn. */
export function createRoomHost(ctx,root,getRooms,team) {
  const installed=new WeakSet();let cached,cacheTime=0;
  function install(agent) {
    const room=getRooms()?.rooms.find(r=>r.hostSessionId===agent.id);
    if(installed.has(agent)||!room)return;
    if(room.kind==='workstation'&&room.members[0]==='cyrene') {
      const persona=['soul.md','work_identity.md'].map(name=>readFileSync(fileURLToPath(new URL('../prompts/'+name,import.meta.url)),'utf8')).join('\n\n');
      ctx.effect(()=>agent.ctx.systemPrompt.section({name:'CYRENE_WORKSTATION_PERSONA',order:100,interpolate:false,text:()=>persona+'\n\n只使用本房间明确提供的资料与记录。人格不授予额外工具、跨房间访问或文件写入权限。'}));
    }
    ctx.effect(()=>agent.ctx.tools.restrict({allow:['room_publish']}));installed.add(agent);
  }
  ctx.on('agent/created',({agent})=>install(agent));
  return {
    async catalog() {
      if(cached&&Date.now()-cacheTime<20000)return cached;
      const value=await ctx.sessionController.modelCatalog();
      cached={groups:value.groups.map(g=>({id:g.id,name:g.name,models:g.models.map(m=>({id:m.id,name:m.name}))})),default:value.default};cacheTime=Date.now();return cached;
    },
    async ensure(room) {
      if((room.hostId??'cyrene')!=='cyrene')return room.hostSessionId;
      const stage=value=>{room.hostStage=value;getRooms().persist();};stage('creating');
      const cwd=join(root,'.local/rooms',room.id,'host');mkdirSync(cwd,{recursive:true});
      const result=ctx.agents.get(room.hostSessionId)||room.hostInitialized?{sessionId:room.hostSessionId}:await ctx.sessionController.create({sessionId:room.hostSessionId,cwd});
      stage('scoping');
      // Do not silently move the room to a reusable foreign session.
      if(result.sessionId!==room.hostSessionId)throw Error('主持会话身份不符');
      room.hostInitialized=true;stage('selecting-model');await ctx.sessionController.selectModel({sessionId:result.sessionId,...room.hostModel});
      const agent=ctx.agents.get(result.sessionId);if(!agent)throw Error('主持会话尚未就绪');install(agent);
      stage('ready');return result.sessionId;
    },
    async prompt(room,request) {
      if((room.hostId??'cyrene')!=='cyrene') {
        const task=await team.submit({memberId:room.hostId,requestId:`host:${room.id}:${request.id}`,prompt:request.prompt,writeMode:false},`room-host:${room.id}`,{roomId:room.id,sealed:true,seedPath:join(root,'.local/rooms',room.id,`host-input-${request.id}`)});
        room.hostTaskId=task.id;room.hostStage='external-running';getRooms().persist();
        if(getRooms().closed||room.hostPending?.id!==request.id||room.phase!=='hosting') {
          await team.cancel(task.id,undefined,{roomId:room.id});throw Error('主持请求已停止');
        }
        for(;;) {
          const current=team.tasks.find(t=>t.id===task.id);
          if(!getRooms()||getRooms().closed||room.hostPending?.id!==request.id||room.phase!=='hosting')throw Error('主持请求已停止');
          if(current?.status==='completed') {
            let raw=current.output.trim();if(/^```(?:json)?\s/i.test(raw)&&raw.endsWith('```'))raw=raw.replace(/^```(?:json)?\s*/i,'').slice(0,-3).trim();
            const value=JSON.parse(raw);
            if(!value||value.roomId!==room.id||value.requestId!==request.id||value.type!==request.type)throw Error('主持结果身份不符');
            getRooms().publish(value,room.hostSessionId);return;
          }
          if(!current||['failed','cancelled','blocked','unknown'].includes(current.status))throw Error('外部主持未完成');
          await new Promise(resolve=>setTimeout(resolve,100));
        }
      }
      room.hostStage='admitting';getRooms().persist();
      await ctx.sessionController.prompt({sessionId:room.hostSessionId,requestId:request.id,mode:'queue',content:[{type:'text',text:request.prompt}]},AbortSignal.timeout(30000));
      room.hostStage='admitted';getRooms().persist();
    },
    async cancel(room) {
      if((room.hostId??'cyrene')!=='cyrene') {if(room.hostTaskId)await team.cancel(room.hostTaskId,undefined,{roomId:room.id});return;}
      if(room.hostSessionId)await ctx.sessionController.cancel({sessionId:room.hostSessionId});
    },
  };
}
