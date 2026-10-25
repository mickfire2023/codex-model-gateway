'use strict';
const {createHash} = require('node:crypto');

// CLIProxyAPI's Gemini Responses translator carries Google part signatures in
// explicitly marked reasoning items. Never preserve arbitrary OpenAI blobs.
function isGeminiReasoningCarrier(item) {
  return item?.type === 'reasoning' && typeof item.encrypted_content === 'string' && item.encrypted_content.length <= 1024*1024 &&
    /^cpa-gemini-responses-carrier-v1:(?:next|previous|standalone):(?:function|text|any):[A-Za-z0-9+/]+$/.test(item.encrypted_content);
}

function createAdapter(request, options = {}) {
  const body = structuredClone(request);
  const names = new Map();
  const customCalls = new Set();
  function encoded(name, namespace, custom = false) {
    const identity = `${namespace || ''}\0${name}\0${custom}`;
    const limit=options.maxNameLength || 128;
    const alias = !namespace && new RegExp('^[A-Za-z0-9_-]{1,'+limit+'}$').test(name) && !custom
      ? name : `${String(namespace || 'tool').replace(/[^A-Za-z0-9_-]/g, '_')}_${String(name).replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0,limit-13)+'_'+createHash('sha256').update(identity).digest('hex').slice(0,12);
    names.set(alias, {name, namespace, custom});
    return alias;
  }
  function flatten(tools, namespace) {
    return (tools || []).flatMap(tool => {
      const ns = tool.namespace || namespace;
      if (tool.type === 'namespace') return flatten(tool.tools, ns ? `${ns}.${tool.name}` : tool.name);
      if (tool.type === 'function') {
        const {namespace: ignored, ...result} = tool;
        result.name = encoded(tool.name, ns);
        return [result];
      }
      if (tool.type === 'custom' && tool.name === 'apply_patch' && options.preserveApplyPatch !== false) {
        names.set('apply_patch', {name: tool.name, namespace: ns, custom: false});
        const {namespace: ignored, ...result} = tool;
        return [result];
      }
      if (tool.type === 'custom') {
        return [{type: 'function', name: encoded(tool.name, ns, true), description: tool.description,
          parameters: {type: 'object', properties: {input: {type:'string'}}, required:['input'], additionalProperties:false}}];
      }
      return tool.type === 'web_search' && body.model === 'deepseek-v4-pro' ? [tool] : [];
    });
  }
  body.tools = flatten(body.tools);
  if (!body.tools.length) delete body.tools;
  body.input = (typeof body.input === 'string' ? [{role:'user',content:body.input}] : (body.input || [])).flatMap(item => {
    const result = {...item};
    if (item.type === 'compaction' && item.encrypted_content) {
      const error = new Error('This conversation contains OpenAI-only compacted history. Start a new chat for DeepSeek.');
      error.status = 400; error.code = 'incompatible_compacted_history'; throw error;
    }
    if (item.type === 'reasoning') {
      if (options.preserveOpaqueReasoning === true && isGeminiReasoningCarrier(item)) return [result];
      delete result.encrypted_content; delete result.summary;
      if (!result.content?.length) return [];
    }
    if (item.role === 'developer') {
      result.role = 'system';
      if (Array.isArray(item.content)) {
        const text = item.content.filter(x => !['input_image','input_file'].includes(x.type));
        const media = item.content.filter(x => ['input_image','input_file'].includes(x.type));
        return [...(text.length ? [{...result,content:text}] : []), ...(media.length ? [{type:'message',role:'user',content:media}] : [])];
      }
    }
    if (item.type === 'function_call') {
      result.name = encoded(item.name, item.namespace);
      delete result.namespace;
    }
    if (item.type === 'custom_tool_call' && (item.name !== 'apply_patch' || options.preserveApplyPatch === false)) {
      result.type = 'function_call'; result.name = encoded(item.name, item.namespace, true);
      result.arguments = JSON.stringify({input:item.input}); delete result.input; delete result.namespace;
      customCalls.add(item.call_id);
    } else if (item.type === 'custom_tool_call') delete result.namespace;
    if (item.type === 'custom_tool_call_output' && customCalls.has(item.call_id)) result.type = 'function_call_output';
    return [result];
  });
  if (body.tool_choice && typeof body.tool_choice === 'object') {
    body.tool_choice = {...body.tool_choice};
    if (body.tool_choice.type === 'function') {
      body.tool_choice.name = encoded(body.tool_choice.name, body.tool_choice.namespace);
      delete body.tool_choice.namespace;
    }
    if (body.tool_choice.type === 'custom' && options.preserveApplyPatch === false) {
      body.tool_choice = {type:'function',name:encoded(body.tool_choice.name,body.tool_choice.namespace,true)};
    }
  }
  if (body.reasoning && options.normalizeReasoning !== false) {
    body.reasoning = {...body.reasoning};
    delete body.reasoning.summary; delete body.reasoning.generate_summary; delete body.reasoning.context;
    if (['ultra','persistent'].includes(body.reasoning.effort)) body.reasoning.effort = 'max';
    else if (['medium','xhigh'].includes(body.reasoning.effort)) body.reasoning.effort = 'high';
  }
  if (options.normalizeReasoning !== false && (body.tool_choice === 'required' || typeof body.tool_choice === 'object')) body.reasoning = {...body.reasoning,effort:'none'};
  let thinkingInTurn = false, missingToolReasoning = false;
  for (const item of body.input) {
    if (item.role === 'user') { thinkingInTurn = false; missingToolReasoning = false; }
    if (item.type === 'reasoning' && item.content?.some(part=>part.type==='reasoning_text' && part.text)) thinkingInTurn = true;
    if (['function_call','custom_tool_call'].includes(item.type) && !thinkingInTurn) missingToolReasoning = true;
  }
  if (missingToolReasoning && options.normalizeReasoning !== false) body.reasoning = {...body.reasoning,effort:'none'};
  for (const key of ['previous_response_id','conversation','store','background','metadata','include','prompt','truncation','service_tier','safety_identifier','prompt_cache_key','prompt_cache_retention','context_management','stream_options','type','generate','client_metadata']) delete body[key];
  function customInput(argumentsText) {
    let wrapper;
    try { wrapper=JSON.parse(argumentsText); } catch {}
    if (!wrapper || Array.isArray(wrapper) || typeof wrapper.input!=='string') {
      throw Object.assign(new Error('服务商返回了无效的自定义工具参数：必须是包含文本 input 的完整 JSON；该工具未执行。'),{code:'invalid_tool_call',status:502});
    }
    return wrapper.input;
  }
  function restoreItem(item, validate = false) {
    if (!item || !['function_call','custom_tool_call'].includes(item.type)) return item;
    const mapped = names.get(item.name);
    if (!mapped) return item;
    const result = {...item, name:mapped.name};
    if (mapped.namespace) result.namespace = mapped.namespace;
    if (mapped.custom) {
      result.type = 'custom_tool_call';
      if (options.strictCustomWrappers && validate) result.input=customInput(item.arguments);
      else { try { result.input = JSON.parse(item.arguments || '{}').input || ''; } catch { result.input = item.arguments || ''; } }
      delete result.arguments;
    }
    return result;
  }
  const customOutputItems = new Set();
  function restoreEvent(event) {
    const result = {...event};
    if (result.item) {
      result.item = restoreItem(result.item, result.type==='response.output_item.done');
      if (result.item.type === 'custom_tool_call' && event.item.type === 'function_call') customOutputItems.add(event.item.id);
    }
    if (customOutputItems.has(result.item_id) && result.type === 'response.function_call_arguments.delta') return [];
    if (customOutputItems.has(result.item_id) && result.type === 'response.function_call_arguments.done') {
      let input = result.arguments;
      if (options.strictCustomWrappers) input=customInput(input);
      else { try { input = JSON.parse(input).input || ''; } catch {} }
      return [{...result, type:'response.custom_tool_call_input.delta',delta:input}, {...result,type:'response.custom_tool_call_input.done',input}];
    }
    if (result.response?.output) result.response = {...result.response,output:result.response.output.map(item=>restoreItem(item,result.type==='response.completed'))};
    return [result];
  }
  return {body, restoreItem, restoreEvent, restoreResponse: response => ({...response,output:response.output?.map(item=>restoreItem(item,response.status==='completed'))})};
}
module.exports = {createAdapter, isGeminiReasoningCarrier};
