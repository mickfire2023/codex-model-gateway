'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

function initialize(root,{port=8317}={}) {
  if(!path.isAbsolute(root)||/[\x00-\x1f]/.test(root))throw new Error('An absolute installation directory is required.');
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid local port.');
  const binary=path.join(root,'cli-proxy-api.exe');
  if(!fs.existsSync(binary))throw new Error('The verified CLIProxyAPI binary is missing.');
  const privateDir=path.join(root,'private');
  fs.mkdirSync(path.join(privateDir,'auth'),{recursive:true});
  const controlPath=path.join(privateDir,'control.json');
  let control;
  if(fs.existsSync(controlPath)) {
    control=JSON.parse(fs.readFileSync(controlPath,'utf8'));
    if(control.version!==1||!['apiKey','managementKey'].every(k=>/^[a-f0-9]{64}$/.test(control[k])))throw new Error('Existing bridge control file is invalid; it was not replaced.');
  } else {
    control={version:1,apiKey:crypto.randomBytes(32).toString('hex'),managementKey:crypto.randomBytes(32).toString('hex')};
    fs.writeFileSync(controlPath,JSON.stringify(control),{flag:'wx',mode:0o600});
  }
  const quote=JSON.stringify;
  const yaml=`# Managed by CodexGeminiBridge. Local credentials; do not share this file.
config-version: 8
server:
  host: "127.0.0.1"
  port: ${port}
  max-request-body-bytes: 33554432
  commercial-mode: true
  trusted-proxies: []
  discovery:
    enabled: false
management:
  allow-remote: false
  secret-key: ${quote(control.managementKey)}
  disable-control-panel: true
  disable-auto-update-panel: true
access:
  api-keys:
    - ${quote(control.apiKey)}
oauth:
  auth-dir: ${quote(path.join(privateDir,'auth').replaceAll('\\','/'))}
  providers:
    antigravity:
      antigravity-credits: false
      signature-cache-enabled: true
routing:
  strategy: "fill-first"
  session-affinity: true
  retry:
    request-retry: 0
    max-retry-credentials: 1
    max-retry-interval: 0
requests:
  streaming:
    bootstrap-retries: 0
observability:
  logs:
    debug: false
    logging-to-file: false
    request-log: false
  usage:
    usage-statistics-enabled: false
  pprof:
    enable: false
plugins:
  enabled: false
multimedia:
  disable-image-generation: true
`;
  fs.writeFileSync(path.join(root,'config.yaml'),yaml,{mode:0o600});
  const metadata={version:1,product:'CodexGeminiBridge',release:'8.0.43',port,root};
  fs.writeFileSync(path.join(root,'bridge.json'),JSON.stringify(metadata,null,2),{mode:0o600});
  return {installed:true,release:metadata.release,port,credentialsConfigured:fs.readdirSync(path.join(privateDir,'auth')).some(x=>x.endsWith('.json'))};
}
if(require.main===module){try{console.log(JSON.stringify(initialize(process.argv[2]||'')));}catch{console.error('Bridge initialization failed. Check the verified binary and installation directory.');process.exitCode=1;}}
module.exports={initialize};
