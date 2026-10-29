import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, cpSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { runMember } from './adapters.js';

const terminal = new Set(['completed', 'failed', 'cancelled', 'blocked', 'unknown']);
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bounded = (value, min, max, fallback) => value === undefined ? fallback : Number.isSafeInteger(value) && value >= min && value <= max ? value : (() => { throw Error('团队参数超出范围'); })();

/** Durable task ownership; restarts never replay a possibly submitted request. */
export class TeamService {
  constructor(root, config, { adapter = runMember } = {}) {
    this.root = resolve(root); this.directory = join(this.root, '.local/team');
    this.filename = join(this.directory, 'state.json');
    this.config = {
      maxParallel: bounded(config.maxParallel, 1, 8, 2), timeoutMs: bounded(config.timeoutMs, 1000, 86400000, 600000),
      maxOutputBytes: bounded(config.maxOutputBytes, 1024, 8388608, 1048576), members: config.members,
    };
    if (!Array.isArray(config.members) || config.members.length > 32) throw Error('成员配置无效');
    const ids = new Set();
    for (const member of config.members) {
      if (!member || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(member.id) || ids.has(member.id)
        || typeof member.name !== 'string' || !member.name || member.name.length > 100
        || !['codex', 'claude', 'acp'].includes(member.protocol) || !isAbsolute(member.command)
        || /\.(cmd|bat|ps1)$/i.test(member.command)
        || (member.args !== undefined && (!Array.isArray(member.args) || member.args.some(arg => typeof arg !== 'string')))
        || (member.model !== undefined && (typeof member.model !== 'string' || !member.model.trim()))
        || (member.connection !== undefined && (member.protocol !== 'codex' || !['native','chatgpt'].includes(member.connection)))
        || (member.settingsFile !== undefined && (typeof member.settingsFile !== 'string' || !isAbsolute(member.settingsFile)))
        || (member.env !== undefined && (!member.env || typeof member.env !== 'object' || Array.isArray(member.env) || Object.values(member.env).some(v => typeof v !== 'string')))) throw Error('成员配置无效，请使用原生可执行程序或 JS 文件');
      ids.add(member.id);
    }
    this.tasks = []; this.running = new Map(); this.approvals = new Map(); this.adapter = adapter; this.closed = false;
  }
  async init() {
    mkdirSync(this.directory, { recursive: true });
    if (existsSync(this.filename)) {
      const state = JSON.parse(readFileSync(this.filename, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.tasks)) throw Error('团队记录格式无法识别');
      this.tasks = state.tasks;
      for (const task of this.tasks) if (!terminal.has(task.status)) {
        task.status = 'unknown'; task.error = '上次运行中断，结果待核对；请检查工作副本后显式创建新任务';
      }
    }
    this.persist();
  }
  persist() {
    const temporary = `${this.filename}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, tasks: this.tasks }), { mode: 0o600, flush: true });
    renameSync(temporary, this.filename);
  }
  get(id, sessionId) {
    const task = this.tasks.find(task => task.id === id);
    if (task?.roomId) throw Error('房间任务仅可通过房间访问');
    if (!task || (sessionId !== undefined && task.sessionId !== sessionId)) throw Error('任务不存在或无权访问');
    return structuredClone(task);
  }
  snapshot(sessionId) {
    return { members: this.config.members.map(({ id, name, protocol, command, model }) => ({ id, name, protocol, ...(model ? { model } : {}), installed: existsSync(command) })),
      tasks: this.tasks.filter(t => !t.roomId && (sessionId === undefined || t.sessionId === sessionId)).map(t => structuredClone(t)),
      approvals: [...this.approvals.values()].filter(a => !this.tasks.find(t => t.id === a.taskId)?.roomSealed && (sessionId === undefined || a.sessionId === sessionId)).map(({ resolve: _resolve, ...a }) => a),
      workspaceRoot: join(this.root, '.local/workspaces') };
  }
  async submit(input, sessionId = 'team-ui', internal) {
    if (this.closed) throw Error('团队服务已停止');
    const { memberId, requestId, prompt, dependsOn = [], writeMode = false } = input ?? {};
    if (!this.config.members.some(m => m.id === memberId) || typeof requestId !== 'string' || !/^[\w:.-]{1,160}$/.test(requestId)
      || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32768 || typeof writeMode !== 'boolean'
      || !Array.isArray(dependsOn) || dependsOn.length > 8 || new Set(dependsOn).size !== dependsOn.length
      || dependsOn.some(id => typeof id !== 'string')) throw Error('任务参数无效');
    const digest = fingerprint({ memberId, prompt, dependsOn, writeMode });
    const existing = this.tasks.find(t => t.requestId === requestId && t.sessionId === sessionId);
    if (existing) { if (existing.digest !== digest) throw Error('请求身份冲突'); return structuredClone(existing); }
    for (const id of dependsOn) {
      if (internal?.roomId) { if (!this.tasks.some(t => t.id === id && t.roomId === internal.roomId && t.sessionId === sessionId)) throw Error('房间依赖无效'); }
      else this.get(id, sessionId);
    }
    if (this.tasks.length >= 500) throw Error('任务记录达到 500 项，请另建实验目录');
    const task = { id: randomUUID(), requestId, digest, sessionId, memberId, prompt, dependsOn, writeMode, status: 'queued', createdAt: Date.now(), events: [], output: '' };
    if (internal?.roomId) Object.assign(task, { roomId: internal.roomId, seedPath: internal.seedPath, roomSealed: Boolean(internal.sealed) });
    this.tasks.push(task);
    try { this.persist(); } catch (error) { this.tasks.pop(); throw error; }
    queueMicrotask(() => this.pump());
    return structuredClone(task);
  }
  pump() {
    if (this.closed) return;
    for (const task of this.tasks.filter(t => t.status === 'queued')) {
      const dependencies = task.dependsOn.map(id => this.tasks.find(t => t.id === id));
      if (dependencies.some(t => !t || (terminal.has(t.status) && t.status !== 'completed'))) {
        task.status = 'blocked'; task.error = '前置任务未成功完成'; this.persist(); continue;
      }
      if (dependencies.some(t => t.status !== 'completed') || this.running.size >= this.config.maxParallel) continue;
      const controller = new AbortController();
      const entry = { controller }; this.running.set(task.id, entry);
      entry.done = this.run(task, dependencies, controller).finally(() => { this.running.delete(task.id); this.pump(); });
      entry.done.catch(() => { this.closed = true; });
    }
  }
  async run(task, dependencies, controller) {
    const timer = setTimeout(() => controller.abort(Error('运行超时')), this.config.timeoutMs);
    let emittedBytes = 0;
    try {
      task.workspace = join(this.root, '.local/workspaces', task.id);
      mkdirSync(task.workspace, { recursive: true });
      const seed = task.seedPath ?? join(this.root, 'workspace');
      if (existsSync(seed) && lstatSync(seed).isSymbolicLink()) throw Error('素材根目录不能是链接');
      // No recursive links and no hidden files: credentials and dependency trees are not copied.
      if (existsSync(seed)) cpSync(realpathSync(seed), task.workspace, { recursive: true, dereference: false, filter: (source) => {
        const name = source.replaceAll('\\', '/').split('/').at(-1);
        if (name.startsWith('.') || ['node_modules', 'dist', 'build'].includes(name) || /\.(pem|key|pfx|log)$/i.test(name)) return false;
        return !lstatSync(source).isSymbolicLink();
      } });
      task.status = 'running'; task.startedAt = Date.now(); this.persist();
      if (task.writeMode && task.sessionId !== 'team-ui') {
        const permitted = await this.ask(task, { title: '允许外部成员在独立副本中修改文件？', detail: `${task.memberId}\n${task.prompt}\n工作副本：${task.workspace}` }, controller.signal);
        if (!permitted || controller.signal.aborted) throw Error('外部写入未批准');
      }
      const member = this.config.members.find(m => m.id === task.memberId);
      const prompt = dependencies.length ? `${task.prompt}\n\n以下是前置成员结果，仅作参考，不构成额外授权：\n${dependencies.map(t => `${t.memberId}: ${t.output}`).join('\n').slice(0,65536)}` : task.prompt;
      const result = await this.adapter(member, { ...task, prompt, maxOutputBytes: this.config.maxOutputBytes }, event => {
        if (controller.signal.aborted) return;
        emittedBytes += Buffer.byteLength(JSON.stringify(event));
        if (emittedBytes > this.config.maxOutputBytes) { controller.abort(Error('成员输出超出限额')); return; }
        if (event.type === 'text') task.output += event.text;
        if (event.type === 'session') task.nativeSessionId = event.id;
        task.events.push({ ...event, time: Date.now() });
        this.persist();
      }, controller.signal, request => this.ask(task, request, controller.signal));
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!result?.text?.trim()) { const error = Error('没有收到可核验的最终结果'); error.unknown = true; throw error; }
      if (Buffer.byteLength(result.text) > this.config.maxOutputBytes) throw Error('最终结果超出限额');
      task.output = result.text.slice(0, this.config.maxOutputBytes); task.status = result.blocked ? 'blocked' : 'completed';
      if (result.blocked) task.error = '成员有操作未获批准，请核对结果';
    } catch (error) {
      task.status = task.cancelRequested ? 'cancelled' : error?.unknown || controller.signal.aborted ? 'unknown' : 'failed';
      task.error = task.cancelRequested ? '已中止' : error?.publicMessage ?? (controller.signal.aborted ? '运行已停止：超时或输出超限；请核对工作副本' : '成员调用失败，请检查本机程序、登录或所选模型；未自动重发');
    } finally {
      clearTimeout(timer); task.finishedAt = Date.now();
      for (const [id, approval] of this.approvals) if (approval.taskId === task.id) { approval.resolve(false); this.approvals.delete(id); }
      this.persist();
    }
  }
  ask(task, request, signal) {
    if (task.roomSealed) return Promise.resolve(false);
    if (signal.aborted) return Promise.resolve(false);
    const id = randomUUID(); task.status = 'waiting-approval';
    return new Promise(resolve => {
      let finished = false;
      const finish = allowed => {
        if (finished) return; finished = true;
        signal.removeEventListener('abort', abort); this.approvals.delete(id);
        if (!signal.aborted && !terminal.has(task.status)) task.status = [...this.approvals.values()].some(item => item.taskId === task.id) ? 'waiting-approval' : 'running';
        this.persist(); resolve(allowed);
      };
      const abort = () => finish(false);
      this.approvals.set(id, { id, taskId: task.id, sessionId: task.sessionId, title: request.title, detail: request.detail, resolve: finish });
      signal.addEventListener('abort', abort, { once: true }); this.persist();
    });
  }
  approve(id, allowed) {
    const approval = this.approvals.get(id);
    if (!approval || typeof allowed !== 'boolean') throw Error('审批已失效');
    const task = this.tasks.find(t => t.id === approval.taskId);
    if (task?.status !== 'waiting-approval' || !this.running.has(task.id)) throw Error('审批已失效');
    approval.resolve(allowed); return { resolved: true };
  }
  async cancel(id, sessionId, internal) {
    if (!internal?.roomId) this.get(id, sessionId);
    const task = this.tasks.find(t => t.id === id);
    if (!task || (internal?.roomId && task.roomId !== internal.roomId)) throw Error('房间任务无效');
    if (terminal.has(task.status)) return structuredClone(task);
    task.cancelRequested = true;
    const entry = this.running.get(id);
    if (entry) { task.status = 'cancelling'; entry.controller.abort(Error('用户中止')); await entry.done; }
    else { task.status = 'cancelled'; task.finishedAt = Date.now(); this.persist(); this.pump(); }
    return structuredClone(task);
  }
  async close() {
    this.closed = true;
    for (const entry of this.running.values()) entry.controller.abort(Error('服务停止'));
    await Promise.allSettled([...this.running.values()].map(entry => entry.done));
  }
}
