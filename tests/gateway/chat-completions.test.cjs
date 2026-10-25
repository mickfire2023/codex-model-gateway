'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {prepareChatRequest, convertChatStream, contentToChat} = require('../../gateway/chat-completions.cjs');

const textMessage = (role, text) => ({type: 'message', role, content: [{type: role === 'assistant' ? 'output_text' : 'input_text', text}]});
const choice = (delta, finish_reason = null) => ({choices: [{index: 0, delta, finish_reason}]});
async function* stream(chunks) { for (const chunk of chunks) { await Promise.resolve(); yield structuredClone(chunk); } }
async function convert(request, chunks) {
  const {payload, adapter} = prepareChatRequest(request);
  const events = [];
  const response = await convertChatStream(stream(chunks), {request, adapter, emit: event => events.push(structuredClone(event))});
  return {payload, response, events};
}
function assertSequences(events) { assert.deepEqual(events.map(event => event.sequence_number), events.map((_event, index) => index)); }
function text(response) { return response.output.filter(item => item.type === 'message').flatMap(item => item.content || []).map(part => part.text || '').join(''); }

test('prepares system/developer/user and mixed UTF-8 text/image content with model options', () => {
  const request = {
    model: 'synthetic-model', instructions: 'Follow the task', input: [
      textMessage('developer', '开发者说明'),
      {type: 'message', role: 'user', content: [{type: 'input_text', text: '猫 😺'}, {type: 'input_image', image_url: 'data:image/png;base64,c3ludGhldGlj', detail: 'low'}]}
    ], max_output_tokens: 123, reasoning: {effort: 'high'}, text: {format: {type: 'json_schema', name: 'result', schema: {type: 'object'}, strict: true}}
  };
  const original = structuredClone(request);
  const {payload} = prepareChatRequest(request);
  assert.deepEqual(payload.messages, [
    {role: 'system', content: 'Follow the task'}, {role: 'system', content: '开发者说明'},
    {role: 'user', content: [{type: 'text', text: '猫 😺'}, {type: 'image_url', image_url: {url: 'data:image/png;base64,c3ludGhldGlj', detail: 'low'}}]}
  ]);
  assert.equal(payload.model, request.model); assert.equal(payload.max_tokens, 123);
  assert.equal(payload.reasoning_effort, 'high'); assert.equal(payload.stream_options.include_usage, true);
  assert.deepEqual(payload.response_format, {type: 'json_schema', json_schema: {name: 'result', schema: {type: 'object'}, strict: true}});
  assert.deepEqual(request, original);
});

test('streaming text preserves Unicode, emits the Responses lifecycle in order and maps usage', async () => {
  const result = await convert({model: 'synthetic-model', input: 'Say hello'}, [
    choice({role: 'assistant'}), choice({content: '你好'}), choice({content: '，世界 🌍\n'}), choice({content: 'こんにちは'}),
    choice({}, 'stop'), {choices: [], usage: {prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, prompt_tokens_details: {cached_tokens: 3}, completion_tokens_details: {reasoning_tokens: 2}}}
  ]);
  assert.equal(text(result.response), '你好，世界 🌍\nこんにちは');
  assert.equal(result.response.status, 'completed'); assert.equal(result.response.model, 'synthetic-model');
  assert.deepEqual(result.events.map(event => event.type), [
    'response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added',
    'response.output_text.delta', 'response.output_text.delta', 'response.output_text.delta',
    'response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed'
  ]);
  assert.deepEqual(result.response.usage, {input_tokens: 12, output_tokens: 8, total_tokens: 20, input_tokens_details: {cached_tokens: 3}, output_tokens_details: {reasoning_tokens: 2}});
  assert.deepEqual(result.events.at(-1).response, result.response); assertSequences(result.events);
});

test('namespace function definitions, forced choice and split argument chunks restore the original identity', async () => {
  const request = {
    model: 'synthetic-model', input: 'Read the synthetic file',
    tools: [{type: 'namespace', name: 'files', tools: [{type: 'function', name: 'read', description: 'Read a file', parameters: {type: 'object', properties: {path: {type: 'string'}}}}]}],
    tool_choice: {type: 'function', name: 'read', namespace: 'files'}, parallel_tool_calls: true
  };
  const {payload, adapter} = prepareChatRequest(request);
  const alias = payload.tools[0].function.name;
  assert.notEqual(alias, 'read'); assert.equal(payload.tool_choice.function.name, alias); assert.equal(payload.parallel_tool_calls, true);
  const events = [];
  const response = await convertChatStream(stream([
    choice({tool_calls: [{index: 0, id: 'synthetic-function-call', type: 'function', function: {name: alias, arguments: '{"path":'}}]}),
    choice({tool_calls: [{index: 0, function: {arguments: '"测试.txt"}'}}]}), choice({}, 'tool_calls')
  ]), {request, adapter, emit: event => events.push(structuredClone(event))});
  assert.equal(response.output.length, 1);
  assert.deepEqual({...response.output[0], id: undefined}, {type: 'function_call', id: undefined, call_id: 'synthetic-function-call', name: 'read', namespace: 'files', arguments: '{"path":"测试.txt"}', status: 'completed'});
  assert.equal(events.find(event => event.type === 'response.output_item.added').item.namespace, 'files');
  assert.equal(events.find(event => event.type === 'response.function_call_arguments.done').arguments, '{"path":"测试.txt"}');
  assertSequences(events);
});

test('custom apply_patch encodes into a JSON wrapper, restores raw patch and accepts a tool follow-up', async () => {
  const patch = '*** Begin Patch\n*** Add File: 测试.txt\n+你好 🌏\n*** End Patch';
  const request = {model: 'synthetic-model', input: 'Apply patch', tools: [{type: 'custom', name: 'apply_patch', namespace: 'workspace', description: 'Patch files'}], tool_choice: {type: 'custom', name: 'apply_patch', namespace: 'workspace'}};
  const {payload, adapter} = prepareChatRequest(request);
  const alias = payload.tools[0].function.name;
  assert.equal(payload.tool_choice.function.name, alias);
  assert.equal(payload.tools[0].type, 'function');
  assert.deepEqual(payload.tools[0].function.parameters.required, ['input']);
  const argumentsText = JSON.stringify({input: patch});
  const events = [];
  const response = await convertChatStream(stream([
    choice({tool_calls: [{index: 0, id: 'synthetic-patch-call', function: {name: alias, arguments: argumentsText.slice(0, 25)}}]}),
    choice({tool_calls: [{index: 0, function: {arguments: argumentsText.slice(25)}}]}), choice({}, 'tool_calls')
  ]), {request, adapter, emit: event => events.push(structuredClone(event))});
  assert.equal(response.output[0].type, 'custom_tool_call'); assert.equal(response.output[0].name, 'apply_patch');
  assert.equal(response.output[0].namespace, 'workspace'); assert.equal(response.output[0].input, patch); assert.equal(response.output[0].arguments, undefined);
  assert.equal(events.find(event => event.type === 'response.custom_tool_call_input.done').input, patch);
  assert.equal(events.some(event => event.type === 'response.function_call_arguments.delta'), false);
  assertSequences(events);
  const follow = prepareChatRequest({...request, input: [textMessage('user', 'Apply patch'), ...response.output, {type: 'custom_tool_call_output', call_id: 'synthetic-patch-call', output: 'Applied successfully'}]}).payload;
  assert.equal(follow.messages[1].tool_calls[0].id, 'synthetic-patch-call');
  assert.equal(follow.messages[1].tool_calls[0].function.name, alias);
  assert.equal(JSON.parse(follow.messages[1].tool_calls[0].function.arguments).input, patch);
  assert.deepEqual(follow.messages[2], {role: 'tool', tool_call_id: 'synthetic-patch-call', content: 'Applied successfully'});
});

test('long and colliding-looking tool names encode stably to valid distinct names of at most 64 characters', () => {
  const namespace = 'very_long_namespace_'.repeat(7);
  const request = {model: 'synthetic-model', input: [], tools: [
    {type: 'function', namespace, name: 'name_'.repeat(40) + 'a'},
    {type: 'function', namespace, name: 'name_'.repeat(40) + 'b'},
    {type: 'custom', namespace, name: 'apply_patch'}
  ]};
  const aliases = prepareChatRequest(request).payload.tools.map(tool => tool.function.name);
  assert.deepEqual(prepareChatRequest(request).payload.tools.map(tool => tool.function.name), aliases);
  assert.equal(new Set(aliases).size, aliases.length);
  for (const alias of aliases) assert.match(alias, /^[A-Za-z0-9_-]{1,64}$/);
});

test('multiple interleaved tool calls preserve separate IDs/arguments and ordered output indexes', async () => {
  const request = {model: 'synthetic-model', input: [], tools: [{type: 'function', name: 'first'}, {type: 'function', name: 'second'}]};
  const result = await convert(request, [
    choice({content: 'I will use two tools.'}),
    choice({tool_calls: [{index: 1, id: 'second-id', function: {name: 'second', arguments: '{"b":'}}, {index: 0, id: 'first-id', function: {name: 'first', arguments: '{"a":'}}]}),
    choice({tool_calls: [{index: 0, function: {arguments: '1}'}}, {index: 1, function: {arguments: '2}'}}]}), choice({}, 'tool_calls')
  ]);
  assert.equal(result.response.output.length, 3);
  assert.deepEqual(result.response.output.slice(1).map(item => [item.call_id, item.name, item.arguments]), [['first-id', 'first', '{"a":1}'], ['second-id', 'second', '{"b":2}']]);
  assert.deepEqual(result.events.filter(event => event.type === 'response.output_item.added').map(event => event.output_index), [0, 1, 2]);
  assertSequences(result.events);
});

test('length and content-filter text truncation emit incomplete responses', async () => {
  for (const [finish, reason] of [['length', 'max_output_tokens'], ['content_filter', 'content_filter']]) {
    const result = await convert({model: 'synthetic-model', input: []}, [choice({content: 'Partial answer'}), choice({}, finish)]);
    assert.equal(result.response.status, 'incomplete'); assert.deepEqual(result.response.incomplete_details, {reason});
    assert.equal(result.events.at(-1).type, 'response.incomplete'); assert.equal(text(result.response), 'Partial answer');
    assert.equal(result.events.some(event => event.type === 'response.completed'), false); assertSequences(result.events);
  }
});

test('truncated tool calls never become completed executable tool items', async () => {
  const request = {model: 'synthetic-model', input: [], tools: [{type: 'custom', name: 'apply_patch'}]};
  const {payload, adapter} = prepareChatRequest(request); const events = [];
  const response = await convertChatStream(stream([
    choice({tool_calls: [{index: 0, id: 'partial-patch', function: {name: payload.tools[0].function.name, arguments: '{"input":"*** Begin Patch'}}]}), choice({}, 'length')
  ]), {request, adapter, emit: event => events.push(structuredClone(event))});
  assert.equal(response.status, 'incomplete');
  assert.equal(response.output.some(item => ['function_call', 'custom_tool_call'].includes(item.type) && item.status === 'completed'), false);
  assert.equal(events.some(event => ['response.function_call_arguments.done', 'response.custom_tool_call_input.done'].includes(event.type)), false);
});

test('upstream errors, iterator errors and premature EOF never manufacture a successful completion', async () => {
  const request = {model: 'synthetic-model', input: []};
  for (const chunks of [stream([choice({content: 'partial'}), {error: {message: 'synthetic upstream error', code: 'synthetic_error'}}]), stream([choice({content: 'partial'})]), (async function* () { yield choice({content: 'partial'}); throw new Error('synthetic transport failure'); })()]) {
    const {adapter} = prepareChatRequest(request); const events = [];
    await assert.rejects(convertChatStream(chunks, {request, adapter, emit: event => events.push(event)}), /synthetic|正常结束/);
    assert.equal(events.some(event => event.type === 'response.completed' || event.type === 'response.incomplete'), false);
  }
});

test('tool calls with missing names or invalid indexes fail explicitly', async () => {
  for (const tool of [{index: 'zero', id: 'bad', function: {name: 'fn', arguments: '{}'}}, {index: 0, id: 'bad', function: {arguments: '{}'}}]) {
    await assert.rejects(convert({model: 'synthetic-model', input: []}, [choice({tool_calls: [tool]}), choice({}, 'tool_calls')]), error => error.code === 'invalid_tool_call');
  }
});

test('unsupported file/program inputs fail explicitly and refusal text is preserved', () => {
  assert.throws(() => contentToChat([{type: 'input_file', file_id: 'synthetic-file'}]), error => error.code === 'unsupported_attachment');
  assert.throws(() => prepareChatRequest({model: 'synthetic-model', input: [{type: 'program_call', id: 'synthetic-program'}]}), error => error.code === 'history_migration_required');
  assert.equal(contentToChat([{type: 'refusal', refusal: 'I cannot perform that action.'}]), 'I cannot perform that action.');
});

test('streamed refusal text remains visible rather than completing an empty response', async () => {
  const result = await convert({model: 'synthetic-model', input: 'A synthetic request'}, [
    choice({refusal: 'I cannot '}), choice({refusal: 'perform that action.'}), choice({}, 'stop')
  ]);
  const visible = result.response.output.flatMap(item => item.content || []).map(part => part.text || part.refusal || '').join('');
  assert.equal(visible, 'I cannot perform that action.');
  assert.equal(result.events.some(event => ['response.refusal.delta', 'response.output_text.delta'].includes(event.type)), true);
  assertSequences(result.events);
});

test('credentials and local routing metadata are not serialized into upstream payloads or output events', async () => {
  const request = {model: 'synthetic-model', input: 'Public user prompt', authorization: 'Bearer synthetic-private-client-token', headers: {'x-api-key': 'synthetic-private-destination-token'}, metadata: {secret: 'synthetic-private-metadata'}, client_metadata: {thread_id: 'synthetic-private-thread'}, stream_id: 'lane-synthetic'};
  const result = await convert(request, [choice({content: 'Public response'}), choice({}, 'stop')]);
  assert.doesNotMatch(JSON.stringify(result.payload), /synthetic-private|authorization|x-api-key|stream_id/);
  assert.doesNotMatch(JSON.stringify(result.events), /synthetic-private|authorization|x-api-key/);
  assert.equal(result.response.model, request.model);
});

test('completed custom tools require a full JSON wrapper with a string input', async () => {
  const request = {model: 'synthetic-model', input: [], tools: [{type: 'custom', name: 'apply_patch'}]};
  for (const argumentsText of ['{"input":"partial', '{}', '{"input":42}', '{"input":null}', '{"input":{"nested":"object"}}', 'null', '[]', '"raw patch"']) {
    const {payload, adapter} = prepareChatRequest(request); const events = [];
    await assert.rejects(convertChatStream(stream([
      choice({tool_calls: [{index: 0, id: 'invalid-wrapper', function: {name: payload.tools[0].function.name, arguments: argumentsText}}]}), choice({}, 'tool_calls')
    ]), {request, adapter, emit: event => events.push(structuredClone(event))}), error => error.code === 'invalid_tool_call' && /完整 JSON/.test(error.message));
    assert.equal(events.some(event => event.type === 'response.output_item.done' || event.type === 'response.custom_tool_call_input.done' || event.type === 'response.completed'), false);
  }
  const {payload, adapter} = prepareChatRequest(request); const events = [];
  const response = await convertChatStream(stream([
    choice({tool_calls: [{index: 0, id: 'empty-string-is-valid', function: {name: payload.tools[0].function.name, arguments: '{"input":""}'}}]}), choice({}, 'tool_calls')
  ]), {request, adapter, emit: event => events.push(structuredClone(event))});
  assert.equal(response.output[0].type, 'custom_tool_call'); assert.equal(response.output[0].input, '');
  assertSequences(events);
});

test('all custom wrappers validate before any other completed tool item is emitted', async () => {
  const request = {model: 'synthetic-model', input: [], tools: [{type: 'function', name: 'ordinary'}, {type: 'custom', name: 'apply_patch'}]};
  const {payload, adapter} = prepareChatRequest(request); const events = [];
  await assert.rejects(convertChatStream(stream([
    choice({tool_calls: [
      {index: 0, id: 'valid-ordinary', function: {name: 'ordinary', arguments: '{"x":1}'}},
      {index: 1, id: 'invalid-custom', function: {name: payload.tools[1].function.name, arguments: '{"input":false}'}}
    ]}), choice({}, 'tool_calls')
  ]), {request, adapter, emit: event => events.push(structuredClone(event))}), error => error.code === 'invalid_tool_call');
  assert.equal(events.some(event => event.type === 'response.function_call_arguments.done' || event.type === 'response.custom_tool_call_input.done' || event.type === 'response.output_item.done'), false);
});

test('ordinary function arguments are retained verbatim and strict true/false pass through', async () => {
  const request = {model: 'synthetic-model', input: [], tools: [{type: 'function', name: 'ordinary', strict: true}, {type: 'function', name: 'other', strict: false}]};
  const result = await convert(request, [choice({tool_calls: [{index: 0, id: 'ordinary-call', function: {name: 'ordinary', arguments: 'verbatim non-JSON function argument'}}]}), choice({}, 'tool_calls')]);
  assert.equal(result.response.output[0].arguments, 'verbatim non-JSON function argument');
  assert.equal(result.payload.tools[0].function.strict, true); assert.equal(result.payload.tools[1].function.strict, false);
});

test('both length and content filter omit partial tools and mark visible message content incomplete', async () => {
  for (const finish of ['length', 'content_filter']) {
    const result = await convert({model: 'synthetic-model', input: [], tools: [{type: 'function', name: 'ordinary'}]}, [
      choice({content: 'Partial visible text', tool_calls: [{index: 0, id: 'partial-function', function: {name: 'ordinary', arguments: '{"partial":'}}]}), choice({}, finish)
    ]);
    assert.equal(result.response.status, 'incomplete');
    assert.equal(result.response.output.length, 1); assert.equal(result.response.output[0].type, 'message'); assert.equal(result.response.output[0].status, 'incomplete');
    assert.equal(result.events.some(event => event.type === 'response.function_call_arguments.done'), false);
    assertSequences(result.events);
  }
});

function browserCall(id) {
  return {type: 'function_call', name: 'take_screenshot', namespace: 'synthetic_browser', call_id: id, arguments: '{}'};
}
function browserRequest(input) {
  return {model: 'synthetic-model', input, tools: [{type: 'function', name: 'take_screenshot', namespace: 'synthetic_browser', parameters: {type: 'object', properties: {}}}]};
}
function assertCompleteToolBatches(messages) {
  const pending = new Set();
  for (const message of messages) {
    if (message.role === 'tool') {
      assert(pending.delete(message.tool_call_id), 'each tool result must match an outstanding assistant call');
      assert(typeof message.content === 'string' || message.content.every(part => part.type === 'text'), 'Chat tool messages permit text only');
    } else {
      assert.equal(pending.size, 0, 'all parallel tool results must precede any image observation or next message');
      for (const call of message.tool_calls || []) pending.add(call.id);
    }
  }
  assert.equal(pending.size, 0);
}

test('mixed browser screenshot results retain tool text and attach lossless images as attributed user observations', () => {
  const id = 'synthetic-screenshot-call';
  const image = 'data:image/png;base64,c3ludGhldGlj';
  const remote = 'https://images.synthetic.invalid/shot.png?variant=%2B+%2F#synthetic';
  const request = browserRequest([textMessage('user', 'Inspect the synthetic page'), browserCall(id),
    {type: 'function_call_output', call_id: id, output: [
      {type: 'input_text', text: 'Synthetic page heading: 测试 🧪'},
      {type: 'input_image', image_url: image, detail: 'low'},
      {type: 'input_text', text: 'Synthetic capture complete'},
      {type: 'input_image', image_url: remote, detail: 'high'}
    ]}]);
  const before = structuredClone(request);
  const {payload} = prepareChatRequest(request);
  assertCompleteToolBatches(payload.messages);
  const output = payload.messages.find(message => message.role === 'tool');
  assert.equal(output.tool_call_id, id);
  assert.match(output.content, /Synthetic page heading: 测试 🧪/);
  assert.match(output.content, /Synthetic capture complete/);
  const observation = payload.messages.at(-1);
  assert.equal(observation.role, 'user');
  assert(observation.content.some(part => part.type === 'text' && part.text.includes(id)));
  assert.deepEqual(observation.content.filter(part => part.type === 'image_url').map(part => part.image_url), [
    {url: image, detail: 'low'}, {url: remote, detail: 'high'}
  ]);
  assert.deepEqual(request, before);
});

test('image-only browser result has an explicit tool placeholder and exactly one attributed image', () => {
  const id = 'synthetic-image-only';
  const image = 'data:image/png;base64,c3ludGhldGlj';
  const {payload} = prepareChatRequest(browserRequest([browserCall(id),
    {type: 'function_call_output', call_id: id, output: [{type: 'input_image', image_url: image}]}]));
  assertCompleteToolBatches(payload.messages);
  const output = payload.messages.find(message => message.role === 'tool');
  assert.equal(typeof output.content, 'string');
  assert.match(output.content, /image/i); assert(output.content.includes(id));
  const observation = payload.messages.at(-1);
  assert.equal(observation.role, 'user');
  assert(observation.content.some(part => part.type === 'text' && part.text.includes(id)));
  assert.equal(observation.content.filter(part => part.type === 'image_url').length, 1);
  assert.equal(observation.content.find(part => part.type === 'image_url').image_url.url, image);
});

test('parallel browser screenshot outputs stay consecutive before their associated image observations', () => {
  const first = 'synthetic-parallel-first', second = 'synthetic-parallel-second';
  const images = ['data:image/png;base64,c3ludGhldGljLWZpcnN0', 'data:image/png;base64,c3ludGhldGljLXNlY29uZA=='];
  const {payload} = prepareChatRequest(browserRequest([browserCall(first), browserCall(second),
    {type: 'function_call_output', call_id: first, output: [{type: 'input_image', image_url: images[0]}]},
    {type: 'reasoning', content: [{type: 'reasoning_text', text: 'Synthetic ignored history'}]},
    {type: 'function_call_output', call_id: second, output: [{type: 'input_image', image_url: images[1]}]}]));
  assertCompleteToolBatches(payload.messages);
  assert.deepEqual(payload.messages.map(message => message.role), ['assistant', 'tool', 'tool', 'user']);
  assert.deepEqual(payload.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), [first, second]);
  const observation = payload.messages.at(-1).content;
  const imageIndexes = observation.flatMap((part, index) => part.type === 'image_url' ? [index] : []);
  assert.equal(imageIndexes.length, 2);
  for (const [index, callId, image] of [[imageIndexes[0], first, images[0]], [imageIndexes[1], second, images[1]]]) {
    assert.equal(observation[index - 1].type, 'text');
    assert(observation[index - 1].text.includes(callId));
    assert.equal(observation[index].image_url.url, image);
  }
});

test('image observations follow the whole tool batch and precede a later real user message without changing plain tool output', () => {
  const first = 'synthetic-image-result', second = 'synthetic-text-result';
  const {payload} = prepareChatRequest(browserRequest([textMessage('user', 'Inspect'), browserCall(first), browserCall(second),
    {type: 'function_call_output', call_id: first, output: [{type: 'input_image', image_url: 'data:image/png;base64,c3ludGhldGlj'}]},
    {type: 'function_call_output', call_id: second, output: 'Unchanged plain tool result 🧪'},
    textMessage('user', 'Now continue with my next request.')]));
  assertCompleteToolBatches(payload.messages);
  assert.deepEqual(payload.messages.map(message => message.role), ['user', 'assistant', 'tool', 'tool', 'user', 'user']);
  assert.equal(payload.messages[3].content, 'Unchanged plain tool result 🧪');
  assert(payload.messages[4].content.some(part => part.type === 'image_url'));
  assert.equal(payload.messages[5].content, 'Now continue with my next request.');
});

test('mixed screenshot results containing a file attachment still fail explicitly without mutating the caller', () => {
  const request = browserRequest([browserCall('synthetic-file-result'),
    {type: 'function_call_output', call_id: 'synthetic-file-result', output: [
      {type: 'input_image', image_url: 'data:image/png;base64,c3ludGhldGlj'},
      {type: 'input_file', file_id: 'synthetic-file-id'}
    ]}]);
  const before = structuredClone(request);
  assert.throws(() => prepareChatRequest(request), error => error.code === 'unsupported_attachment');
  assert.deepEqual(request, before);
});
