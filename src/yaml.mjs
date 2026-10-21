/**
 * 零依赖 YAML 子集解析器。
 *
 * 只覆盖能力包需要的语法：顶层映射、一层嵌套映射、标量、列表
 * （标量列表 / 映射列表）、块标量（| 与 >）、行内列表与引号。
 * 不支持锚点、多文档、复杂标签等完整 YAML 特性。
 */
export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `${message}（第 ${line} 行）` : message);
    this.name = 'YamlError';
    this.line = line;
  }
}

function normalizeText(text) {
  return String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

const isIgnorable = (raw) => raw.trim() === '' || raw.trim().startsWith('#');

function indentOf(raw) {
  const m = /^ */.exec(raw);
  return m[0].length;
}

/** 去掉行尾注释（尊重引号内的 #） */
function stripComment(raw) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && inDouble) {
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '#' && !inSingle && !inDouble && (i === 0 || raw[i - 1] === ' ' || raw[i - 1] === '\t')) {
      return raw.slice(0, i).replace(/\s+$/, '');
    }
  }
  return raw.replace(/\s+$/, '');
}

/** 找到第一个不在引号 / 行内数组里的冒号，作为 key: value 分隔符 */
function findKeySeparator(content) {
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '\\' && inDouble) {
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === ':' && depth === 0) return i;
  }
  return -1;
}

function unescapeDoubleQuoted(text) {
  try {
    return JSON.parse(`"${text}"`);
  } catch {
    return text
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
}

function splitInlineList(inner) {
  const parts = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && inDouble) {
      current += ch;
      current += inner[++i] ?? '';
      continue;
    }
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (!inSingle && !inDouble) {
      if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
      else if (ch === ',' && depth === 0) {
        parts.push(current);
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim() !== '') parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

export function parseScalar(text) {
  const s = String(text ?? '').trim();
  if (s === '') return null;
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return unescapeDoubleQuoted(s.slice(1, -1));
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s === 'true' || s === 'True' || s === 'TRUE' || s === 'yes' || s === 'Yes' || s === 'on') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE' || s === 'no' || s === 'No' || s === 'off') return false;
  if (s === 'null' || s === 'Null' || s === 'NULL' || s === '~') return null;
  if (s.startsWith('[') && s.endsWith(']')) {
    return splitInlineList(s.slice(1, -1)).map((item) => parseScalar(item));
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return {};
    const obj = {};
    for (const pair of splitInlineList(inner)) {
      const sep = pair.indexOf(':');
      if (sep < 0) {
        obj[stripQuotes(pair.trim())] = null;
        continue;
      }
      obj[stripQuotes(pair.slice(0, sep).trim())] = parseScalar(pair.slice(sep + 1));
    }
    return obj;
  }
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function stripQuotes(text) {
  let s = String(text ?? '').trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    s = s.slice(1, -1);
  }
  return s;
}

function parseBlockScalar(lines, start, parentIndent, style) {
  let i = start;
  const collected = [];
  let blockIndent = null;
  while (i < lines.length) {
    const raw = lines[i].raw;
    if (raw.trim() === '') {
      collected.push('');
      i++;
      continue;
    }
    const ind = indentOf(raw);
    if (ind <= parentIndent) break;
    if (blockIndent === null) blockIndent = ind;
    if (ind < blockIndent) break;
    collected.push(raw.slice(blockIndent));
    i++;
  }
  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
  let text;
  if (style.startsWith('>')) {
    text = '';
    for (const line of collected) {
      if (line === '') {
        text += '\n';
      } else {
        text += text === '' || text.endsWith('\n') ? line : ` ${line}`;
      }
    }
  } else {
    text = collected.join('\n');
  }
  const chomp = style.includes('-') ? '' : '\n';
  return [text + chomp, i];
}

function parseSequence(lines, start, indent) {
  const arr = [];
  let i = start;
  while (i < lines.length) {
    const raw = lines[i].raw;
    if (isIgnorable(raw)) {
      i++;
      continue;
    }
    const curIndent = indentOf(raw);
    if (curIndent < indent) break;
    if (curIndent > indent) throw new YamlError('列表缩进异常', lines[i].line);
    const content = stripComment(raw.slice(curIndent));
    if (!(content === '-' || content.startsWith('- '))) break;
    const rest = content === '-' ? '' : content.slice(2).trim();
    i++;
    if (rest === '') {
      let j = i;
      while (j < lines.length && isIgnorable(lines[j].raw)) j++;
      if (j < lines.length && indentOf(lines[j].raw) > curIndent) {
        const childIndent = indentOf(lines[j].raw);
        const [child, next] = parseBlock(lines, j, childIndent);
        arr.push(child);
        i = next;
      } else {
        arr.push(null);
      }
      continue;
    }
    const sep = findKeySeparator(rest);
    if (sep > 0) {
      // 列表项是映射：把 rest 视为缩进 curIndent+2 的第一行，并吞掉后续更深缩进的行
      const firstLine = { raw: `${' '.repeat(curIndent + 2)}${rest}`, line: lines[i - 1].line };
      const itemLines = [firstLine];
      while (i < lines.length) {
        if (isIgnorable(lines[i].raw)) {
          itemLines.push(lines[i]);
          i++;
          continue;
        }
        if (indentOf(lines[i].raw) > curIndent) {
          itemLines.push(lines[i]);
          i++;
        } else {
          break;
        }
      }
      const [item] = parseBlock(itemLines, 0, curIndent + 2);
      arr.push(item);
      continue;
    }
    arr.push(parseScalar(rest));
  }
  return [arr, i];
}

function parseMapping(lines, start, indent) {
  const obj = {};
  let i = start;
  while (i < lines.length) {
    const raw = lines[i].raw;
    if (isIgnorable(raw)) {
      i++;
      continue;
    }
    const curIndent = indentOf(raw);
    if (curIndent < indent) break;
    if (curIndent > indent) throw new YamlError('映射缩进异常', lines[i].line);
    const content = stripComment(raw.slice(curIndent));
    const sep = findKeySeparator(content);
    if (sep <= 0) throw new YamlError(`无效的 YAML 映射行：${content}`, lines[i].line);
    const key = stripQuotes(content.slice(0, sep));
    if (key === '') throw new YamlError('YAML 键不能为空', lines[i].line);
    const valueRaw = content.slice(sep + 1).trim();
    i++;
    if (valueRaw === '' ) {
      let j = i;
      while (j < lines.length && isIgnorable(lines[j].raw)) j++;
      if (j < lines.length && indentOf(lines[j].raw) > curIndent) {
        const childIndent = indentOf(lines[j].raw);
        const [child, next] = parseBlock(lines, j, childIndent);
        obj[key] = child;
        i = next;
      } else {
        obj[key] = null;
      }
      continue;
    }
    if (/^[|>][+-]?$/.test(valueRaw)) {
      const [block, next] = parseBlockScalar(lines, i, curIndent, valueRaw);
      obj[key] = block;
      i = next;
      continue;
    }
    obj[key] = parseScalar(valueRaw);
  }
  return [obj, i];
}

function parseBlock(lines, start, indent) {
  let i = start;
  while (i < lines.length && isIgnorable(lines[i].raw)) i++;
  if (i >= lines.length) return [{}, i];
  const firstIndent = indentOf(lines[i].raw);
  if (firstIndent < indent) return [{}, i];
  if (firstIndent > indent) throw new YamlError('缩进异常', lines[i].line);
  const content = stripComment(lines[i].raw.slice(indent));
  if (content === '-' || content.startsWith('- ')) return parseSequence(lines, i, indent);
  return parseMapping(lines, i, indent);
}

/** 解析一段 YAML 文本 */
export function parseYaml(text) {
  const lines = normalizeText(text).split('\n').map((raw, idx) => ({ raw, line: idx + 1 }));
  const [value, next] = parseBlock(lines, 0, 0);
  for (let i = next; i < lines.length; i++) {
    if (!isIgnorable(lines[i].raw)) throw new YamlError('无法解析的 YAML 内容', lines[i].line);
  }
  return value;
}

/**
 * 解析带 frontmatter 的 Markdown。
 * @returns {{data: object, body: string}}
 */
export function parseFrontmatter(text) {
  const src = normalizeText(text);
  const lines = src.split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new YamlError('缺少 YAML frontmatter（文件应以 --- 开头）', 1);
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) throw new YamlError('YAML frontmatter 未闭合（缺少结束的 ---）', lines.length);
  const data = parseYaml(lines.slice(1, end).join('\n'));
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '');
  return { data, body };
}

export { normalizeText };
