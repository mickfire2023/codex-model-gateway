'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {createProviderRunner} = require('../../gateway/provider-runner.cjs');
const {makeModelSlug} = require('../../gateway/provider-store.cjs');
const {expandLocalCompactions} = require('../../gateway/compaction.cjs');

const RESPONSE_ID = 'vendor/responses+模型';
const CHAT_ID = 'vendor:chat@2026';
const RESPONSE_SLUG = makeModelSlug('synthetic-responses', RESPONSE_ID);
const CHAT_SLUG = makeModelSlug('synthetic-chat', CHAT_ID);
const SECRET = 'synthetic-compaction-secret-only';
const msg = (role, text) => ({type: 'message', role, content: [{type: role === 'assistant' ? 'output_text' : 'input_text', text}]});
const chatChoice = (delta, finish_reason = null) => ({choices: [{index: 0, delta, finish_reason}]});
const complete = (output = [msg('assistant', 'Synthetic visible answer')], model = RESPONSE_ID) => ({type: 'response.completed', response: {id: 'synthetic-upstream-response', object: 'response', status: 'completed', model, output}});
const caps = overrides => ({inputModalities: ['text'], supportsTools: true, reasoningEfforts: ['none', 'high', 'xhigh'], defaultReasoningEffort: 'high', maxOutputTokens: 400, ...overrides});

function fixture(options = {}) {
  const observed = {requests: [], lookups: [], logs: [], readBodies: 0};
  const targets = {
    [RESPONSE_SLUG]: {url: new URL('https://responses.synthetic.invalid/v1/responses'), headers: {authorization: 'Bearer synthetic-responses-key', 'content-type': 'application/json'}, protocol: 'responses', modelId: RESPONSE_ID, model: caps(options.responseCaps)},
    [CHAT_SLUG]: {url: new URL('https://chat.synthetic.invalid/v1/chat/completions'), headers: {authorization: 'Bearer synthetic-chat-key', 'content-type': 'application/json'}, protocol: 'chat_completions', modelId: CHAT_ID, model: caps(options.chatCaps)}
  };
  const providers = {upstreamForSlug(slug) {
    observed.lookups.push(slug); const target = targets[slug]; assert.ok(target, 'Unknown synthetic model slug: ' + slug);
    return {...target, headers: {...target.headers}, model: structuredClone(target.model)};
  }};
  const runner = createProviderRunner({
    providers, deepseekBase: 'https://deepseek.synthetic.invalid', getDeepseekKey: () => options.deepseekKey === undefined ? 'synthetic-deepseek-key' : options.deepseekKey, secret: SECRET,
    async requestUpstream(url, requestOptions, payload) {
      const body = JSON.parse(payload.toString());
      const record = {url: url.href, options: {...requestOptions, headers: {...requestOptions.headers}}, body, payload: payload.toString()};
      observed.requests.push(record);
      assert.equal(Number(requestOptions.headers['content-length']), Buffer.byteLength(payload));
      if (options.respond) return options.respond(record, observed.requests.length);
      return {statusCode: 200, frames: url.pathname.endsWith('/chat/completions') ? [chatChoice({content: 'Synthetic visible answer'}), chatChoice({}, 'stop')] : [complete()]};
    },
    async readBody(upstream) { observed.readBodies++; return Buffer.from(upstream.body || ''); },
    async *events(upstream) {
      for (const frame of upstream.frames || []) { await Promise.resolve(); yield structuredClone(frame); }
      if (upstream.streamError) throw upstream.streamError;
    },
    log: entry => observed.logs.push(structuredClone(entry)),
    legacyCustomInstructions: options.legacyCustomInstructions || []
  });
  async function run(model, extra = {}, callOptions = {}) {
    const events = [];
    const request = {type: 'response.create', model, input: [msg('user', 'Synthetic public prompt')], ...extra};
    const response = await runner.run({route: {provider: model === 'deepseek-chat' ? 'deepseek' : model === CHAT_SLUG ? 'custom:synthetic-chat' : 'custom:synthetic-responses'}, request, emit: event => events.push(structuredClone(event)), ...callOptions});
    return {request, response, events};
  }
  return {runner, run, observed, targets};
}

test('custom Responses and Chat use only their own credentials and map real IDs back to catalog slugs', async () => {
  const f = fixture();
  for (const [slug, realId, key] of [[RESPONSE_SLUG, RESPONSE_ID, 'synthetic-responses-key'], [CHAT_SLUG, CHAT_ID, 'synthetic-chat-key']]) {
    const result = await f.run(slug, {}, {headers: {authorization: 'Bearer synthetic-chatgpt-credential', cookie: 'synthetic-chatgpt-cookie', 'chatgpt-account-id': 'synthetic-account'}});
    const upstream = f.observed.requests.at(-1);
    assert.equal(upstream.body.model, realId); assert.equal(upstream.options.headers.authorization, 'Bearer ' + key);
    assert.equal(upstream.options.headers.cookie, undefined); assert.equal(upstream.options.headers['chatgpt-account-id'], undefined);
    assert.equal(upstream.options.method, 'POST'); assert.equal(upstream.body.stream, true);
    assert.equal(result.response.model, slug);
    assert.equal(result.events.filter(event => event.response).every(event => event.response.model === slug), true);
    assert.doesNotMatch(JSON.stringify(result.events), /synthetic-.*-key|synthetic-chatgpt/);
    assert.doesNotMatch(upstream.payload, /synthetic-chatgpt/);
  }
  assert.deepEqual(f.observed.lookups, [RESPONSE_SLUG, CHAT_SLUG]);
});

test('DeepSeek uses its dedicated key, preserves its route and fails before transport when key is missing', async () => {
  const f = fixture(); const controller = new AbortController();
  const result = await f.run('deepseek-chat', {}, {headers: {authorization: 'Bearer synthetic-chatgpt-credential'}, signal: controller.signal});
  assert.equal(f.observed.requests[0].url, 'https://deepseek.synthetic.invalid/responses');
  assert.equal(f.observed.requests[0].options.headers.authorization, 'Bearer synthetic-deepseek-key');
  assert.equal(f.observed.requests[0].options.signal, controller.signal);
  assert.equal(result.response.model, 'deepseek-chat'); assert.equal(f.observed.lookups.length, 0);
  const absent = fixture({deepseekKey: ''});
  await assert.rejects(absent.run('deepseek-chat'), error => error.code === 'deepseek_key_missing');
  assert.equal(absent.observed.requests.length, 0);
});

test('generate:false finishes a local warmup without provider lookups, quota or transport',async()=>{
  for(const slug of [RESPONSE_SLUG,CHAT_SLUG,'deepseek-chat']){
    const f=fixture(),result=await f.run(slug,{generate:false,input:[]});
    assert.equal(f.observed.requests.length,0);assert.equal(f.observed.lookups.length,0);
    assert.equal(result.response.status,'completed');assert.deepEqual(result.response.output,[]);
    assert.deepEqual(result.response.usage,{input_tokens:0,output_tokens:0,total_tokens:0});
    assert.deepEqual(result.events.map(x=>x.type),['response.created','response.completed']);
    assert.match(result.response.id,/^resp_gateway_warmup_/);
  }
});

test('only validated retry advice and a known Gemini cooldown code reach the public error',async()=>{
  const f=fixture({respond:()=>({statusCode:429,headers:{'retry-after':'91'},body:JSON.stringify({error:{code:'model_cooldown',message:'private prompt synthetic-key'}})})});
  f.targets[RESPONSE_SLUG].providerId='gemini-subscription';
  await assert.rejects(f.run(RESPONSE_SLUG),error=>error.status===429&&error.code==='gemini_model_cooldown'&&error.retryAfterSeconds===91&&!error.message.includes('private prompt'));
  const unsafe=fixture({respond:()=>({statusCode:429,headers:{'retry-after':'synthetic-private-header'},body:'private prompt'})});
  await assert.rejects(unsafe.run(RESPONSE_SLUG),error=>error.retryAfterSeconds===undefined&&!error.message.includes('private prompt'));
});

test('cached Gemini sessions migrate only the exact inherited provider template and retain user instructions',async()=>{
  const legacy='Synthetic old provider-specific instructions',own='Synthetic user/developer requirements';
  const f=fixture({legacyCustomInstructions:[legacy]});f.targets[RESPONSE_SLUG].providerId='gemini-subscription';
  await f.run(RESPONSE_SLUG,{instructions:legacy,input:[msg('system',legacy),msg('developer',own),msg('user',legacy)]});
  const body=f.observed.requests[0].body;assert.match(body.instructions,/helpful coding assistant/);assert.match(body.input[0].content[0].text,/helpful coding assistant/);assert.equal(body.input[1].content[0].text,own);assert.equal(body.input[2].content[0].text,legacy);
  const other=fixture({legacyCustomInstructions:[legacy]});await other.run(RESPONSE_SLUG,{instructions:legacy,input:[msg('system',legacy)]});assert.equal(other.observed.requests[0].body.instructions,legacy);assert.equal(other.observed.requests[0].body.input[0].content[0].text,legacy);
});

test('capability limits clamp output tokens, provide defaults and remove unsupported tool controls', async () => {
  const f = fixture({responseCaps: {maxOutputTokens: 72, supportsTools: false}, chatCaps: {maxOutputTokens: 91, supportsTools: false}});
  for (const [slug, field, maximum] of [[RESPONSE_SLUG, 'max_output_tokens', 72], [CHAT_SLUG, 'max_tokens', 91]]) {
    await f.run(slug, {max_output_tokens: 10000, tools: [{type: 'function', name: 'must_be_removed'}], tool_choice: 'required', parallel_tool_calls: true});
    const body = f.observed.requests.at(-1).body;
    assert.equal(body[field], maximum); assert.equal(body.tools, undefined); assert.equal(body.tool_choice, undefined); assert.equal(body.parallel_tool_calls, undefined);
    await f.run(slug); assert.equal(f.observed.requests.at(-1).body[field], maximum);
    await f.run(slug, {max_output_tokens: 17}); assert.equal(f.observed.requests.at(-1).body[field], 17);
  }
});

test('image-disabled models fail before any provider request while configured image input is retained', async () => {
  const imageInput = [{type: 'message', role: 'user', content: [{type: 'input_image', image_url: 'data:image/png;base64,c3ludGhldGlj'}]}];
  const disabled = fixture();
  for (const slug of [RESPONSE_SLUG, CHAT_SLUG]) await assert.rejects(disabled.run(slug, {input: imageInput}), error => error.code === 'unsupported_image_input');
  assert.equal(disabled.observed.requests.length, 0);
  const enabled = fixture({responseCaps: {inputModalities: ['text', 'image']}, chatCaps: {inputModalities: ['text', 'image']}});
  await enabled.run(RESPONSE_SLUG, {input: imageInput}); assert.deepEqual(enabled.observed.requests[0].body.input, imageInput);
  await enabled.run(CHAT_SLUG, {input: imageInput}); assert.equal(enabled.observed.requests[1].body.messages[0].content[0].type, 'image_url');
});

test('configured custom-provider reasoning effort is not remapped by DeepSeek normalization', async () => {
  const f = fixture();
  for (const slug of [RESPONSE_SLUG, CHAT_SLUG]) {
    await f.run(slug, {reasoning: {effort: 'xhigh'}});
    const body = f.observed.requests.at(-1).body;
    assert.equal(slug === CHAT_SLUG ? body.reasoning_effort : body.reasoning.effort, 'xhigh');
  }
});

test('Antigravity forwards each advertised Gemini effort and uses its model default for stale selections', async () => {
  const f = fixture({responseCaps: {reasoningEfforts: ['minimal', 'low', 'medium', 'high'], defaultReasoningEffort: 'medium'}});
  f.targets[RESPONSE_SLUG].providerId = 'gemini-subscription';
  for (const effort of ['minimal', 'low', 'medium', 'high']) {
    await f.run(RESPONSE_SLUG, {reasoning: {effort}});
    assert.deepEqual(f.observed.requests.at(-1).body.reasoning, {effort});
  }
  for (const extra of [{}, {reasoning: {effort: 'xhigh'}}, {reasoning: {effort: 'none'}}]) {
    await f.run(RESPONSE_SLUG, extra);
    assert.deepEqual(f.observed.requests.at(-1).body.reasoning, {effort: 'medium'});
  }
});

test('Antigravity Claude forwards each selected effort without stripping its literal model ID and defaults to medium', async () => {
  for (const modelId of ['claude-sonnet-5-5-high','claude-opus-5-5-high']) {
    const f = fixture({responseCaps: {reasoningEfforts: ['low','medium','high'], defaultReasoningEffort: 'medium'}});
    Object.assign(f.targets[RESPONSE_SLUG], {providerId: 'gemini-subscription', modelId});
    for (const effort of ['low','medium','high']) {
      await f.run(RESPONSE_SLUG, {reasoning: {effort}});
      assert.deepEqual(f.observed.requests.at(-1).body.reasoning, {effort});
      assert.equal(f.observed.requests.at(-1).body.model, modelId);
    }
    for (const extra of [{}, {reasoning: {effort: 'xhigh'}}, {reasoning: {effort: 'none'}}]) {
      await f.run(RESPONSE_SLUG, extra);
      assert.deepEqual(f.observed.requests.at(-1).body.reasoning, {effort: 'medium'});
      assert.equal(f.observed.requests.at(-1).body.model, modelId);
    }
  }
});

test('local stream lane IDs are not sent as unsupported HTTP Responses fields', async () => {
  const f = fixture();
  for (const slug of [RESPONSE_SLUG, CHAT_SLUG]) {
    await f.run(slug, {stream_id: 'synthetic-local-lane'});
    assert.equal(f.observed.requests.at(-1).body.stream_id, undefined);
  }
});

function toolFrames(body, protocol) {
  const names = protocol === 'chat_completions' ? body.tools.map(tool => tool.function.name) : body.tools.map(tool => tool.name);
  const args = ['{"path":"synthetic.txt"}', JSON.stringify({input: '*** Begin Patch\n*** End Patch'})];
  if (protocol === 'chat_completions') return [chatChoice({tool_calls: names.map((name, index) => ({index, id: 'tool-' + index, function: {name, arguments: args[index]}}))}), chatChoice({}, 'tool_calls')];
  const output = names.map((name, index) => ({type: 'function_call', id: 'item-' + index, call_id: 'tool-' + index, name, arguments: args[index], status: 'completed'}));
  return output.flatMap((item, output_index) => [
    {type: 'response.output_item.added', output_index, item: {...item, status: 'in_progress', arguments: ''}},
    {type: 'response.function_call_arguments.delta', item_id: item.id, output_index, delta: item.arguments},
    {type: 'response.function_call_arguments.done', item_id: item.id, output_index, arguments: item.arguments},
    {type: 'response.output_item.done', output_index, item}
  ]).concat(complete(output));
}

test('Responses and Chat namespace functions/custom apply_patch survive generation and tool follow-up', async () => {
  for (const [slug, protocol] of [[RESPONSE_SLUG, 'responses'], [CHAT_SLUG, 'chat_completions']]) {
    const f = fixture({respond({body}, count) { return {statusCode: 200, frames: count === 1 ? toolFrames(body, protocol) : protocol === 'chat_completions' ? [chatChoice({content: 'Follow-up success'}), chatChoice({}, 'stop')] : [complete([msg('assistant', 'Follow-up success')])]}; }});
    const tools = [{type: 'function', name: 'read', namespace: 'files', parameters: {type: 'object'}}, {type: 'custom', name: 'apply_patch', namespace: 'workspace'}];
    const first = await f.run(slug, {tools});
    assert.equal(first.response.output[0].name, 'read'); assert.equal(first.response.output[0].namespace, 'files');
    assert.equal(first.response.output[1].type, 'custom_tool_call'); assert.equal(first.response.output[1].name, 'apply_patch'); assert.equal(first.response.output[1].namespace, 'workspace');
    assert.equal(first.response.output[1].input, '*** Begin Patch\n*** End Patch');
    assert.deepEqual(first.events.map(event => event.sequence_number), first.events.map((_event, index) => index));
    const followInput = [msg('user', 'Do the task'), ...first.response.output, {type: 'function_call_output', call_id: 'tool-0', output: 'Synthetic file'}, {type: 'custom_tool_call_output', call_id: 'tool-1', output: 'Applied'}];
    await f.run(slug, {tools, input: followInput});
    const body = f.observed.requests[1].body;
    if (protocol === 'responses') {
      assert.equal(body.input[1].type, 'function_call'); assert.equal(body.input[2].type, 'function_call');
      assert.equal(body.input[2].arguments, JSON.stringify({input: '*** Begin Patch\n*** End Patch'}));
      assert.equal(body.input.at(-1).type, 'function_call_output'); assert.equal(body.input.at(-1).call_id, 'tool-1');
    } else {
      assert.deepEqual(body.messages.filter(item => item.role === 'tool').map(item => [item.tool_call_id, item.content]), [['tool-0', 'Synthetic file'], ['tool-1', 'Applied']]);
    }
  }
});

test('generic Responses refuses invalid custom JSON wrappers instead of restoring executable fragments', async () => {
  for (const argumentsText of ['{"input":"partial', '{"input":42}', '{}']) {
    const f = fixture({respond({body}) {
      const item = {type: 'function_call', id: 'bad-item', call_id: 'bad-call', name: body.tools[0].name, arguments: argumentsText, status: 'completed'};
      return {statusCode: 200, frames: [{type: 'response.output_item.done', output_index: 0, item}, complete([item])]};
    }});
    await assert.rejects(f.run(RESPONSE_SLUG, {tools: [{type: 'custom', name: 'apply_patch'}]}), error => error.code === 'invalid_tool_call');
  }
});

test('local compaction summarizes once, hides the summary stream and returns an authenticated expandable summary', async () => {
  for (const [slug, protocol] of [[RESPONSE_SLUG, 'responses'], [CHAT_SLUG, 'chat_completions']]) {
    const f = fixture({respond() { return {statusCode: 200, frames: protocol === 'chat_completions' ? [chatChoice({content: 'Faithful synthetic handoff summary'}), chatChoice({}, 'stop')] : [complete([msg('assistant', 'Faithful synthetic handoff summary')])]}; }});
    const result = await f.run(slug, {compaction_trigger: true, instructions: 'Keep the pending objective', tools: [{type: 'function', name: 'never_during_summary'}]});
    assert.equal(f.observed.requests.length, 1); assert.equal(result.events.length, 5);
    assert.equal(result.response.output[0].type, 'compaction'); assert.match(result.response.output[0].encrypted_content, /^localgw:v1:/);
    const body = f.observed.requests[0].body; assert.equal(body.compaction_trigger, undefined); assert.equal(body.tools, undefined);
    assert.doesNotMatch(JSON.stringify(result.events), /Faithful synthetic handoff summary/);
    const expanded = expandLocalCompactions({input: result.response.output}, SECRET);
    assert.match(expanded.input[0].content[0].text, /Faithful synthetic handoff summary/);
    assert.deepEqual(f.observed.logs.filter(x=>x.event!=='provider_request_started'), [{event: 'context_compacted', provider: protocol === 'chat_completions' ? 'custom:synthetic-chat' : 'custom:synthetic-responses', model: slug}]);
  }
});

test('an incomplete summary cannot be promoted to a completed compaction that loses the remaining context', async () => {
  for (const [slug, protocol] of [[RESPONSE_SLUG, 'responses'], [CHAT_SLUG, 'chat_completions']]) {
    const f = fixture({respond() {
      return {statusCode: 200, frames: protocol === 'chat_completions'
        ? [chatChoice({content: 'Only a partial summary'}), chatChoice({}, 'length')]
        : [{type: 'response.incomplete', response: {id: 'partial-summary', status: 'incomplete', model: RESPONSE_ID, incomplete_details: {reason: 'max_output_tokens'}, output: [msg('assistant', 'Only a partial summary')]}}]};
    }});
    await assert.rejects(f.run(slug, {compaction_trigger: true}), error => error.code === 'compaction_summary_incomplete');
    assert.equal(f.observed.logs.some(entry => entry.event === 'context_compacted'), false);
  }
});

test('HTTP provider errors consume but never expose upstream bodies or synthetic credentials', async () => {
  for (const status of [302, 401, 402, 403, 429, 500]) {
    const f = fixture({respond() { return {statusCode: status, body: 'echo synthetic-responses-key synthetic-chatgpt-credential private prompt'}; }});
    await assert.rejects(f.run(RESPONSE_SLUG), error => error.code === 'provider_http_error' && !/synthetic-|private prompt/.test(error.message));
    assert.equal(f.observed.readBodies, 1);assert.equal(f.observed.logs.length,1);assert.equal(f.observed.logs[0].event,'provider_request_started');assert.doesNotMatch(JSON.stringify(f.observed.logs),/synthetic-responses-key|private prompt/);
  }
});

test('provider response errors and premature/disrupted streams reject without automatic retry', async () => {
  const scenarios = [
    {statusCode: 200, frames: [{type: 'error', error: {message: 'echo synthetic-responses-key'}}]},
    {statusCode: 200, frames: [{type: 'response.failed', response: {error: {message: 'echo synthetic-responses-key'}}}]},
    {statusCode: 200, frames: [{type: 'response.output_text.delta', delta: 'partial'}]},
    {statusCode: 200, frames: [], streamError: new Error('synthetic stream transport error')}
  ];
  for (const scenario of scenarios) {
    const f = fixture({respond() { return scenario; }});
    await assert.rejects(f.run(RESPONSE_SLUG), error => ['provider_response_failed', 'incomplete_upstream_stream'].includes(error.code) || error.message === 'synthetic stream transport error');
    assert.equal(f.observed.requests.length, 1);
  }
  const chat = fixture({respond() { return {statusCode: 200, frames: [chatChoice({content: 'partial'})]}; }});
  await assert.rejects(chat.run(CHAT_SLUG), error => error.code === 'incomplete_upstream_stream'); assert.equal(chat.observed.requests.length, 1);
});
