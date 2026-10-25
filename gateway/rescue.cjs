'use strict';

// Independent emergency recovery: built-in Node modules only. This file never
// loads the gateway, decrypts credentials, launches PowerShell, or kills a PID.
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

class RecoveryError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const failure = (code, message) => new RecoveryError(code, message);
const TARGETS = new Set(['openai_base_url', 'model_catalog_json']);

function absolute(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value) || !path.isAbsolute(value)) {
    throw failure('invalid_path', label + ' must be a non-empty absolute path.');
  }
  return path.normalize(value);
}
function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const normal = value => path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
  return normal(left) === normal(right);
}
function stringValue(source) {
  const quote = source[0];
  if (quote !== '"' && quote !== "'") throw failure('invalid_config', 'A connection or catalog setting is not a TOML string. No settings were changed.');
  if (source.startsWith(quote.repeat(3))) throw failure('unsupported_config', 'A multiline connection or catalog setting needs manual review. No settings were changed.');
  let value = '', index = 1, closed = false;
  while (index < source.length) {
    const char = source[index++];
    if (char === quote) { closed = true; break; }
    if (/[\x00-\x1f\x7f]/.test(char)) throw failure('invalid_config', 'A connection or catalog setting contains a control character. No settings were changed.');
    if (quote === '"' && char === '\\') {
      const escape = source[index++];
      const escapes = {b:'\b',t:'\t',n:'\n',f:'\f',r:'\r','"':'"','\\':'\\'};
      if (Object.hasOwn(escapes, escape)) value += escapes[escape];
      else if (escape === 'u' || escape === 'U') {
        const count = escape === 'u' ? 4 : 8;
        const hex = source.slice(index, index + count);
        if (!new RegExp('^[0-9a-fA-F]{' + count + '}$').test(hex)) throw failure('invalid_config', 'A TOML path escape is invalid. No settings were changed.');
        const point = Number.parseInt(hex, 16);
        if (point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) throw failure('invalid_config', 'A TOML Unicode escape is invalid. No settings were changed.');
        value += String.fromCodePoint(point); index += count;
      } else throw failure('invalid_config', 'A TOML path escape is invalid. No settings were changed.');
    } else value += char;
  }
  if (!closed || !/^\s*(?:#.*)?$/.test(source.slice(index))) throw failure('invalid_config', 'A connection or catalog setting is malformed. No settings were changed.');
  return value;
}
function savedLine(value, key) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || /[\r\n\x00]/.test(value)) throw failure('invalid_backup', 'The saved original connection setting is invalid. No settings were changed.');
  const match = new RegExp('^\\s*' + key + '\\s*=\\s*(.*)$').exec(value);
  if (!match) throw failure('invalid_backup', 'The saved original connection setting has the wrong key. No settings were changed.');
  return {line:value, value:stringValue(match[1])};
}

// Locate root settings without treating bracket/string content as a table.
// Unsupported or ambiguous target syntax is rejected instead of guessed.
function inspect(text) {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? text.slice(1) : text;
  const lines = body.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g).filter(Boolean);
  const entries = new Map();
  let root = true, multiline = null, brackets = 0, braces = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const raw = lines[lineIndex].replace(/\r?\n$|\r$/, '');
    if (!multiline && brackets === 0 && braces === 0 && /^\s*\[/.test(raw)) {
      if (!/^\s*\[\[?[^\r\n]+\]\]?\s*(?:#.*)?$/.test(raw)) throw failure('invalid_config', 'The TOML table header is malformed. No settings were changed.');
      root = false;
    }
    if (!multiline && brackets === 0 && braces === 0 && raw.trim() && !/^\s*(?:#|\[)/.test(raw) && !/^\s*(?:[A-Za-z0-9_-]+|"(?:\\.|[^"\\])*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"(?:\\.|[^"\\])*"|'[^']*'))*\s*=/.test(raw)) {
      throw failure('invalid_config', 'A TOML assignment is malformed. No settings were changed.');
    }
    if (root && !multiline && brackets === 0 && braces === 0) {
      const target = /^\s*(openai_base_url|model_catalog_json)\s*=\s*(.*)$/.exec(raw);
      if (target) {
        if (entries.has(target[1])) throw failure('invalid_config', 'Duplicate root connection settings require manual review. No settings were changed.');
        entries.set(target[1], {index:lineIndex, value:stringValue(target[2])});
      } else if (/^\s*(?:["'](?:openai_base_url|model_catalog_json)["']\s*(?:=|\.)|(?:openai_base_url|model_catalog_json)\s*\.)/.test(raw)) {
        throw failure('unsupported_config', 'Quoted or dotted connection keys need manual review. No settings were changed.');
      }
    }
    let quote = null;
    for (let index = 0; index < raw.length; index++) {
      if (multiline) {
        if (raw.slice(index, index + 3) === multiline) { index += 2; multiline = null; }
        else if (multiline === '"""' && raw[index] === '\\') index++;
        continue;
      }
      const char = raw[index];
      if (quote) {
        if (quote === '"' && char === '\\') index++;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '#') break;
      if (char === '"' || char === "'") {
        if (raw.slice(index, index + 3) === char.repeat(3)) { multiline = char.repeat(3); index += 2; }
        else quote = char;
      } else if (char === '[') brackets++;
      else if (char === ']') brackets--;
      else if (char === '{') braces++;
      else if (char === '}') braces--;
      if (brackets < 0 || braces < 0) throw failure('invalid_config', 'Unbalanced TOML delimiters require manual review. No settings were changed.');
    }
    if (quote) throw failure('invalid_config', 'An unterminated TOML string requires manual review. No settings were changed.');
  }
  if (multiline || brackets || braces) throw failure('invalid_config', 'An unfinished TOML value requires manual review. No settings were changed.');
  return {bom, lines, entries, newline:body.includes('\r\n') ? '\r\n' : '\n'};
}

function recoverConfigText(text, settings, directory) {
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535 || typeof settings.routeToken !== 'string' || !/^[A-Za-z0-9_-]{16,}$/.test(settings.routeToken)) {
    throw failure('invalid_settings', 'Gateway settings are invalid. No settings were changed.');
  }
  const priorBase = savedLine(settings.previousBaseUrlLine, 'openai_base_url');
  const priorCatalog = savedLine(settings.previousCatalogLine, 'model_catalog_json');
  const parsed = inspect(text);
  const base = parsed.entries.get('openai_base_url');
  const catalog = parsed.entries.get('model_catalog_json');
  const expected = 'http://127.0.0.1:' + settings.port + '/' + settings.routeToken + '/backend-api/codex';
  const baseOwned = base?.value === expected;
  const ownedPaths = [path.join(directory, 'combined-models.json'), ...(Array.isArray(settings.lifecycle?.ownedCatalogPaths) ? settings.lifecycle.ownedCatalogPaths : [])];
  const catalogOwned = catalog && ownedPaths.some(value => samePath(catalog.value, value));
  const replacements = new Map(), prepend = [];
  if (baseOwned) replacements.set(base.index, priorBase?.line ?? null);
  if (catalogOwned) replacements.set(catalog.index, priorCatalog?.line ?? null);
  else if (baseOwned && !catalog && priorCatalog) prepend.push(priorCatalog.line);
  if (!replacements.size && !prepend.length) return {text, changed:false, restoredConnection:false, restoredCatalog:false};
  const output = parsed.lines.flatMap((line, index) => {
    if (!replacements.has(index)) return [line];
    const replacement = replacements.get(index);
    return replacement == null ? [] : [replacement + (/[\r\n]$/.test(line) ? parsed.newline : '')];
  }).join('');
  const next = parsed.bom + (prepend.length ? prepend.join(parsed.newline) + parsed.newline : '') + output;
  inspect(next);
  return {text:next, changed:next !== text, restoredConnection:!!baseOwned, restoredCatalog:!!catalogOwned || !!prepend.length};
}

function rescueDirectory(directory, options = {}) {
  const io = options.fs || fs;
  directory = absolute(directory, 'Installation directory');
  const settingsPath = path.join(directory, 'private', 'settings.json');
  let settings;
  try { settings = JSON.parse(io.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw failure('settings_unavailable', 'Cannot read the installed gateway settings. No settings were changed.'); }
  const configPath = absolute(settings.lifecycle?.configPath, 'Saved Codex config path');
  if (path.extname(configPath).toLowerCase() !== '.toml') throw failure('invalid_path', 'The saved Codex config path is not a TOML file. No settings were changed.');
  let original;
  try { original = io.readFileSync(configPath); }
  catch { throw failure('config_unavailable', 'Cannot read the saved Codex config file. No settings were changed.'); }
  const result = recoverConfigText(original.toString('utf8'), settings, directory);
  if (!result.changed) return {...result, text:undefined, configPath, message:'Codex already uses a different or restored connection. Existing settings were kept. Restart Codex if needed.'};
  const id = process.pid + '-' + randomUUID();
  const backupPath = path.join(directory, 'private', 'config.before-emergency-' + id + '.toml');
  const temporary = configPath + '.rescue-' + id + '.tmp';
  let descriptor;
  try {
    io.writeFileSync(backupPath, original, {flag:'wx', mode:0o600});
    descriptor = io.openSync(temporary, 'wx', 0o600);
    io.writeFileSync(descriptor, Buffer.from(result.text, 'utf8'));
    io.fsyncSync(descriptor); io.closeSync(descriptor); descriptor = undefined;
    if (!io.readFileSync(configPath).equals(original)) throw failure('config_changed', 'Codex settings changed during recovery. New settings were preserved. Please retry.');
    io.renameSync(temporary, configPath);
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    throw failure('recovery_write_failed', 'Cannot safely replace the Codex config file. The original file was not changed.');
  } finally {
    if (descriptor !== undefined) { try { io.closeSync(descriptor); } catch {} }
    try { io.unlinkSync(temporary); } catch {}
  }
  return {...result, text:undefined, configPath, backupPath, message:'Original GPT connection restored. Restart Codex to apply. Keys and conversations were kept. The gateway process was not stopped.'};
}

function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log('Usage: node rescue.cjs --directory "ABSOLUTE_INSTALL_DIRECTORY"'); return; }
  if (args.length !== 2 || args[0] !== '--directory') throw failure('invalid_arguments', 'Pass the installed directory explicitly: node rescue.cjs --directory "ABSOLUTE_INSTALL_DIRECTORY"');
  const result = rescueDirectory(args[1]);
  console.log(result.message);
}
if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error instanceof RecoveryError ? error.message : 'Emergency recovery failed. Existing settings were kept.'); process.exitCode = 1; }
}
module.exports = {rescueDirectory, recoverConfigText, RecoveryError, main};
