'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {renderManagement}=require('../../gateway/management-page.cjs');

const tokens={'gemini-refresh':'synthetic-refresh-token','gemini-toggle':'synthetic-toggle-token'};
const ready={configured:true,enabled:true,busy:false,state:'ok',lastCheckedAt:'2026-10-26T00:00:00Z',lastSuccessAt:'2026-10-26T00:00:00Z',nextCheckAt:'2026-10-26T00:30:00Z',intervalMs:1800000,modelCount:2,pending:[],catalog:{stale:false}};
const section=html=>html.match(/<section id="gemini-auto-update">[\s\S]*?<\/section>/)?.[0]||'';
const render=state=>section(renderManagement({root:'/synthetic',controlCsrf:tokens,geminiSync:state}));
const form=(html,action)=>html.match(new RegExp('<form[^>]*action="[^"]*/'+action+'"[\\s\\S]*?</form>'))?.[0]||'';

test('Gemini controls are absent without an explicit configured connection; existing directory wording stays scoped',()=>{
  for(const geminiSync of [undefined,{}, {...ready,configured:false}]){
    const html=renderManagement({geminiSync,autoCatalog:{gpt:{},deepseek:{}}});
    assert.equal(section(html),'');
    assert.ok(html.includes('GPT 与 DeepSeek'));
    assert.ok(html.includes('已开启 GPT 与 DeepSeek 的定期目录检查；这两项检查不发送生成请求。'));
    assert.ok(!html.includes('更新列表不会发起付费对话'));
  }
});

test('enabled Gemini shows verified completion and Japanese times with action-specific CSRF controls',()=>{
  const html=render(ready);
  assert.ok(html.includes('Gemini 自动更新'));
  assert.ok(html.includes('每 30 分钟'));
  assert.ok(html.includes('检查完成'));
  assert.ok(html.includes('09:00:00（日本时间）'));
  assert.ok(html.includes('09:30:00（日本时间）'));
  assert.ok(html.includes('最多两轮模拟工具请求验证'));
  assert.ok(html.includes('使用少量订阅额度'));
  assert.ok(html.includes('你手动移除的型号不会自动加回'));
  const refresh=form(html,'gemini-refresh'),toggle=form(html,'gemini-toggle');
  assert.ok(refresh.includes('name="csrf_token" value="synthetic-refresh-token"'));
  assert.ok(!refresh.includes(' disabled'));
  assert.ok(toggle.includes('name="csrf_token" value="synthetic-toggle-token"'));
  assert.ok(toggle.includes('name="enabled" value="false"'));
  assert.ok(toggle.includes('暂停自动更新'));
});

test('pause preserves the available list and exposes an enable action instead of generating a refresh',()=>{
  const html=render({...ready,enabled:false,state:'paused'});
  assert.ok(html.includes('已暂停'));
  assert.ok(html.includes('暂停期间不检查'));
  assert.ok(html.includes('当前 Gemini 模型</dt><dd>2 个'));
  assert.ok(form(html,'gemini-refresh').includes(' disabled'));
  assert.ok(form(html,'gemini-toggle').includes('name="enabled" value="true"'));
  assert.ok(form(html,'gemini-toggle').includes('开启自动更新'));
  assert.ok(!html.includes('检查完成'));
});

test('busy validation prevents duplicate refreshes while allowing pause; missing CSRF disables both actions',()=>{
  const busy=render({...ready,busy:true,state:'validating'});
  assert.ok(busy.includes('正在验证新型号'));
  assert.ok(form(busy,'gemini-refresh').includes(' disabled'));
  assert.ok(!form(busy,'gemini-toggle').includes(' disabled'));
  const noTokens=section(renderManagement({geminiSync:ready}));
  assert.ok(form(noTokens,'gemini-refresh').includes(' disabled'));
  assert.ok(form(noTokens,'gemini-toggle').includes(' disabled'));
});

test('degraded or stale data never claims a current success and clearly retains the last list',()=>{
  for(const state of [{...ready,state:'degraded',errorCode:'upstream_unavailable'},{...ready,catalog:{stale:true}},{...ready,catalog:{errorCode:'catalog_invalid'}}]){
    const html=render(state);
    assert.ok(html.includes('暂时无法完整更新'));
    assert.ok(html.includes('已保留上次可用模型列表'));
    assert.ok(!html.includes('检查完成'));
  }
  assert.ok(!render({...ready,lastSuccessAt:null}).includes('检查完成'));
});

test('pending models and messages are escaped and credential-bearing optional fields are ignored',()=>{
  const payload='<script>alert("synthetic")</script>';
  const html=render({...ready,state:'degraded',message:payload,pending:[{id:payload,reason:'<img src=x onerror=synthetic>',nextProbeAt:'2026-10-26T03:00:00Z'}],apiKey:'synthetic-secret-never-render',catalog:{stale:true,managementKey:'synthetic-management-never-render'}});
  assert.ok(html.includes('&lt;script&gt;alert(&quot;synthetic&quot;)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror=synthetic&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('synthetic-secret-never-render'));
  assert.ok(!html.includes('synthetic-management-never-render'));
  assert.ok(html.includes('下次验证：2026/10/26 12:00:00（日本时间）'));
});

test('unknown states, invalid dates and long pending lists remain bounded and do not invent success',()=>{
  const html=render({...ready,state:'unrecognized',lastSuccessAt:'invalid',lastCheckedAt:'invalid',nextCheckAt:'invalid',intervalMs:NaN,pending:Array.from({length:23},(_,i)=>({id:'gemini-synthetic-'+i,reason:'metadata_incomplete'}))});
  assert.ok(html.includes('等待检查'));
  assert.ok(html.includes('每 30 分钟'));
  assert.ok(html.includes('尚无记录'));
  assert.ok(html.includes('等待完整模型资料'));
  assert.ok(html.includes('另有 3 个型号等待处理'));
  assert.ok(!html.includes('gemini-synthetic-20'));
  assert.ok(!html.includes('检查完成'));
  assert.ok(!html.includes('Invalid Date'));
});
