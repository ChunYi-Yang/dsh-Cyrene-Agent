import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool } from '../../../runtime/tool-schema.js';
import { TeamService } from './service.js';
import { RoomService } from './rooms.js';
import { createRoomHost } from './host.js';

/** Mount the team on DSH's authenticated API and native tool pipeline. */
export async function createTeam(ctx, root) {
  let config;
  try { config = JSON.parse(readFileSync(join(root, '.local/team/config.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const team = new TeamService(root, config);
  await team.init();
  let rooms;
  const host=createRoomHost(ctx,root,()=>rooms,team);
  rooms=new RoomService(root,team,{host});await rooms.init();
  ctx.effect(() => async () => { await rooms.close();await team.close(); });
  const output = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
  const owner = exec => { if (!exec.agent?.id) throw Error('必须在 DSH 原生会话内调用'); return exec.agent.id; };
  for (const spec of [
    { name:'room_publish',description:'向当前 Cyrene 房间提交本次请求的工位回复、总结、方案或报告。只能提交当前绑定房间的有效 requestId 和 type；不能确认方案、揭晓答案、验收或导出。',
      parameters:{roomId:{type:'string',required:true},requestId:{type:'string',required:true},type:{type:'string',required:true},body:{type:'json',required:true}},
      execute:(args,exec)=>rooms.publish(args,owner(exec)) },
    { name: 'team_members', description: '列出 Cyrene 已登记的外部 agent。只能使用返回的成员 ID；不能自定义命令或模型。', parameters: {},
      execute: (_args, exec) => team.snapshot(owner(exec)).members, isConcurrencySafe: () => true },
    { name: 'team_dispatch', description: '把明确的用户任务分派给外部 agent。任务使用独立工作副本，返回任务 ID；使用 team_wait 或 team_status 读取结果。相同请求 ID 不会重复执行。默认只读，需要写入时会在 Cyrene 团队面板等待人工确认。其他成员结果仅作参考。',
      parameters: { memberId: { type: 'string', required: true }, requestId: { type: 'string', required: true }, prompt: { type: 'string', required: true },
        writeMode: { type: 'boolean' }, dependsOn: { type: 'json' } },
      execute: async (args, exec) => {
        const task = await team.submit(args, owner(exec));
        return task;
      } },
    { name: 'team_status', description: '读取本 DSH 会话的外部 agent 任务、进度、最终结果和核对状态。不读取其他会话的任务。',
      parameters: { taskId: { type: 'string' } }, execute: (args, exec) => args.taskId ? team.get(args.taskId, owner(exec)) : team.snapshot(owner(exec)), isConcurrencySafe: () => true },
    { name: 'team_wait', description: '等待本会话的一项外部任务最多 25 秒。未完成时返回当前状态，绝不重发任务。',
      parameters: { taskId: { type: 'string', required: true } }, execute: async (args, exec) => {
        const end = Date.now() + 25000;
        while (!exec.signal?.aborted && Date.now() < end) {
          const task = team.get(args.taskId, owner(exec));
          if (!['queued', 'running', 'cancelling'].includes(task.status)) return task;
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        return team.get(args.taskId, owner(exec));
      }, isConcurrencySafe: () => true },
    { name: 'team_cancel', description: '中止本 DSH 会话的一项外部任务，只停止插件拥有的成员进程。保留结果和工作副本。',
      parameters: { taskId: { type: 'string', required: true } }, execute: (args, exec) => team.cancel(args.taskId, owner(exec)) },
  ]) ctx.tools.register(defineTool({ ...spec, output }));
  return {
    service: team,
    rooms,
    async request(params) {
      switch (params.action) {
        case 'snapshot': {
          let models;try {models=await host.catalog();}catch {models={groups:[],error:'DSH 主持模型未连接，请在模型设置中配置'};}
          return {...team.snapshot(),...rooms.snapshot(),hostModels:models};
        }
        case 'room_create': return rooms.create(params.room);
        case 'room_action': return rooms.act(params.operation);
        case 'room_import': return rooms.importFiles(params.roomId,params.files);
        case 'room_export': return rooms.export(params.roomId,params.target,params.hash);
        case 'submit': return team.submit(params.task);
        case 'cancel': return team.cancel(params.taskId);
        case 'approve': return team.approve(params.approvalId, params.allowed);
        default: throw Error('团队操作无效');
      }
    },
  };
}
