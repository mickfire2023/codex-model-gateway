'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
function inspect(files){
  const problems=[];
  for(const relative of files){
    if(/(?:^|\/)(?:private|node_modules|runtime|vendor|\.cache)(?:\/|$)|\.(?:dpapi|exe|dll|log|zip|png)$/i.test(relative)||/(?:^|\/)(?:auth|settings|control|validation|bridge)\.json$/i.test(relative)){problems.push(relative+': runtime/private artifact');continue;}
    const file=path.join(root,relative);if(!fs.existsSync(file)||!fs.statSync(file).isFile())continue;
    const body=fs.readFileSync(file,'utf8');
    if(!body.length||body.includes('\0'))problems.push(relative+': empty or NUL-corrupted source');
    if(/sk-[a-f0-9]{32,}\b|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(body))problems.push(relative+': credential pattern');
    if (/[A-Z]:[\\/]+Users[\\/]+(?!YOUR_NAME|Fixture|Public|Default)[^\\/\s'"<>]+|[A-Za-z0-9._%+-]+@(?:gmail|outlook|hotmail)\.com/i.test(body))problems.push(relative+': personal installation data');
    if(relative==='gateway/openai-models.json'||relative==='gateway/deepseek-models.json'){try{if(JSON.parse(body).models.length!==0)problems.push(relative+': account/vendor catalog must not ship');}catch{problems.push(relative+': invalid seed');}}
  }
  return problems;
}
function tracked(){const result=spawnSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8'});if(result.status!==0)throw new Error('Run from an initialized Git checkout.');return [...new Set(result.stdout.split('\0').filter(Boolean))];}
if(require.main===module){try{const files=tracked(),problems=inspect(files);if(problems.length){console.error(problems.join('\n'));process.exitCode=1;}else console.log(`Release audit passed (${files.length} files; no runtime credentials or personal catalogs).`);}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={inspect};
