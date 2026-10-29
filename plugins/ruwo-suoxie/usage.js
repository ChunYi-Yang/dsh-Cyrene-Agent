const known = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const name = value => typeof value === 'string' && value.trim() ? value.trim() : 'unknown';
const dayKey = time => { const d = new Date(time); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

/** Same exact-total boundary as token-meter/turn-usage; missing cache buckets are not zero. */
function exactPrompt(usage) {
  const input=known(usage?.inputTokens),output=known(usage?.outputTokens);
  if(input === null || output === null) return null;
  for(const key of ['cacheReadTokens','cacheWriteTokens','reasoningTokens']) {
    if(usage[key] !== undefined && known(usage[key]) === null) return null;
  }
  if(usage.reasoningTokens !== undefined && usage.reasoningTokens>output) return null;
  const prompt=input+(usage.cacheReadTokens ?? 0)+(usage.cacheWriteTokens ?? 0);
  if(!Number.isSafeInteger(prompt)) return null;
  const complete=usage.cacheReadTokens !== undefined && usage.cacheWriteTokens !== undefined;
  if(usage.totalTokens !== undefined) {
    const total=known(usage.totalTokens);
    if(total === null) return null;
    const exact=total-output;
    if(known(exact) === null || exact<prompt || complete && exact !== prompt) return null;
    return exact;
  }
  return complete && Number.isSafeInteger(prompt+output) ? prompt : null;
}

/** Read only billing metadata through the public session-query lease. Never export content. */
export function foldSessionUsage(events, inheritedEventCount = 0) {
  let route = {}, previous;
  const rows = [];
  for (const event of events) {
    const data = event.data ?? {};
    if (event.type === 'request/context') route = {provider:data.provider,model:data.model};
    if (event.type === 'llm/retry-started') {
      if (previous?.turn === data.turn && previous?.step === data.step) previous = undefined;
      continue;
    }
    if (!['assistant/message','assistant/attempt'].includes(event.type)) continue;
    let usage = data.usage;
    if (!usage) for (const item of data.stream ?? []) if (item.type === 'chunk' && item.chunk?.type === 'usage') usage = item.chunk.usage;
    const source = data.message?.source?.kind === 'model' ? data.message.source : route;
    const uncached = known(usage?.inputTokens), hit = known(usage?.cacheReadTokens), creation = known(usage?.cacheWriteTokens);
    const input = exactPrompt(usage), output = known(usage?.outputTokens);
    const row = {day:dayKey(event.time),provider:name(source.provider),model:name(source.model),
      // DSH inputTokens is the uncached bucket. Cyrene input includes all prompt buckets.
      input,output,hit,miss:hit === null ? null : uncached,cacheCreation:creation,
      requests:1,unknownRequests:input === null || output === null ? 1 : 0};
    // Match token-meter's replacement slot; retries open a new billable attempt.
    if (previous && Number.isSafeInteger(data.turn) && Number.isSafeInteger(data.step) && previous.turn === data.turn && previous.step === data.step) {
      if (event.seq >= inheritedEventCount && previous.owned && usage) rows[previous.index] = row;
    } else {
      const owned = event.seq >= inheritedEventCount;
      if (owned) rows.push(row);
      previous = {turn:data.turn,step:data.step,index:rows.length-1,owned};
    }
  }
  return rows;
}

export function createUsageReader(ctx) {
  return async (params, signal, now = new Date()) => {
    const days = Number.isSafeInteger(params?.days) ? Math.max(1,Math.min(366,params.days)) : 7;
    const from = new Date(now.getFullYear(),now.getMonth(),now.getDate());from.setDate(from.getDate()-days+1);
    const base = {scope:'DSH 本机原生会话（含持久化历史；不含外部 agent 与无会话纯生成）',from:dayKey(from),through:dayKey(now),rows:[],failedSessions:0};
    const query = ctx.get?.('sessionQuery') ?? ctx.sessionQuery;
    if (!query?.listSessions || !query?.observeSession) return {...base,status:'unavailable'};
    let records;
    try { records = await query.listSessions(signal); } catch { return {...base,status:'unavailable'}; }
    let scannedSessions = 0;
    const seen = new Set();
    for (const record of records) {
      if(seen.has(record.header.id))continue;
      seen.add(record.header.id);
      signal?.throwIfAborted();
      let observation;
      try {
        observation = await query.observeSession(record.header.id,{projectionMode:'none',signal});
        base.rows.push(...foldSessionUsage(observation.events,observation.inheritedEventCount)
          .filter(row=>row.day>=base.from && row.day<=base.through));
        scannedSessions++;
      } catch { if(signal?.aborted) throw signal.reason; base.failedSessions++; }
      finally { observation?.[Symbol.dispose](); }
    }
    return {...base,scannedSessions,status:base.failedSessions ? 'partial' : 'available'};
  };
}
