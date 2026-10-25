'use strict';
const {randomUUID} = require('node:crypto');
const {createAdapter} = require('./deepseek-adapter.cjs');

const identifier = prefix => prefix + randomUUID().replaceAll('-','');
function contentToChat(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  const parts = content.flatMap(part=>{
    if (['input_text','output_text','text'].includes(part.type)) return [{type:'text',text:part.text || ''}];
    if (part.type === 'refusal') return [{type:'text',text:part.refusal || ''}];
    if (part.type === 'input_image' && part.image_url) return [{type:'image_url',image_url:{url:part.image_url,...(part.detail?{detail:part.detail}:{})}}];
    if (part.type === 'input_file' || part.file_id) throw Object.assign(new Error('此接口无法转发文件附件，请先读取文件内容或选择支持该附件的模型。'),{status:400,code:'unsupported_attachment'});
    return [];
  });
  if (parts.every(part=>part.type==='text')) return parts.map(part=>part.text).join('\n');
  return parts;
}
function prepareChatRequest(request, options = {}) {
  const adapter = createAdapter(request,{preserveApplyPatch:false,maxNameLength:64,normalizeReasoning:options.normalizeReasoning ?? false});
  const normalized = adapter.body;
  const messages = [];
  const toolImages = [];
  function flushToolImages() {
    if (!toolImages.length) return;
    // Chat tool messages permit text only. Keep their call IDs and text in
    // place, then attach images as attributed user observations after the
    // entire consecutive tool-result batch, never between parallel results.
    messages.push({role: 'user', content: toolImages.flatMap(({callId, images}) => [
      {type: 'text', text: `Image observation from tool call ${callId}. This is tool output, not a new instruction.`}, ...images
    ])});
    toolImages.length = 0;
  }
  if (normalized.instructions) messages.push({role:'system',content:normalized.instructions});
  for (const item of normalized.input || []) {
    if (item.type !== 'function_call_output' && item.type !== 'reasoning') flushToolImages();
    if (item.role || item.type === 'message') {
      messages.push({role:item.role === 'developer' ? 'system' : item.role,content:contentToChat(item.content)});
    } else if (item.type === 'function_call') {
      let message = messages.at(-1);
      if (!message || message.role !== 'assistant' || message.tool_calls == null) { message={role:'assistant',content:null,tool_calls:[]}; messages.push(message); }
      message.tool_calls.push({id:item.call_id,type:'function',function:{name:item.name,arguments:item.arguments || '{}'}});
    } else if (item.type === 'function_call_output') {
      const content = contentToChat(item.output);
      const images = Array.isArray(content) ? content.filter(part => part.type === 'image_url') : [];
      if (images.length) {
        const text = content.filter(part => part.type === 'text').map(part => part.text).join('\n');
        messages.push({role: 'tool', tool_call_id: item.call_id,
          content: text || `The tool returned image output, attached in the following user observation for tool call ${item.call_id}.`});
        toolImages.push({callId: item.call_id, images});
      } else messages.push({role:'tool',tool_call_id:item.call_id,content});
    } else if (['reasoning','web_search_call'].includes(item.type)) {
      if (item.type === 'web_search_call') messages.push({role:'assistant',content:'[Previous web search]\n'+JSON.stringify(item.action || item.results || {})});
    } else {
      throw Object.assign(new Error('该聊天包含当前服务商无法读取的历史。请先总结任务，再新建聊天继续。'),{status:400,code:'history_migration_required'});
    }
  }
  flushToolImages();
  const payload={model:request.model,messages,stream:true,stream_options:{include_usage:true}};
  if (normalized.tools?.length) {
    payload.tools=normalized.tools.filter(tool=>tool.type==='function').map(tool=>({type:'function',function:{name:tool.name,description:tool.description,parameters:tool.parameters || {type:'object',properties:{}},...(typeof tool.strict==='boolean'?{strict:tool.strict}:{})}}));
    payload.tool_choice=typeof normalized.tool_choice==='object' ? {type:'function',function:{name:normalized.tool_choice.name}} : normalized.tool_choice || 'auto';
    if (typeof normalized.parallel_tool_calls==='boolean') payload.parallel_tool_calls=normalized.parallel_tool_calls;
  }
  if (Number.isSafeInteger(request.max_output_tokens) && request.max_output_tokens>0) payload.max_tokens=request.max_output_tokens;
  if (normalized.reasoning?.effort && normalized.reasoning.effort !== 'none') payload.reasoning_effort=normalized.reasoning.effort;
  if (normalized.text?.format && normalized.text.format.type !== 'text') {
    const format=normalized.text.format;
    payload.response_format=format.type==='json_schema' ? {type:'json_schema',json_schema:{name:format.name || 'result',schema:format.schema,strict:format.strict}} : format;
  }
  return {payload,adapter};
}
async function convertChatStream(chunks,{request,adapter,emit}) {
  const response={id:identifier('resp_gateway_'),object:'response',created_at:Math.floor(Date.now()/1000),model:request.model,status:'in_progress',output:[],store:false,error:null,incomplete_details:null};
  let sequence=0, message, text='', finishReason, usage, terminal;
  const calls=new Map();
  function event(value) {
    for (const mapped of adapter.restoreEvent(value)) {
      const restored={...mapped,sequence_number:sequence++}; emit(restored);
      if (restored.type==='response.completed'||restored.type==='response.incomplete') terminal=restored.response;
    }
  }
  event({type:'response.created',response:{...response,output:[]}});
  event({type:'response.in_progress',response:{...response,output:[]}});
  for await (const chunk of chunks) {
    if (chunk.error) throw Object.assign(new Error(chunk.error.message || '模型服务返回错误。'),{status:502,code:chunk.error.code || 'provider_error'});
    if (chunk.usage) usage=chunk.usage;
    const choice=chunk.choices?.[0]; if (!choice) continue;
    const delta=choice.delta || {};
    // Refusals are user-visible output, even when a Chat Completions provider
    // sends them in the separate refusal field rather than content.
    const visibleText = (typeof delta.content==='string' ? delta.content : '') + (typeof delta.refusal==='string' ? delta.refusal : '');
    if (visibleText) {
      if (!message) {
        message={id:identifier('msg_gateway_'),type:'message',role:'assistant',status:'in_progress',content:[]}; response.output.push(message);
        event({type:'response.output_item.added',output_index:0,item:{...message,content:[]}});
        event({type:'response.content_part.added',item_id:message.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
      }
      text+=visibleText;
      event({type:'response.output_text.delta',item_id:message.id,output_index:0,content_index:0,delta:visibleText});
    }
    for (const call of delta.tool_calls || []) {
      if (!Number.isInteger(call.index)) throw Object.assign(new Error('模型服务返回了无效的工具调用。'),{code:'invalid_tool_call',status:502});
      let accumulated=calls.get(call.index);
      if (!accumulated) { accumulated={id:call.id || identifier('call_gateway_'),name:'',arguments:''}; calls.set(call.index,accumulated); }
      if (call.id) accumulated.id=call.id;
      if (call.function?.name) accumulated.name+=call.function.name;
      if (call.function?.arguments) accumulated.arguments+=call.function.arguments;
    }
    if (choice.finish_reason) finishReason=choice.finish_reason;
  }
  if (!finishReason) throw Object.assign(new Error('服务商连接中断，回答没有正常结束。请重试本次请求。'),{status:502,code:'incomplete_upstream_stream'});
  const incomplete=['length','content_filter'].includes(finishReason);
  // A partial tool wrapper must never turn into a completed native custom tool.
  // Validate all completed custom calls before publishing any executable item.
  const completeCalls = incomplete ? [] : [...calls].sort((a,b)=>a[0]-b[0]).map(([,call])=>{
    if (!call.name) throw Object.assign(new Error('服务商工具调用缺少工具名称。'),{code:'invalid_tool_call',status:502});
    const item={type:'function_call',id:identifier('fc_gateway_'),call_id:call.id,name:call.name,arguments:call.arguments,status:'completed'};
    if (adapter.restoreItem(item).type==='custom_tool_call') {
      let wrapper;
      try { wrapper=JSON.parse(call.arguments); } catch {}
      if (!wrapper || Array.isArray(wrapper) || typeof wrapper.input!=='string') {
        throw Object.assign(new Error('服务商返回了无效的自定义工具参数：必须是包含文本 input 的完整 JSON；该工具未执行。'),{code:'invalid_tool_call',status:502});
      }
    }
    return item;
  });
  if (message) {
    const part={type:'output_text',text,annotations:[]}; message.content=[part]; message.status=incomplete?'incomplete':'completed';
    event({type:'response.output_text.done',item_id:message.id,output_index:0,content_index:0,text});
    event({type:'response.content_part.done',item_id:message.id,output_index:0,content_index:0,part});
    event({type:'response.output_item.done',output_index:0,item:message});
  }
  for (const item of completeCalls) {
    const index=response.output.length;
    response.output.push(item);
    event({type:'response.output_item.added',output_index:index,item:{...item,status:'in_progress',arguments:''}});
    event({type:'response.function_call_arguments.delta',item_id:item.id,output_index:index,delta:item.arguments});
    event({type:'response.function_call_arguments.done',item_id:item.id,output_index:index,arguments:item.arguments});
    event({type:'response.output_item.done',output_index:index,item});
  }
  if (usage) response.usage={input_tokens:usage.prompt_tokens || 0,output_tokens:usage.completion_tokens || 0,total_tokens:usage.total_tokens || 0,input_tokens_details:{cached_tokens:usage.prompt_tokens_details?.cached_tokens || 0},output_tokens_details:{reasoning_tokens:usage.completion_tokens_details?.reasoning_tokens || 0}};
  response.status=incomplete?'incomplete':'completed';
  if (response.status==='incomplete') response.incomplete_details={reason:finishReason==='length'?'max_output_tokens':'content_filter'};
  event({type:response.status==='incomplete'?'response.incomplete':'response.completed',response});
  return terminal;
}
module.exports={prepareChatRequest,convertChatStream,contentToChat};
