/**
 * 静态安全扫描：在发布前对能力包做启发式检查。
 * 原则：扫描结果只是审核辅助，不是安全保证；high 默认阻止发布，人工审核仍应关注上下文。
 */
export const SEVERITY_ORDER = { low: 0, medium: 1, high: 2 };
export const SEVERITY_LABEL = { high: '高危', medium: '中危', low: '低危' };

const RULES = [
  {
    id: 'PI-001',
    severity: 'high',
    title: '疑似提示注入：要求忽略先前指令',
    re: /ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|messages?)/gi,
  },
  {
    id: 'PI-002',
    severity: 'high',
    title: '疑似提示注入：要求忽略系统/开发者指令',
    re: /(disregard|forget)\s+(all\s+|any\s+)?(the\s+)?(system|developer|previous)\s+(prompt|instructions?|messages?)/gi,
  },
  {
    id: 'PI-003',
    severity: 'high',
    title: '疑似越狱指令',
    re: /(you are now|from now on you are|pretend to be)\s+(dan|jailbroken|developer mode|unrestricted)/gi,
  },
  {
    id: 'PI-004',
    severity: 'medium',
    title: '要求对用户隐瞒行为',
    re: /(do not|don't|never)\s+(tell|inform|mention|reveal)\s+(the\s+)?(user|human)/gi,
  },
  {
    id: 'EX-001',
    severity: 'medium',
    title: '提及将数据外发到网络',
    re: /(send|post|upload|exfiltrate|transmit)\b[^\n]{0,80}\b(https?:\/\/|webhook|email)/gi,
  },
  {
    id: 'SEC-001',
    severity: 'high',
    title: '可能包含 AWS Access Key',
    re: /AKIA[0-9A-Z]{16}/g,
  },
  {
    id: 'SEC-002',
    severity: 'high',
    title: '可能包含 GitHub Token',
    re: /gh[pousr]_[A-Za-z0-9]{36,}/g,
  },
  {
    id: 'SEC-003',
    severity: 'high',
    title: '可能包含私钥',
    re: /-----BEGIN (?:(?:RSA|EC|OPENSSH|DSA) )?PRIVATE KEY-----/g,
  },
  {
    id: 'SEC-004',
    severity: 'medium',
    title: '可能包含 API Key',
    re: /(?:sk-[A-Za-z0-9]{24,}|xox[baprs]-[A-Za-z0-9-]{10,})/g,
  },
  {
    id: 'SEC-005',
    severity: 'medium',
    title: '读取敏感凭据路径',
    re: /(?:\.ssh\/|id_rsa|\.aws\/credentials|\.npmrc|\.netrc)/g,
  },
  {
    id: 'SH-001',
    severity: 'high',
    title: '高危删除命令',
    re: /\brm\s+-rf\s+(?:\/|~|\$HOME|\*)/g,
  },
  {
    id: 'SH-002',
    severity: 'high',
    title: '管道执行远程脚本',
    re: /\b(?:curl|wget)\b[^\n|;]{0,200}\|\s*(?:ba|z|k|da)?sh\b/g,
  },
  {
    id: 'SH-003',
    severity: 'high',
    title: 'fork bomb',
    re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/g,
  },
  {
    id: 'SH-004',
    severity: 'medium',
    title: '使用 sudo 提权',
    re: /\bsudo\b/g,
  },
  {
    id: 'SH-005',
    severity: 'medium',
    title: 'chmod 777 权限过大',
    re: /\bchmod\s+(?:-R\s+)?777\b/g,
  },
  {
    id: 'SH-006',
    severity: 'medium',
    title: '禁用安全限制的启动参数',
    re: /--dangerously-skip-permissions|--no-sandbox/g,
  },
  {
    id: 'HID-001',
    severity: 'high',
    title: 'HTML 注释中隐藏指令',
    text: (text) => {
      const re = /<!--[\s\S]{0,600}?(?:ignore|disregard|instruction|password|token|secret|system prompt)/gi;
      const matches = [];
      let match;
      while ((match = re.exec(text)) !== null) {
        matches.push({ index: match.index, snippet: match[0].replace(/\s+/g, ' ').slice(0, 160) });
        if (matches.length > 10) break;
      }
      return matches;
    },
  },
  {
    id: 'HID-002',
    severity: 'medium',
    title: '不可见字符（零宽字符）',
    line: (line) => /[\u200b-\u200f\u2060\ufeff\u00ad]{3,}/.test(line),
  },
  {
    id: 'HID-003',
    severity: 'medium',
    title: '超长 base64 块，可能隐藏载荷',
    text: (text) => {
      const re = /[A-Za-z0-9+/=]{2048,}/g;
      const matches = [];
      let match;
      while ((match = re.exec(text)) !== null) {
        matches.push({ index: match.index, snippet: `<base64 ${match[0].length} 字符>` });
        if (matches.length > 5) break;
      }
      return matches;
    },
  },
  {
    id: 'NET-001',
    severity: 'low',
    title: '脚本中读取环境变量中的密钥',
    re: /process\.env\.[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)/g,
  },
];

function lineOfIndex(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

function pushFinding(findings, rule, file, line, snippet, seen) {
  const key = `${rule.id}|${file}|${line}`;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push({
    ruleId: rule.id,
    severity: rule.severity,
    title: rule.title,
    file,
    line,
    snippet: String(snippet || '').replace(/\s+/g, ' ').trim().slice(0, 160),
  });
}

/**
 * 扫描归一化后的能力包。
 * @returns {{findings:Array, summary:{high:number,medium:number,low:number,total:number}}}
 */
export function scanBundle(bundle) {
  const findings = [];
  const seen = new Set();
  let textBudget = 0;

  for (const file of bundle.files) {
    if (file.encoding !== 'utf8') {
      pushFinding(
        findings,
        { id: 'BIN-001', severity: 'low', title: '包含二进制文件（未做内容扫描）' },
        file.path,
        0,
        `<binary ${file.bytes} bytes>`,
        seen,
      );
      continue;
    }
    const text = file.buf.toString('utf8');
    textBudget += text.length;
    if (textBudget > 8 * 1024 * 1024) break; // 扫描预算上限

    const lines = text.split('\n');
    for (const line of lines) {
      // 快速跳过：没有可疑关键词的行仍要过正则，但控制单文件行数上限
      if (findings.length > 200) break;
    }

    for (const rule of RULES) {
      if (findings.length > 200) break;
      if (rule.line) {
        for (let i = 0; i < lines.length; i++) {
          if (rule.line(lines[i])) {
            pushFinding(findings, rule, file.path, i + 1, lines[i], seen);
          }
        }
        continue;
      }
      if (rule.text) {
        const matches = rule.text(text);
        for (const match of matches) {
          pushFinding(findings, rule, file.path, lineOfIndex(text, match.index), match.snippet, seen);
        }
        continue;
      }
      if (rule.re) {
        const re = new RegExp(rule.re.source, rule.re.flags);
        for (let i = 0; i < lines.length; i++) {
          let match;
          while ((match = re.exec(lines[i])) !== null) {
            pushFinding(findings, rule, file.path, i + 1, match[0], seen);
            if (match.index === re.lastIndex) re.lastIndex++;
            break;
          }
        }
      }
    }
  }

  const summary = { high: 0, medium: 0, low: 0, total: findings.length };
  for (const finding of findings) summary[finding.severity] += 1;
  return { findings, summary };
}

/**
 * 根据阈值判断扫描是否阻止发布。
 * @param {object} scan scanBundle 的结果
 * @param {'high'|'medium'|'none'} threshold
 */
export function scanVerdict(scan, threshold = 'high') {
  if (threshold === 'none') return { blocked: false, threshold };
  const min = SEVERITY_ORDER[threshold] ?? SEVERITY_ORDER.high;
  const blocked = scan.findings.some((f) => (SEVERITY_ORDER[f.severity] ?? 0) >= min);
  return { blocked, threshold };
}
