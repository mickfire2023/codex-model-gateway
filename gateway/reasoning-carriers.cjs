'use strict';
const {createHash}=require('node:crypto');

const ANTIGRAVITY_CLAUDE_REASONING_FORMAT='antigravity-claude-responses-v1';
const CARRIER=/^cpa-gemini-responses-carrier-v1:(next|previous|standalone):(function|text|any):([A-Za-z0-9+/]+)$/;
const MAX_CARRIER_BYTES=1024*1024;

// CPA uses this marker for both Gemini and Antigravity Responses. Recognition
// alone never grants replay permission: the history store must have issued it.
function isGeminiReasoningCarrier(item) {
  return item?.type==='reasoning' && typeof item.encrypted_content==='string' &&
    item.encrypted_content.length<=MAX_CARRIER_BYTES && CARRIER.test(item.encrypted_content);
}
function decodeBase64(value,raw=false) {
  if(typeof value!=='string'||!value||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))return;
  const bytes=Buffer.from(value,'base64');
  if((raw?bytes.toString('base64').replace(/=+$/,''):bytes.toString('base64'))!==value)return;
  return bytes;
}

// Inspect only the bounded wire envelope needed to distinguish Claude from
// Gemini. CPA remains responsible for signature validation and normalization.
function protobufFields(bytes) {
  if(!Buffer.isBuffer(bytes))return;
  let offset=0;
  function integer(){
    let value=0n;
    for(let index=0;index<10&&offset<bytes.length;index++){
      const byte=bytes[offset++];
      if(index===9&&byte>1)throw Error('invalid varint');
      value|=BigInt(byte&127)<<BigInt(index*7);
      if(!(byte&128))return value;
    }
    throw Error('invalid varint');
  }
  try{
    const fields=new Map();fields.duplicates=new Set();
    while(offset<bytes.length){
      const tag=integer(),number=Number(tag>>3n),wire=Number(tag&7n);
      if(number<1||number>536870911) return;
      let value;
      if(wire===0)value=integer();
      else if(wire===2){
        const length=Number(integer());
        if(!Number.isSafeInteger(length)||length>bytes.length-offset)return;
        value=bytes.subarray(offset,offset+length);offset+=length;
      }else if(wire===1||wire===5){
        const length=wire===1?8:4;
        if(offset+length>bytes.length)return;
        value=bytes.subarray(offset,offset+length);offset+=length;
      }else return;
      if(fields.has(number))fields.duplicates.add(number);
      fields.set(number,{wire,value});
    }
    return fields;
  }catch{return;}
}
const field=(fields,number,wire)=>fields?.get(number)?.wire===wire?fields.get(number).value:undefined;
function isClaudeSignature(signature) {
  if(typeof signature!=='string'||!signature||signature.length>MAX_CARRIER_BYTES)return false;
  let bytes=decodeBase64(signature);
  if(!bytes)return false;
  const wrapped=signature[0]==='R'||signature[0]==='Q';
  if(wrapped){
    const inner=bytes.toString('ascii');
    if(!bytes.equals(Buffer.from(inner,'ascii'))||inner[0]!== (signature[0]==='R'?'E':'C'))return false;
    bytes=decodeBase64(inner);
    if(!bytes)return false;
  }else if(signature[0]!=='E')return false;
  const qForm=signature[0]==='Q';
  if(bytes[0]!== (qForm?8:18))return false;
  const root=protobufFields(bytes),container=protobufFields(field(root,2,2));
  const channel=protobufFields(field(container,1,2));
  if(field(channel,1,0)===undefined)return false;
  if(qForm){
    // Google has issued version-4 thinking on both channels 18 and 19.
    // A newly observed channel still needs an explicit envelope review; its
    // ID alone never authorizes replay outside the account/model history scope.
    return !root.duplicates.has(2) && !container.duplicates.has(1) &&
      field(root,1,0)===4n && [18n,19n].includes(field(channel,1,0)) && field(channel,2,0)===2n &&
      field(channel,8,2)?.toString('utf8')==='thinking' && !!field(container,5,2)?.length;
  }
  for(const [number,wire] of [[2,0],[6,2],[7,0]])if(channel.has(number)&&channel.get(number).wire!==wire)return false;
  return true;
}
function claudeCarrierSignature(item) {
  if(!isGeminiReasoningCarrier(item))return;
  const bytes=decodeBase64(CARRIER.exec(item.encrypted_content)[3],true);
  if(!bytes)return;
  const signature=bytes.toString('ascii');
  if(!bytes.equals(Buffer.from(signature,'ascii'))||!isClaudeSignature(signature))return;
  return signature;
}
function isAntigravityClaudeReasoningCarrier(item) {return claudeCarrierSignature(item)!==undefined;}
function decodeAntigravityClaudeReasoningCarrier(item) {
  // Claude authenticates thinking text together with its signature; empty
  // detached Google function carriers cannot become Claude thinking blocks.
  if(!Array.isArray(item?.summary)||item.summary[0]?.type!=='summary_text'||
    typeof item.summary[0].text!=='string'||!item.summary[0].text.trim())return;
  return claudeCarrierSignature(item);
}
function canonical(value) {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
function opaqueReasoningKey(item) {
  if(!isGeminiReasoningCarrier(item))return;
  return createHash('sha256').update(JSON.stringify([item.encrypted_content,canonical(item.summary),canonical(item.content)])).digest('hex');
}
module.exports={ANTIGRAVITY_CLAUDE_REASONING_FORMAT,isGeminiReasoningCarrier,isAntigravityClaudeReasoningCarrier,decodeAntigravityClaudeReasoningCarrier,opaqueReasoningKey};
