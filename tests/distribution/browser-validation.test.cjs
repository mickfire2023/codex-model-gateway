'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{spawnSync}=require('node:child_process');
const guard=require('../../scripts/browser-validation/mcp-stdio-guard.cjs');
const origin='http://127.0.0.1:32199';

test('browser check requires an exact loopback origin and confines navigation to synthetic pages',()=>{
 assert.equal(guard.approvedOrigin(origin),origin);
 assert.equal(guard.isAllowedNavigation(origin+'/check/ab12',origin),true);
 for(const value of ['https://example.invalid/check/ab12','http://127.0.0.1:32200/check/ab12',origin+'/private',origin+'/check/ab12?extra=1',origin+'/check/ab12#other','http://user@127.0.0.1:32199/check/ab12','file:///synthetic.html','javascript:alert(1)'])assert.equal(guard.isAllowedNavigation(value,origin),false,value);
 for(const value of ['https://127.0.0.1:32199','http://localhost:32199','http://user@127.0.0.1:32199',origin+'/private',origin+'?token=synthetic'])assert.throws(()=>guard.approvedOrigin(value));
});

test('browser check cannot run scripts, touch other pages, or use tools before opening its synthetic page',()=>{
 for(const name of ['browser_evaluate','browser_run_code','browser_tabs','exec_command'])assert.equal(guard.validateToolCall({name,arguments:{}},{origin,pageReady:true}).allowed,false);
 assert.equal(guard.validateToolCall({name:'browser_snapshot',arguments:{}},{origin,pageReady:false}).allowed,false);
 assert.equal(guard.validateToolCall({name:'browser_navigate',arguments:{url:origin+'/check/ab12'}},{origin,pageReady:false}).allowed,true);
 assert.equal(guard.validateToolCall({name:'browser_click',arguments:{ref:'synthetic-ref'}},{origin,pageReady:true}).allowed,true);
});

test('test screenshot files cannot escape the configured output directory',()=>{
 for(const filename of ['../private.png','nested/image.png','C:\\Fixture\\private.png','/private.png'])assert.equal(guard.validateToolCall({name:'browser_take_screenshot',arguments:{filename}},{origin,pageReady:true}).allowed,false);
 assert.equal(guard.validateToolCall({name:'browser_take_screenshot',arguments:{filename:'synthetic-screen.png'}},{origin,pageReady:true}).allowed,true);
});

test('browser result auditing recognizes refusal and retains no page or image content',()=>{
 const denied={result:{isError:true,content:[{type:'text',text:'Browser Use rejected this action due to browser security policy. The user declined permission for this action.'}]}};
 assert.equal(guard.classifyDeniedResponse(denied),'access_denied');
 assert.equal(guard.resultMetadata(denied).status,'access_denied');
 const metadata=guard.resultMetadata({result:{content:[{type:'text',text:'synthetic-private-page-body'},{type:'image',data:'synthetic-private-image'}]}});
 assert.deepEqual(metadata,{status:'success',types:['text','image']});
 assert.equal(JSON.stringify(metadata).includes('synthetic-private'),false);
});

test('public browser validation help neither requires installed runtime nor starts a model',()=>{
 const runner=path.resolve(__dirname,'../../scripts/browser-validation/playwright-native.cjs');
 const result=spawnSync(process.execPath,[runner,'--help'],{encoding:'utf8',timeout:5000});
 assert.equal(result.status,0);assert.match(result.stdout,/CHROME_TEST_APPROVED/);assert.doesNotMatch(result.stdout,/model_started/);
});

test('public browser validation fails closed without explicit isolated-test authorization',()=>{
 const runner=path.resolve(__dirname,'../../scripts/browser-validation/playwright-native.cjs');
 const env={...process.env};delete env.CHROME_TEST_APPROVED;
 const result=spawnSync(process.execPath,[runner,'synthetic-model'],{env,encoding:'utf8',timeout:5000});
 assert.equal(result.status,1);assert.match(result.stderr,/approval is required/);assert.doesNotMatch(result.stdout,/model_started/);
});
