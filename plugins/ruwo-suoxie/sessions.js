/** Forward the official Session API unchanged. No private DB access or event synthesis. */
export async function sessionResponse(controller, request, companion, continuation, importModels, plugins, team, usage) {
  const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  if (request.headers.get('x-cyrene-control') !== '1') return json({ error: 'forbidden' }, 403);
  const text = await request.text();
  if (text.length > 16 * 1024 * 1024) return json({ error: 'too-large' }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: 'invalid' }, 400); }
  const { method, params } = body ?? {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) return json({ error: 'invalid' }, 400);
  if (method === 'usage') {
    if (!usage) return json({ error: 'usage-unavailable' }, 503);
    if (!Number.isSafeInteger(params.days) || params.days < 1 || params.days > 366) return json({ error: 'invalid' }, 400);
    try { return json({ result: await usage(params, request.signal) }); }
    catch { return json({ error: 'usage-unavailable' }, 503); }
  }
  if (method === 'team') {
    if (!team) return json({ error: 'team-not-configured' }, 503);
    try { return json({ result: await team.request(params) }); }
    catch { return json({ error: '团队操作被拒绝，请刷新后检查成员、任务状态与本机配置' }, 409); }
  }
  if (method === 'plugins') {
    try { return json({ result: await plugins(params) }); }
    catch { return json({ error: 'native-plugin-operation-rejected' }, 409); }
  }
  if (method === 'importModels') {
    try { return json({ result: await importModels(params) }); }
    catch { return json({ error: 'model-sync-rejected' }, 409); }
  }
  if (['continue', 'continuationStatus', 'retryContinuation'].includes(method)) {
    try { return json({ result: await continuation.request(method, params, request.signal) }); }
    catch { return json({ error: 'continuation-unconfirmed' }, 409); }
  }
  if (method === 'configure') {
    try { return json({ result: companion.configure(params) }); }
    catch { return json({ error: 'companion-configuration-rejected' }, 409); }
  }
  if (method === 'identity') return json({ result: { runtime: 'DeepSeek Harness', service: 'sessionController', plugin: '@cyrene/ruwo-suoxie', protocol: 1, pid: process.pid } });
  const ordinary = new Set(['modelCatalog', 'list', 'create', 'fork', 'selectModel', 'rename', 'prompt', 'cancel', 'page', 'attachment']);
  if (!ordinary.has(method) && method !== 'follow') return json({ error: 'unsupported' }, 400);
  // Parameters are passed to the same domain validators as native DSH UI.
  // Additional structural checks prevent malformed objects entering internal APIs.
  const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
  const address = value => value?.kind === 'session' && id(value.sessionId);
  if (['selectModel', 'rename', 'prompt', 'cancel', 'attachment','fork'].includes(method) && !id(params.sessionId)) return json({ error: 'invalid' }, 400);
  if(method==='fork'&&(params.atSeq!==undefined&&(!Number.isSafeInteger(params.atSeq)||params.atSeq<0)))return json({error:'invalid'},400);
  if (['page', 'follow'].includes(method) && !address(params.address)) return json({ error: 'invalid' }, 400);
  if (method === 'page' && (!Number.isSafeInteger(params.throughSeq) || params.throughSeq < -1
    || (params.beforeSeq !== undefined && (!Number.isSafeInteger(params.beforeSeq) || params.beforeSeq < 0)))) return json({ error: 'invalid' }, 400);
  if (['page', 'follow'].includes(method) && params.maxMessages !== undefined
    && (!Number.isSafeInteger(params.maxMessages) || params.maxMessages < 1 || params.maxMessages > 500)) return json({ error: 'invalid' }, 400);
  if (method === 'selectModel' && (!id(params.provider) || !id(params.model))) return json({ error: 'invalid' }, 400);
  if (method === 'prompt' && (!id(params.requestId) || !['queue', 'steer'].includes(params.mode)
    || !Array.isArray(params.content) || params.content.length > 100
    || params.content.some(part => !part || !['text', 'image', 'file'].includes(part.type)
      || (part.type === 'text' && typeof part.text !== 'string')
      || (part.type === 'image' && (typeof part.data !== 'string' || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(part.mediaType)))
      || (part.type === 'file' && !id(part.receiptId))))) return json({ error: 'invalid' }, 400);
  if (method === 'create' && ((params.sessionId !== undefined && !id(params.sessionId))
    || (params.cwd !== undefined && typeof params.cwd !== 'string'))) return json({ error: 'invalid' }, 400);
  if (method === 'rename' && (typeof params.title !== 'string' || params.title.length > 1000)) return json({ error: 'invalid' }, 400);
  if (method === 'attachment' && !id(params.attachmentId)) return json({ error: 'invalid' }, 400);
  try {
    if (method !== 'follow') return json({ result: await controller[method](params, request.signal) });
    const encoder = new TextEncoder();
    const abort = new AbortController();
    const cancel = () => abort.abort();
    request.signal.addEventListener('abort', cancel, { once: true });
    const iterator = controller.follow(params, abort.signal)[Symbol.asyncIterator]();
    const stream = new ReadableStream({
      async pull(output) {
        try {
          const value = await iterator.next();
          if (value.done) { request.signal.removeEventListener('abort', cancel); output.close(); }
          else output.enqueue(encoder.encode(`${JSON.stringify(value.value)}\n`));
        } catch { request.signal.removeEventListener('abort', cancel); output.error(new Error('Session follow disconnected')); }
      },
      async cancel() { cancel(); request.signal.removeEventListener('abort', cancel); await iterator.return?.(); },
    });
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } });
  } catch { return json({ error: 'session-operation-failed' }, 409); }
}
