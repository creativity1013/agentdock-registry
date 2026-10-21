/**
 * 行级差异（diff）计算，供审核界面的 diff 视图使用。
 *
 * 纯函数、零依赖：LCS 动态规划 + 规模上限保护。
 * 大文件（行数或表格过大）退化为「整段删除 + 整段新增」，用 mode 标注。
 */

/** 统一换行、去掉末尾空行后的行数组 */
export function splitLines(text) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  if (normalized === '') return [];
  const lines = normalized.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 两个文本的行级 diff。
 * @returns {{lines: Array<{type:'same'|'add'|'del', text:string, oldLine?:number, newLine?:number}>,
 *            added:number, removed:number, unchanged:number, mode:'lcs'|'coarse'}}
 */
export function diffLines(oldText, newText, { maxCells = 1_500_000, maxLines = 2000 } = {}) {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const lines = [];
  let added = 0;
  let removed = 0;
  let unchanged = 0;

  const coarse = () => {
    for (let i = 0; i < oldLines.length; i += 1) {
      lines.push({ type: 'del', text: oldLines[i], oldLine: i + 1 });
      removed += 1;
    }
    for (let i = 0; i < newLines.length; i += 1) {
      lines.push({ type: 'add', text: newLines[i], newLine: i + 1 });
      added += 1;
    }
    return { lines, added, removed, unchanged: 0, mode: 'coarse' };
  };

  if (oldLines.length > maxLines || newLines.length > maxLines) return coarse();
  const rows = oldLines.length;
  const cols = newLines.length;
  if ((rows + 1) * (cols + 1) > maxCells) return coarse();

  // dp[i][j] = oldLines[i..] 与 newLines[j..] 的 LCS 长度
  const width = cols + 1;
  const dp = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        oldLines[i] === newLines[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (oldLines[i] === newLines[j]) {
      lines.push({ type: 'same', text: oldLines[i], oldLine: i + 1, newLine: j + 1 });
      unchanged += 1;
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      lines.push({ type: 'del', text: oldLines[i], oldLine: i + 1 });
      removed += 1;
      i += 1;
    } else {
      lines.push({ type: 'add', text: newLines[j], newLine: j + 1 });
      added += 1;
      j += 1;
    }
  }
  while (i < rows) {
    lines.push({ type: 'del', text: oldLines[i], oldLine: i + 1 });
    removed += 1;
    i += 1;
  }
  while (j < cols) {
    lines.push({ type: 'add', text: newLines[j], newLine: j + 1 });
    added += 1;
    j += 1;
  }
  return { lines, added, removed, unchanged, mode: 'lcs' };
}

/**
 * 两个「bundle（含 files[{path,encoding,content,bytes}]）」之间的文件级 diff。
 * 只返回有变化的文件；文本文件做行级 diff，二进制文件只标记。
 */
export function diffBundles(fromBundle, toBundle, { maxFiles = 100, maxFileBytes = 512 * 1024 } = {}) {
  const fromFiles = new Map((fromBundle?.files || []).map((file) => [file.path, file]));
  const toFiles = new Map((toBundle?.files || []).map((file) => [file.path, file]));
  const paths = [...new Set([...fromFiles.keys(), ...toFiles.keys()])].sort();
  const files = [];
  const stats = { added: 0, removed: 0, modified: 0, same: 0, addedLines: 0, removedLines: 0 };
  let truncated = false;

  for (const filePath of paths) {
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
    const before = fromFiles.get(filePath);
    const after = toFiles.get(filePath);
    if (!before && !after) continue;
    if (!before) {
      stats.added += 1;
      const binary = after.encoding !== 'utf8';
      const entry = { path: filePath, status: 'added', binary };
      if (!binary) {
        const diff = diffLines('', after.content);
        Object.assign(entry, { ...diff, addedLines: diff.added });
        stats.addedLines += diff.added;
      } else {
        entry.bytes = after.bytes;
      }
      files.push(entry);
      continue;
    }
    if (!after) {
      stats.removed += 1;
      const binary = before.encoding !== 'utf8';
      const entry = { path: filePath, status: 'removed', binary };
      if (!binary) {
        const diff = diffLines(before.content, '');
        Object.assign(entry, { ...diff, addedLines: diff.removed });
        stats.removedLines += diff.removed;
      } else {
        entry.bytes = before.bytes;
      }
      files.push(entry);
      continue;
    }
    if (before.content === after.content) {
      stats.same += 1;
      continue;
    }
    if (before.encoding !== 'utf8' || after.encoding !== 'utf8') {
      stats.modified += 1;
      files.push({ path: filePath, status: 'modified', binary: true, bytes: after.bytes });
      continue;
    }
    if (before.bytes > maxFileBytes || after.bytes > maxFileBytes) {
      stats.modified += 1;
      files.push({ path: filePath, status: 'modified', binary: false, tooLarge: true, bytes: after.bytes });
      continue;
    }
    const diff = diffLines(before.content, after.content);
    stats.modified += 1;
    stats.addedLines += diff.added;
    stats.removedLines += diff.removed;
    files.push({ path: filePath, status: 'modified', binary: false, ...diff });
  }

  return { files, stats, truncated };
}
