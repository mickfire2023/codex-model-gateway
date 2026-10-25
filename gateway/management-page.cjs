'use strict';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const list = value => Array.isArray(value) ? value : [];
function localTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '尚无记录';
  return new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Tokyo',hour12:false}) + '（日本时间）';
}

function renderManagement(options = {}) {
  // Accept old parameter names during the gateway upgrade. Credential-bearing
  // properties are never used, including providerDraft.apiKey.
  const {root = '',stats = {},controlCsrf = {},diagnostics = {},validation,providerDraft,lastNotice} = options;
  const providers = list(options.providers);
  const autoCatalog = options.autoCatalog || options.syncStatus;
  const sync = autoCatalog?.providerStatus || autoCatalog?.status || autoCatalog || {};
  const hasKey = options.hasKey ?? options.keyConfigured ?? false;
  const csrf = options.csrf ?? options.csrfToken ?? '';
  const refreshCsrf = autoCatalog?.csrf ?? options.refreshCsrfToken ?? '';
  const url = action => escape(`${root}/settings/${action}`);
  const hidden = (name,value) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`;
  const token = action => hidden('csrf_token',controlCsrf[action] || '');
  const button = (label,action,style = '') => `<button type="submit"${style ? ` class="${escape(style)}"` : ''}${controlCsrf[action] ? '' : ' disabled'}>${escape(label)}</button>`;
  const number = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value).toLocaleString('zh-CN') : '0';
  const modelMap = new Map();
  for (const model of [...list(options.catalog?.models),...list(autoCatalog?.models)]) {
    if (model && typeof model.slug === 'string' && !['hide','hidden'].includes(model.visibility)) modelMap.set(model.slug,model);
  }
  for (const provider of providers) for (const model of list(provider.models)) {
    if (typeof model.slug === 'string' && !modelMap.has(model.slug)) modelMap.set(model.slug,{slug:model.slug,display_name:`${model.displayName || model.id} · ${provider.name}`});
  }
  const models = [...modelMap.values()];
  const official = models.filter(model=>!model.slug.startsWith('custom/'));
  const customCount = providers.reduce((count,provider)=>count+list(provider.models).length,0);

  function notices() {
    const notice = typeof lastNotice === 'string' ? {message:lastNotice} : lastNotice;
    if (notice?.message) return `<div class="notice ${['error','failed'].includes(notice.type) ? 'error' : notice.type === 'success' ? 'success' : ''}" role="status">${escape(notice.message)}</div>`;
    return `${options.saved ? '<div class="notice success" role="status">密钥已加密保存，立即生效。</div>' : ''}${options.refreshed ? '<div class="notice success" role="status">已完成模型列表检查，结果见下方。</div>' : ''}`;
  }

  function modelFields(source = {}) {
    const first = list(source.models)[0] || {};
    const field = name => source[name] ?? first[name] ?? '';
    const image = source.inputImage === true || source.inputImage === 'on' || list(field('inputModalities')).includes('image');
    const tools = field('supportsTools') === true || field('supportsTools') === 'on';
    const efforts = field('reasoningEfforts');
    return `<div class="form-grid">
      <label>模型 ID<input name="modelId" value="${escape(source.modelId ?? first.id ?? '')}" required maxlength="512" autocomplete="off" spellcheck="false" placeholder="服务商提供的准确模型 ID"><small>可以包含斜杠，请按服务商模型列表填写。</small></label>
      <label>模型展示名称<input name="displayName" value="${escape(field('displayName'))}" required maxlength="200" placeholder="你在模型选择器中看到的名称"></label>
      <label>上下文长度（token）<input name="contextWindow" type="number" min="1" max="100000000" step="1" value="${escape(field('contextWindow'))}" required placeholder="按服务商文档填写"></label>
      <label>最大输出长度（token）<input name="maxOutputTokens" type="number" min="1" max="100000000" step="1" value="${escape(field('maxOutputTokens'))}" required placeholder="按服务商文档填写"></label>
    </div><fieldset><legend>模型能力</legend>
      <label class="check"><input name="supportsTools" type="checkbox" value="on"${tools ? ' checked' : ''}>支持工具调用</label>
      <label class="check"><input name="inputImage" type="checkbox" value="on"${image ? ' checked' : ''}>支持图像输入</label>
      <p class="hint">所有模型均按支持文本处理。只有服务商明确支持的能力才勾选；未勾选表示不支持。</p>
      <label>推理档位<input name="reasoningEfforts" value="${escape(Array.isArray(efforts) ? efforts.join(',') : efforts)}" required maxlength="200" spellcheck="false" placeholder="无推理填 none；例如 low,medium,high"><small>使用英文逗号分隔，填写服务商实际支持的档位。第一项为默认档位。</small></label>
    </fieldset>`;
  }

  function providerForm(provider,draft) {
    const source = draft || provider || {};
    const existing = !!provider;
    const protocol = source.protocol || provider?.protocol || 'responses';
    return `<form class="stack" method="post" action="${url('provider-save')}">
      ${token('provider-save')}${hidden('id',source.id || provider?.id || '')}
      <div class="form-grid"><label>服务商名称<input name="name" value="${escape(source.name ?? provider?.name ?? '')}" required maxlength="200" placeholder="例如：我的模型服务商"></label><label>接口协议<select name="protocol"><option value="responses"${protocol === 'responses' ? ' selected' : ''}>Responses</option><option value="chat_completions"${protocol === 'chat_completions' ? ' selected' : ''}>Chat Completions</option></select></label></div>
      <label>API 地址<input name="baseUrl" type="url" value="${escape(source.baseUrl ?? provider?.baseUrl ?? '')}" required maxlength="2048" autocomplete="off" spellcheck="false" placeholder="https://api.example.com/v1"><small>填写基础地址，不要在末尾添加 /models、/responses 或 /chat/completions。远程服务须使用 HTTPS；本机 Ollama 可使用 http://127.0.0.1:11434/v1。</small></label>
      <label>${existing ? '更新 API 密钥（留空保留现有密钥）' : 'API 密钥'}<input name="apiKey" type="password" autocomplete="new-password" spellcheck="false" autocapitalize="none"${!existing || !provider.keyConfigured ? ' required' : ''} placeholder="${existing && provider.keyConfigured ? '已保存，页面不会显示' : '填写此服务商的密钥'}"><small>密钥只发送给这里填写的服务商。更换地址时须重新输入对应密钥；本机 Ollama 可填写 ollama。</small></label>
      ${existing ? '<p class="hint">下方预填第一个模型。保持模型 ID 可更新其资料；改为新的模型 ID 可添加模型，其他已保存模型会保留。</p>' : ''}
      ${modelFields(source)}<p class="hint">上下文和最大输出长度请核对服务商资料后填写，不会套用其他模型的数值。保存时只检查账号凭据和模型列表权限，不发起推理。</p>
      <div>${button(existing ? '检查并保存连接与模型' : '检查并添加服务商','provider-save')}<small class="inline-hint">密钥由 Windows 为当前用户加密保存。</small></div>
    </form>`;
  }

  function providerCard(provider) {
    const items = list(provider.models);
    const draft = providerDraft?.id === provider.id ? providerDraft : null;
    return `<article class="provider-card"><div class="section-heading"><div><h3>${escape(provider.name)}</h3><p class="subtle break">${escape(provider.baseUrl)}</p></div><span class="badge ${provider.keyConfigured ? 'ok' : 'warn'}">${provider.keyConfigured ? '密钥已保存' : '需要设置密钥'}</span></div>
      <p class="hint">${provider.protocol === 'chat_completions' ? 'Chat Completions' : 'Responses'} · ${provider.validation?.modelsEndpointVerified ? `模型列表已检查：${escape(localTime(provider.validation.modelsCheckedAt))}` : '尚无模型列表检查记录'}</p>
      ${items.length ? `<ul class="model-list">${items.map(model=>`<li><div><strong>${escape(model.displayName || model.id)}</strong><span class="model-id break">${escape(model.id)}</span><small>上下文 ${number(model.contextWindow)} · 最大输出 ${number(model.maxOutputTokens)} · ${list(model.inputModalities).includes('image') ? '文本与图像' : '文本'} · ${model.supportsTools ? '声明支持工具' : '不支持工具'}</small></div><form method="post" action="${url('provider-remove-model')}">${token('provider-remove-model')}${hidden('id',provider.id)}${hidden('modelId',model.id)}${button('移除模型','provider-remove-model','quiet danger-text')}</form></li>`).join('')}</ul>` : '<p class="empty">尚未添加模型。连接已保留，可在下方添加。</p>'}
      <details${draft ? ' open' : ''}><summary>编辑连接或添加模型</summary>${providerForm(provider,draft)}</details>
      <form class="delete-provider" method="post" action="${url('provider-delete')}">${token('provider-delete')}${hidden('id',provider.id)}${button('删除此服务商及其模型','provider-delete','quiet danger-text')}</form></article>`;
  }

  function catalogHtml() {
    const gpt = sync.gpt || {};
    const deepseek = sync.deepseek || {};
    const pending = list(deepseek.pendingModels);
    return `<section><div class="section-heading"><div><p class="eyebrow">官方模型</p><h2>GPT 与 DeepSeek</h2></div><span class="badge">${official.length} 个模型</span></div>
      ${official.length ? `<div class="chips">${official.map(model=>`<span>${escape(model.display_name || model.slug)}</span>`).join('')}</div>` : '<p class="empty">模型列表尚未载入，连接检查后可重试。</p>'}
      <div class="divider"></div><h3>模型列表更新</h3>
      ${autoCatalog ? `<p class="hint">已开启 GPT 与 DeepSeek 的定期目录检查；这两项检查不发送生成请求。</p><dl class="compact"><div><dt>GPT 上次成功</dt><dd>${escape(localTime(gpt.lastSuccess))}</dd></div><div><dt>DeepSeek 上次成功</dt><dd>${escape(localTime(deepseek.lastSuccess))}</dd></div></dl>` : '<p class="hint">自动更新尚未开启。</p>'}
      ${gpt.errorCode || deepseek.errorCode ? '<p class="notice">部分来源暂时无法更新，已保留最近可用的资料；稍后会自动重试。</p>' : ''}
      ${pending.length ? `<p class="notice">发现 ${pending.length} 个新型号，正在等待完整接入资料：${pending.map(item=>escape(typeof item === 'string' ? item : item.id || item.slug || item.name || '新模型')).join('、')}。</p>` : ''}
      ${autoCatalog ? `<form method="post" action="${url('refresh')}">${hidden('csrf_token',refreshCsrf)}<button type="submit" class="secondary"${refreshCsrf ? '' : ' disabled'}>立即更新模型列表</button></form>` : ''}<p class="hint">更新后重新打开 Codex 模型选择器。若列表暂未变化，可重启 Codex。</p></section>`;
  }

  function geminiSyncHtml() {
    const state = options.geminiSync;
    if (state?.configured !== true) return '';
    const enabled = state.enabled === true;
    const busy = state.busy === true;
    const successRecorded = !!state.lastSuccessAt && Number.isFinite(Date.parse(state.lastSuccessAt));
    const degraded = state.state === 'degraded' || !!state.errorCode || state.catalog?.stale === true || !!state.catalog?.errorCode;
    const current = !enabled ? '已暂停' : busy ? state.state === 'validating' ? '正在验证新型号' : '正在检查' : degraded ? '暂时无法完整更新' : state.state === 'paused' ? '等待处理' : state.state === 'ok' && successRecorded ? '检查完成' : '等待检查';
    const healthy = enabled && !busy && !degraded && state.state === 'ok' && successRecorded;
    const minutes = Number.isFinite(state.intervalMs) && state.intervalMs > 0 ? Math.max(1,Math.round(state.intervalMs / 60000)) : 30;
    const pending = list(state.pending);
    const reasons = {
      awaiting_validation:'等待首次工具验证',pending:'等待验证',metadata_incomplete:'等待完整模型资料',model_metadata_incomplete:'等待完整模型资料',
      not_available:'账号暂时无法使用此型号',model_unavailable:'账号暂时无法使用此型号',quota_limited:'额度或频率受限，稍后再验证',
      probe_backoff:'等待下次验证',probe_failed:'兼容性验证未通过',validation_failed:'兼容性验证未通过',unsupported_model:'等待接口支持'
    };
    const reason = item => reasons[item?.reason] || item?.reason || '等待兼容性验证';
    const refreshToken = controlCsrf['gemini-refresh'];
    const toggleToken = controlCsrf['gemini-toggle'];
    return `<section id="gemini-auto-update"><div class="section-heading"><div><p class="eyebrow">订阅模型</p><h2>Gemini 自动更新</h2></div><span class="badge ${healthy ? 'ok' : degraded || !enabled || state.state === 'paused' ? 'warn' : ''}" role="status">${current}</span></div>
      <p class="hint">每 ${number(minutes)} 分钟检查当前 Google 账号可用的型号与接入资料。新型号通过兼容性验证后，自动加入模型选择器。</p>
      ${state.message ? `<p class="notice${degraded ? ' error' : ''}">${escape(state.message)}</p>` : ''}
      ${degraded ? '<p class="notice">部分检查暂时无法完成，已保留上次可用模型列表；待连接或资料恢复后继续检查。</p>' : ''}
      <dl class="compact"><div><dt>最近检查</dt><dd>${escape(localTime(state.lastCheckedAt))}</dd></div><div><dt>上次成功</dt><dd>${escape(localTime(state.lastSuccessAt))}</dd></div><div><dt>下次检查</dt><dd>${enabled ? escape(localTime(state.nextCheckAt)) : '暂停期间不检查'}</dd></div><div><dt>当前 Gemini 模型</dt><dd>${number(state.modelCount)} 个</dd></div></dl>
      ${pending.length ? `<details open><summary>${number(pending.length)} 个型号待处理</summary><ul class="check-results">${pending.slice(0,20).map(item=>`<li><span class="result-dot pending" aria-label="待处理"></span><div class="break"><strong>${escape(typeof item === 'string' ? item : item.id || '新型号')}</strong><p>${escape(typeof item === 'string' ? '等待兼容性验证' : reason(item))}</p>${item?.nextProbeAt ? `<small>下次验证：${escape(localTime(item.nextProbeAt))}</small>` : ''}</div></li>`).join('')}</ul>${pending.length > 20 ? `<p class="hint">另有 ${number(pending.length-20)} 个型号等待处理。</p>` : ''}</details>` : ''}
      <div class="actions"><form method="post" action="${url('gemini-refresh')}">${token('gemini-refresh')}<button type="submit" class="secondary"${refreshToken && enabled && !busy ? '' : ' disabled'}>立即检查 Gemini</button></form><form method="post" action="${url('gemini-toggle')}">${token('gemini-toggle')}${hidden('enabled',enabled ? 'false' : 'true')}<button type="submit" class="secondary"${toggleToken ? '' : ' disabled'}>${enabled ? '暂停自动更新' : '开启自动更新'}</button></form></div>
      <p class="hint">目录检查不生成回复。新发现或能力变化的型号，首次会用最多两轮模拟工具请求验证，使用少量订阅额度，不执行文件修改。暂停会保留当前可用模型，你手动移除的型号不会自动加回。</p>
      <p class="hint">Google 账号权限与上游资料各有刷新周期，新型号不会在发布时立即出现。更新完成后，重新打开 Codex 模型选择器即可查看。</p></section>`;
  }

  function diagnosticsHtml() {
    const checks = list(diagnostics.checks);
    const errors = list(diagnostics.recentErrors).slice(-6).reverse();
    return `<section><p class="eyebrow">连接维护</p><h2>检查与恢复</h2><p class="hint">检查当前设置与连接情况，结果不会包含对话或密钥。最近检查：${escape(localTime(diagnostics.lastCheckedAt))}。</p>
      <div class="actions"><form method="post" action="${url('diagnose')}">${token('diagnose')}${button('检查连接','diagnose')}</form><form method="post" action="${url('restart')}">${token('restart')}${button('重启本机网关','restart','secondary')}</form></div>
      ${checks.length ? `<ul class="check-results">${checks.map(check=>`<li><span class="result-dot ${check.ok === true ? 'pass' : check.ok === false ? 'fail' : 'pending'}" aria-label="${check.ok === true ? '通过' : check.ok === false ? '未通过' : '待确认'}"></span><div><strong>${escape(check.name || '连接检查')}</strong>${check.message ? `<p>${escape(check.message)}</p>` : ''}</div></li>`).join('')}</ul>` : '<p class="empty">尚未进行连接检查。</p>'}
      ${diagnostics.control?.message ? `<p class="notice" role="status">${escape(diagnostics.control.message)}</p>` : ''}
      ${errors.length ? `<details><summary>最近遇到的问题</summary><ul class="error-list">${errors.map(error=>`<li><strong>${escape(error.message || '请求未成功，请重新检查连接。')}</strong><small>${escape(localTime(error.time))}${error.model ? ` · ${escape(error.model)}` : ''}${error.provider ? ` · ${escape(error.provider)}` : ''}${error.code ? ` · ${escape(error.code)}` : ''}</small></li>`).join('')}</ul></details>` : ''}
      <details class="restore"><summary>恢复 Codex 原有连接</summary><p class="hint">将 Codex 恢复到启用网关前的连接设置。恢复后，自定义模型将不再通过此网关显示；可能需要重新启动 Codex。</p><form class="stack" method="post" action="${url('restore')}">${token('restore')}<label class="check"><input type="checkbox" name="confirm" value="restore" required>我确认恢复启用网关前的连接设置。</label><div>${button('确认恢复原有连接','restore','danger')}</div></form></details></section>`;
  }

  const newDraft = providerDraft && !providers.some(provider=>provider.id === providerDraft.id) ? providerDraft : null;
  const verified = validation?.status === 'verified' || validation?.ok === true;
  const failed = validation?.status === 'failed' || validation?.ok === false;
  const credentialValidation = validation ? `<div class="divider"></div><h3>DeepSeek 凭据与模型列表检查</h3><div class="notice ${verified ? 'success' : failed ? 'error' : ''}" role="status"><strong>${verified ? '检查通过' : failed ? '检查未通过' : '尚未检查'}</strong>${validation.message ? `<p>${escape(validation.message)}</p>` : ''}${validation.checkedAt ? `<small>${escape(localTime(validation.checkedAt))}</small>` : ''}</div><p class="hint">此结果不包含推理或工具调用测试。</p>` : '';
  const probe = `<section><p class="eyebrow">可选试用</p><h2>发送一条简短测试</h2><p class="hint">会向所选模型发送一条简短请求，可能产生少量费用。仅验证本次基础请求是否可用；模型列表检查与基础试用都不能证明工具调用和后续会话已可用。</p><form class="stack" method="post" action="${url('probe')}">${token('probe')}<label>选择要试用的模型<select name="model" required><option value="" selected disabled>请选择模型</option>${models.map(model=>`<option value="${escape(model.slug)}">${escape(model.display_name || model.slug)}</option>`).join('')}</select></label><div>${button('发送简短测试','probe','secondary')}</div></form></section>`;

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Codex 模型连接管理</title><style>
  :root{color-scheme:light;--ink:#202a34;--muted:#647280;--line:#dde4e8;--accent:#176b63}*{box-sizing:border-box}body{font:15px/1.65 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:var(--ink);background:#f3f6f5;margin:0}main{max-width:1120px;margin:0 auto;padding:44px 28px 72px}header{margin-bottom:28px}.eyebrow{font-size:12px;font-weight:700;letter-spacing:.12em;color:var(--accent);margin:0 0 6px}h1{font-size:32px;letter-spacing:-.03em;line-height:1.3;margin:0 0 12px}h2{font-size:22px;line-height:1.4;margin:0 0 12px}h3{font-size:17px;line-height:1.5;margin:0 0 6px}p{margin:10px 0}section{background:#fff;border:1px solid var(--line);border-radius:17px;padding:25px;margin:0 0 22px}.layout{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(290px,1fr);gap:22px;align-items:start}.section-heading{display:flex;gap:16px;justify-content:space-between;align-items:flex-start}.subtle,.hint,small{color:var(--muted);font-size:13px}.subtle{margin:3px 0}.hint{line-height:1.7}small{display:block;line-height:1.65;margin-top:5px}.break{overflow-wrap:anywhere}.badge{display:inline-block;background:#edf2f4;color:#52616d;padding:4px 9px;border-radius:7px;white-space:nowrap;font-size:12px;font-weight:600}.badge.ok{background:#e5f3ec;color:#246342}.badge.warn{background:#fff2d8;color:#8d6219}.overview{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--line);border-radius:12px;background:#fff;margin:22px 0 0}.overview div{padding:15px 20px}.overview div+div{border-left:1px solid var(--line)}.overview strong{display:block;font-size:24px;line-height:1.35}.overview span{color:var(--muted);font-size:12px}.notice{padding:13px 15px;border:1px solid #efddb2;background:#fff8e8;border-radius:10px;margin:14px 0 20px;overflow-wrap:anywhere}.notice p{margin:6px 0 0}.notice.success{background:#edf7f1;border-color:#c8e5d3;color:#275d3d}.notice.error{background:#fff0ed;border-color:#f1cdc6;color:#914335}.provider-card{border-top:1px solid var(--line);padding:23px 0 0;margin-top:22px}.provider-card:first-of-type{border-top:0;padding-top:8px;margin-top:12px}.model-list,.check-results,.error-list{padding:0;list-style:none;margin:16px 0}.model-list li{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:13px 0;border-top:1px solid #edf0f2}.model-list li:first-child{border-top:0}.model-list strong{font-size:14px}.model-id{display:block;color:var(--muted);font-size:12px}.model-list small{font-size:12px}.stack{display:grid;gap:15px}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}label{display:block;font-size:13px;font-weight:600}label small{font-weight:400}input,select{font:inherit;color:var(--ink);background:#fff;display:block;width:100%;border:1px solid #bfccd2;border-radius:8px;padding:10px 11px;margin:6px 0 0;min-width:0}input:focus,select:focus{outline:2px solid #b7ddd7;outline-offset:2px;border-color:var(--accent)}input[type=checkbox]{width:17px;height:17px;flex:0 0 auto;margin:2px 0 0;accent-color:var(--accent)}.check{display:flex;gap:9px;align-items:flex-start;font-weight:500;margin:8px 0}fieldset{margin:0;border:1px solid var(--line);border-radius:10px;padding:12px 15px 16px}legend{padding:0 6px;font-size:13px;font-weight:700}fieldset .hint{margin:8px 0 14px}button{font:600 13px/1.4 system-ui,sans-serif;border:1px solid transparent;border-radius:8px;background:var(--accent);color:#fff;padding:10px 15px;cursor:pointer}button:hover{filter:brightness(.95)}button:disabled{opacity:.45;cursor:default}button.secondary{color:#34554f;background:#f3f7f6;border-color:#cfded9}button.quiet{background:transparent;color:var(--muted);padding:5px 0;white-space:nowrap;font-size:12px}button.danger-text{color:#9a4a42}button.danger{background:#a8493e}.inline-hint{display:inline;margin-left:10px;font-size:12px}.actions{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0}details{border-top:1px solid var(--line);margin-top:16px;padding-top:13px}summary{font-size:13px;font-weight:600;color:#3d625b;cursor:pointer}details[open]>summary{margin-bottom:17px}.delete-provider{margin-top:15px}.divider{height:1px;background:var(--line);margin:23px 0}.chips{display:flex;gap:7px;flex-wrap:wrap;margin:15px 0}.chips span{font-size:12px;padding:4px 9px;background:#f1f5f4;border-radius:6px;overflow-wrap:anywhere}.compact{font-size:12px;margin:16px 0 20px}.compact div{margin:9px 0}.compact dt{color:var(--muted)}.compact dd{margin:1px 0 0}.check-results li{display:flex;gap:10px;padding:10px 0;border-top:1px solid #edf0f2}.check-results strong{font-size:13px}.check-results p{font-size:12px;color:var(--muted);margin:3px 0 0}.result-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;background:#aebbc3;margin-top:7px}.result-dot.pass{background:#4b9368}.result-dot.fail{background:#bf6457}.result-dot.pending{background:#bc9d4b}.error-list li{padding:12px 0;border-top:1px solid #edf0f2;overflow-wrap:anywhere}.error-list strong{font-size:12px;font-weight:500}.error-list small{font-size:11px}.restore{margin-top:24px}.restore summary{color:#8c5648}.empty{color:var(--muted);font-size:13px;padding:8px 0}.footer{color:var(--muted);font-size:12px;margin:25px 3px 0}@media(max-width:860px){.layout{grid-template-columns:1fr}main{padding:28px 18px 48px}h1{font-size:27px}}@media(max-width:520px){section{padding:20px 17px;border-radius:13px}.form-grid{grid-template-columns:1fr;gap:15px}.section-heading{gap:10px}.badge{font-size:11px;padding:4px 7px}.overview div{padding:13px 12px}.overview strong{font-size:21px}.inline-hint{display:block;margin:8px 0 0}.model-list li{gap:8px}}
  .section-heading>div,.model-list li>div{min-width:0}h3,.model-list strong{overflow-wrap:anywhere}
  </style></head><body><main><header><p class="eyebrow">CODEX · 本机模型网关</p><h1>管理你的模型连接</h1><p class="subtle">GPT 使用现有 ChatGPT 登录；DeepSeek 与其他服务商使用各自单独保存的密钥。</p><div class="overview"><div><strong>${official.length}</strong><span>GPT 与 DeepSeek 模型</span></div><div><strong>${providers.length}</strong><span>自定义服务商</span></div><div><strong>${customCount}</strong><span>自定义模型</span></div></div></header>
  ${notices()}<div class="layout"><div>
    <section><div class="section-heading"><div><p class="eyebrow">自定义连接</p><h2>其他服务商与模型</h2></div><span class="badge">${providers.length} 个服务商</span></div><p class="hint">添加兼容 Responses 或 Chat Completions 的 API。各服务商密钥互相隔离，不会收到 ChatGPT 登录凭据。</p><p class="notice">保存成功表示密钥可以访问模型列表且所选模型在列表中；这不代表推理、工具调用或完整会话已经实测通过。</p>${providers.length ? providers.map(providerCard).join('') : '<p class="empty">还没有添加其他服务商。在下方填写连接资料即可开始。</p>'}</section>
    <section><p class="eyebrow">添加连接</p><h2>添加服务商</h2><p class="hint">准备好 API 地址、密钥与模型的准确能力资料。密钥不会回填到页面。</p>${providerForm(null,newDraft)}</section>
    ${probe}
  </div><aside>${geminiSyncHtml()}${catalogHtml()}
    <section><p class="eyebrow">独立凭据</p><h2>DeepSeek 密钥</h2><p><span class="badge ${hasKey ? 'ok' : 'warn'}">${hasKey ? '已加密保存' : '尚未设置'}</span></p><form class="stack" method="post" action="${url('key')}">${hidden('csrf_token',csrf)}<label>新的 API 密钥<input name="key" type="password" required autocomplete="new-password" spellcheck="false" placeholder="填写新的 DeepSeek 密钥"></label><div><button type="submit"${csrf ? '' : ' disabled'}>加密保存</button></div></form><p class="hint">密钥只用于 DeepSeek，更新后立即生效。已保存的密钥不会显示在页面上。</p>${credentialValidation}</section>
    ${diagnosticsHtml()}<section><p class="eyebrow">本次运行</p><h2>连接记录</h2><dl class="compact"><div><dt>GPT 请求</dt><dd>${number(stats.gptRequests)}</dd></div><div><dt>DeepSeek 请求</dt><dd>${number(stats.deepseekRequests)}</dd></div><div><dt>其他服务商请求</dt><dd>${number(stats.providerRequests ?? stats.customRequests)}</dd></div></dl><p class="hint">仅记录模型、转发方向、时间与状态。不会记录对话内容或密钥。</p></section>
  </aside></div><p class="footer">此页面运行在本机。模型列表变化后，重新打开 Codex 模型选择器即可查看。</p></main></body></html>`;
}
module.exports = {renderManagement};
