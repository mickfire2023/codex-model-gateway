'use strict';
const {createAdapter}=require('./deepseek-adapter.cjs');
const {prepareChatRequest,convertChatStream}=require('./chat-completions.cjs');
const {isCompactionRequest,expandLocalCompactions,makeSummaryRequest,makeCompactionEvents}=require('./compaction.cjs');
const fail=(message,code,status=400)=>Object.assign(new Error(message),{code,status});

function createProviderRunner({providers,deepseekBase,getDeepseekKey,secret,requestUpstream,readBody,events,log=()=>{}}) {
  function expand(request) { return expandLocalCompactions(request,secret); }
  async function upstreamError(upstream,provider) {
    // Provider error bodies can echo credentials or private prompts. Consume but never expose them.
    await readBody(upstream);
    const status=upstream.statusCode;
    const message=status===401||status===403?'密钥无效或账号无权使用所选模型，请在管理页检查。':status===402?'服务商余额不足，请检查账户余额。':status===429?'服务商请求频率或额度受限，请稍后再试。':`服务商返回 HTTP ${status}，请检查 API 地址、模型权限和接口类型。`;
    throw fail(message,provider+'_http_error',status>=400&&status<600?status:502);
  }
  async function run({route,request,emit=()=>{},signal,historyScope}) {
    const provider=typeof route==='string'?route:route.provider;
    const expanded=expand(request);
    if (isCompactionRequest(expanded)) {
      const summary=await run({route,request:makeSummaryRequest(expanded),emit:()=>{},signal});
      if (summary?.status!=='completed') throw fail('摘要尚未完整生成，原聊天上下文未替换。请提高输出上限或稍后重试。','compaction_summary_incomplete',502);
      const text=(summary.output||[]).filter(x=>x.type==='message').flatMap(x=>x.content||[]).map(x=>x.text||x.refusal||'').join('\n');
      const compacted=makeCompactionEvents(text,request.model,secret);
      for (const event of compacted) await emit(event);
      log({event:'context_compacted',provider,model:request.model});
      return compacted.at(-1).response;
    }
    let target,body,adapter,chat=false;
    if (provider==='deepseek') {
      const key=getDeepseekKey();
      if (!key) throw fail('请先在管理页填写并验证 DeepSeek 密钥。','deepseek_key_missing',503);
      target={url:new URL(`${deepseekBase}/responses`),headers:{authorization:`Bearer ${key}`,'content-type':'application/json',accept:'text/event-stream, application/json','accept-encoding':'identity'}};
      adapter=createAdapter(expanded); body=adapter.body;
    } else {
      target=providers.upstreamForSlug(request.model);
      const capabilities=target.model;
      body={...expanded,model:target.modelId};
      if (!capabilities.inputModalities.includes('image') && JSON.stringify(body.input||[]).includes('"type":"input_image"')) throw fail('该模型配置为仅支持文本，请切换支持图片的模型或移除图片。','unsupported_image_input');
      if (!capabilities.supportsTools) { delete body.tools; delete body.tool_choice; delete body.parallel_tool_calls; }
      if (body.reasoning) {
        const effort=capabilities.reasoningEfforts.includes(body.reasoning.effort)?body.reasoning.effort:capabilities.defaultReasoningEffort;
        body.reasoning={effort};
        if (effort==='none') delete body.reasoning;
      }
      if (body.max_output_tokens) body.max_output_tokens=Math.min(body.max_output_tokens,capabilities.maxOutputTokens);
      else body.max_output_tokens=capabilities.maxOutputTokens;
      chat=target.protocol==='chat_completions';
      if (chat) { const prepared=prepareChatRequest(body); adapter=prepared.adapter; body=prepared.payload; }
      else {
        const preserveOpaqueReasoning = target.preserveOpaqueReasoning === true && typeof historyScope === 'string' && historyScope === target.historyScope;
        adapter=createAdapter(body,{preserveApplyPatch:false,normalizeReasoning:false,strictCustomWrappers:true,maxNameLength:64,preserveOpaqueReasoning}); body=adapter.body;
      }
    }
    // stream_id belongs to the gateway's local WebSocket lane, not the HTTP API.
    delete body.stream_id;
    body.stream=true;
    const payload=Buffer.from(JSON.stringify(body));
    const upstream=await requestUpstream(target.url,{method:'POST',headers:{...target.headers,'content-length':payload.length},signal},payload);
    if (!(upstream.statusCode>=200&&upstream.statusCode<300)) await upstreamError(upstream,provider==='deepseek'?'deepseek':'provider');
    const outgoing=event=> {
      const mapped=event.response?{...event,response:{...event.response,model:request.model}}:event;
      return emit(mapped);
    };
    if (chat) {
      const response=await convertChatStream(events(upstream),{request:{...expanded,model:request.model},adapter,emit:outgoing});
      return {...response,model:request.model};
    }
    let completed;
    let sequence=0;
    for await (const event of events(upstream)) {
      if (event.type==='error' || event.type==='response.failed') throw fail('服务商生成失败，请检查模型权限或稍后重试。','provider_response_failed',502);
      for (const mapped of adapter.restoreEvent(event)) {
        const value={...mapped,sequence_number:sequence++};
        if (value.response) value.response={...value.response,model:request.model};
        await outgoing(value);
        if (value.type==='response.completed'||value.type==='response.incomplete') completed=value.response;
      }
    }
    if (!completed) throw fail('服务商连接已结束，但未返回完整结束事件；本次请求不会自动重试。','incomplete_upstream_stream',502);
    return completed;
  }
  return {run,expand};
}
module.exports={createProviderRunner};
