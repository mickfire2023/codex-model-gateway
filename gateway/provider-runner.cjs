'use strict';
const {randomUUID}=require('node:crypto');
const {DEFAULT_CUSTOM_INSTRUCTIONS}=require('./provider-store.cjs');
const {createAdapter}=require('./deepseek-adapter.cjs');
const {prepareChatRequest,convertChatStream}=require('./chat-completions.cjs');
const {isCompactionRequest,expandLocalCompactions,makeSummaryRequest,makeCompactionEvents}=require('./compaction.cjs');
const fail=(message,code,status=400)=>Object.assign(new Error(message),{code,status});

function createProviderRunner({providers,deepseekBase,getDeepseekKey,secret,requestUpstream,readBody,events,log=()=>{},legacyCustomInstructions=[],beforeRequest}) {
  const legacyInstructions=new Set(legacyCustomInstructions);
  function expand(request) { return expandLocalCompactions(request,secret); }
  async function upstreamError(upstream,provider,gemini=false) {
    // Provider error bodies can echo credentials or private prompts. Consume but never expose them.
    const raw=await readBody(upstream);
    const status=upstream.statusCode;
    const advice=String(upstream.headers?.['retry-after']||'');
    const seconds=/^\d{1,6}$/.test(advice)?Number(advice):Math.ceil((Date.parse(advice)-Date.now())/1000);
    const retryAfterSeconds=Number.isSafeInteger(seconds)&&seconds>0&&seconds<=604800?seconds:undefined;
    let cooldown=false;
    if(gemini&&status===429&&raw.length<=65536){try{cooldown=JSON.parse(raw.toString('utf8')).error?.code==='model_cooldown';}catch{}}
    const message=cooldown?`当前 Gemini 型号正在上游冷却${retryAfterSeconds?`，约 ${retryAfterSeconds} 秒后可重试`:''}；可以先选择其他可用型号。`:status===401||status===403?'密钥无效或账号无权使用所选模型，请在管理页检查。':status===402?'服务商余额不足，请检查账户余额。':status===429?'服务商请求频率或额度受限，请稍后再试。':`服务商返回 HTTP ${status}，请检查 API 地址、模型权限和接口类型。`;
    throw Object.assign(fail(message,cooldown?'gemini_model_cooldown':provider+'_http_error',status>=400&&status<600?status:502),retryAfterSeconds?{retryAfterSeconds}:{});
  }
  async function run({route,request,emit=()=>{},signal,historyScope}) {
    const provider=typeof route==='string'?route:route.provider;
    const expanded=expand(request);
    // Codex prewarms WebSocket state with generate:false. A protocol warmup
    // must finish locally, never spend quota or leave the response lane busy.
    if(expanded.generate===false){
      const response={id:'resp_gateway_warmup_'+randomUUID().replaceAll('-',''),object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',model:request.model,output:[],error:null,incomplete_details:null,usage:{input_tokens:0,output_tokens:0,total_tokens:0}};
      await emit({type:'response.created',sequence_number:0,response:{...response,status:'in_progress',usage:null}});
      await emit({type:'response.completed',sequence_number:1,response});
      log({event:'provider_warmup',provider,model:request.model});
      return response;
    }
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
      // Correct only our exact old provider template in cached Gemini sessions.
      // User/developer instructions and unrelated system content stay intact.
      if(target.providerId==='gemini-subscription'){
        let migrated=false;
        if(legacyInstructions.has(body.instructions)){body.instructions=DEFAULT_CUSTOM_INSTRUCTIONS;migrated=true;}
        if(Array.isArray(body.input))body.input=body.input.map(item=>{
          if(!['system','developer'].includes(item?.role))return item;
          if(typeof item.content==='string'&&legacyInstructions.has(item.content)){migrated=true;return {...item,content:DEFAULT_CUSTOM_INSTRUCTIONS};}
          if(Array.isArray(item.content)&&item.content.length===1&&['input_text','text'].includes(item.content[0]?.type)&&legacyInstructions.has(item.content[0]?.text)){migrated=true;return {...item,content:[{...item.content[0],text:DEFAULT_CUSTOM_INSTRUCTIONS}]};}
          return item;
        });
        if(migrated)log({event:'legacy_custom_instructions_migrated',provider,model:request.model});
      }
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
    if(beforeRequest)await beforeRequest({provider,target,signal});
    log({event:'provider_request_started',provider,model:request.model});
    let upstream;
    try{upstream=await requestUpstream(target.url,{method:'POST',headers:{...target.headers,'content-length':payload.length},signal},payload);}
    catch(error){
      if(target.providerId==='gemini-subscription'&&error.code==='ECONNREFUSED')throw Object.assign(fail('Gemini 本机组件连接中断；正在检查组件状态，请稍后重试。本次模型请求不会自动重发。','gemini_service_connection_lost',503),{retryAfterSeconds:10});
      throw error;
    }
    if (!(upstream.statusCode>=200&&upstream.statusCode<300)) await upstreamError(upstream,provider==='deepseek'?'deepseek':'provider',target.providerId==='gemini-subscription');
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
