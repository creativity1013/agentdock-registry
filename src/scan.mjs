/**
 * 静态安全扫描：在发布前对能力包做启发式检查。
 * 原则：扫描结果只是审核辅助，不是安全保证；high 默认阻止发布，人工审核仍应关注上下文。
 *
 * 规则分类：
 *   PI-xxx 提示注入 / 指令操纵（含中文变体、条件触发、伪造系统标签）
 *   EX-xxx 网络外发 / 数据渗出
 *   SEC-xxx 秘钥与凭据泄漏
 *   SH-xxx 危险命令与执行
 *   EXEC-xxx 动态执行 / 子进程（plugin 代码包主风险面）
 *   PER-xxx 持久化 / 横向移动（rc 文件、计划任务、harness 配置）
 *   HID-xxx 隐藏与混淆（零宽字符、Trojan Source、同形字、编码载荷）
 *   MET-xxx 结构性检查（依赖文件路径与 kind：描述投毒、生命周期脚本、危险工具组合）
 *   BIN-xxx 二进制
 * 供应链层（抢注 / 更新突变）需要库内上下文，在 store.publish 中调用 scanChanges 完成。
 */
export const SEVERITY_ORDER = { low: 0, medium: 1, high: 2 };
export const SEVERITY_LABEL = { high: '高危', medium: '中危', low: '低危' };
export const SEVERITY_EXPLAIN = {
  high: '可能导致凭据泄漏、命令执行或劫持 agent 行为，默认阻止发布',
  medium: '可疑信号，需要结合用途与上下文人工判断，不默认阻断',
  low: '编码不规范或轻微风险提示，通常不阻断',
};

const GROUP_REASON = {
  PI: '判定依据：命中了「提示注入 / 指令操纵」特征，这类内容可能让 agent 偏离原有任务或被操控',
  EX: '判定依据：提及把数据发送到外部地址，存在数据渗出风险',
  SEC: '判定依据：命中密钥/凭据格式，可能导致凭据泄漏',
  SH: '判定依据：包含危险、破坏性或提权命令',
  EXEC: '判定依据：包含动态执行/子进程调用，是代码类 plugin 的主要风险面',
  PER: '判定依据：涉及持久化或修改 harness/系统配置，可能被用于横向移动',
  HID: '判定依据：使用隐藏、混淆或不可见字符，常用于绕过审查或投毒',
  MET: '判定依据：结构性风险（依赖文件路径、描述投毒、生命周期脚本、危险工具组合）',
  BIN: '判定依据：包含二进制文件，无法做静态内容审查',
  SUP: '判定依据：供应链风险（名称抢注、更新突变、依赖路径异常）',
};

/** 给一条扫描发现生成「为什么被判定为这个等级」的说明 */
export function explainFinding(ruleId, severity) {
  const group = GROUP_REASON[String(ruleId).split('-')[0]] || '判定依据：命中静态安全扫描规则';
  const level = `强度判定（${SEVERITY_LABEL[severity] || severity}）：${SEVERITY_EXPLAIN[severity] || '按规则默认等级处理'}`;
  return `${group}；${level}`;
}

const RULES = [
  /* ---------------------------- 提示注入 / 指令操纵 ---------------------------- */
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
    id: 'PI-005',
    severity: 'high',
    title: '疑似提示注入（中文）：要求忽略/清除既有指令',
    re: /(忽略|无视|跳过|清除|抛掉)[^\n]{0,12}(之前|以前|先前|以上|上面|上方|所有|全部|系统|开发者|历史)[^\n]{0,10}(指令|提示词|提示|规则|设定|约束|记忆)/g,
  },
  {
    id: 'PI-006',
    severity: 'medium',
    title: '要求对用户隐瞒（中文）',
    re: /(不要|别|不得|禁止|无需)[^\n]{0,6}(告诉|告知|透露|暴露|提及|显示|上报)(给)?(用户|人类|使用者)/g,
  },
  {
    id: 'PI-007',
    severity: 'high',
    title: '伪造系统层标签 / 对话边界（提示注入常用）',
    re: /<\|(?:im_start|im_end|endoftext|system|assistant|user)\|?>|<\/?(?:system|system_prompt)>|\[(?:INST|\/INST|ASST)\]/gi,
  },
  {
    id: 'PI-008',
    severity: 'medium',
    title: '条件触发指令（延迟引爆形态）',
    re: /((?:如果|当|若|一旦)[^\n]{0,40}(?:则|就|请|那么)[^\n]{0,30}(?:忽略|隐瞒|删除|执行|发送|上传|透露))|((?:if|when|whenever|once)[^\n]{0,80}\b(?:ignore|disregard|hide|conceal|exfiltrate|reveal|delete all)\b)/gi,
  },

  /* ---------------------------- 网络外发 / 数据渗出 ---------------------------- */
  {
    id: 'EX-001',
    severity: 'medium',
    title: '提及将数据外发到网络',
    re: /(send|post|upload|exfiltrate|transmit)\b[^\n]{0,80}\b(https?:\/\/|webhook|email)/gi,
  },
  {
    id: 'EX-002',
    severity: 'high',
    title: '已知外传/收集端点',
    re: /(webhook\.site|requestbin|pipedream\.net|ngrok\.(?:io|app|dev|pro)|pastebin\.com\/raw|transfer\.sh|file\.io|disc(?:ord)?app\.com\/api\/webhooks|hooks\.slack\.com\/services|api\.telegram\.org\/bot|burpcollaborator|oast\.(?:fun|pro|live|site)|interact\.sh)/gi,
  },
  {
    id: 'EX-003',
    severity: 'medium',
    title: '整文件/数据体 POST 外发',
    re: /(curl|wget|Invoke-RestMethod|Invoke-WebRequest)[^\n]{0,120}(--data(?:-binary)?(?:-raw)?|-d\s|--upload-file|-T\s|--form|-F\s)\s*@?[^\n]{0,80}/gi,
  },
  {
    id: 'EX-004',
    severity: 'medium',
    title: '调用第三方 LLM API（可能外送上下文）',
    re: /(api\.(?:openai|anthropic|deepseek|moonshot|xai|groq|mistral)\.com|generativelanguage\.googleapis\.com|dashscope\.aliyuncs\.com|openrouter\.ai\/api)/gi,
  },

  /* ---------------------------- 秘钥与凭据 ---------------------------- */
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
    re: /-----BEGIN (?:(?:RSA|EC|OPENSSH|DSA|PGP) )?PRIVATE KEY(?: BLOCK)?-----/g,
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
    id: 'SEC-006',
    severity: 'high',
    title: '可能包含现代模型/支付/CI 服务的密钥',
    re: /(sk-proj-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-svcacct-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|sk_live_[0-9a-zA-Z]{16,}|rk_live_[0-9a-zA-Z]{16,}|glpat-[0-9A-Za-z_-]{20,}|dop_v1_[0-9a-f]{64}|nfp_[A-Za-z0-9]{40})/g,
  },
  {
    id: 'SEC-007',
    severity: 'high',
    title: '带明文凭据的数据库/消息队列连接串',
    re: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql):\/\/[^\s:@/'"]+:[^\s@/'"]+@/gi,
  },
  {
    id: 'SEC-008',
    severity: 'medium',
    title: '疑似 JWT 令牌',
    re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}/g,
  },
  {
    id: 'SEC-009',
    severity: 'medium',
    title: '疑似 Telegram/Discord bot 令牌',
    re: /([0-9]{8,10}:[A-Za-z0-9_-]{35})|([A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27})/g,
  },

  /* ---------------------------- 危险命令 ---------------------------- */
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
    re: /\b(?:curl|wget)\b[^\n|;]{0,200}\|\s*(?:ba|z|k|da|fi)?sh\b/g,
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
    re: /--dangerously-skip-permissions|--no-sandbox|--yolo\b/g,
  },
  {
    id: 'SH-007',
    severity: 'high',
    title: '反弹 shell',
    re: /\bbash\s+-i\s*>&\s*\/dev\/tcp\/|\/dev\/tcp\/[^\s]+\/\d{2,5}|\bnc(?:\.exe)?\b[^\n]{0,40}\s-e\s|\bmkfifo\b[^\n]{0,60}\bnc\b/g,
  },
  {
    id: 'SH-008',
    severity: 'high',
    title: 'base64 解码后执行（混淆载荷）',
    re: /\bbase64\b[^\n]{0,40}(?:-d|--decode|-D\b)[^\n]{0,60}\|\s*(?:ba|z|k|da|fi)?sh\b|\|\s*base64\s+(?:-d|--decode)\s*\|\s*(?:ba|z|k)?sh\b/g,
  },

  /* ---------------------------- 动态执行 / 子进程 ---------------------------- */
  {
    id: 'EXEC-001',
    severity: 'medium',
    title: '动态执行 / 子进程调用（plugin 代码需重点人工确认）',
    re: /\beval\s*\(|new\s+Function\s*\(|require\(\s*['"]child_process['"]\s*\)|from\s+['"]node:child_process['"]|\bchild_process\b|\bspawn(?:Sync)?\s*\(|\bexec(?:Sync)?\s*\(|os\.system\s*\(|subprocess\./g,
  },
  {
    id: 'EXEC-002',
    severity: 'medium',
    title: '下载后赋可执行权限（下载器形态）',
    re: /\bchmod\s+(?:-R\s+)?\+x\b|\bchmod\s+[0-7]{3,4}\s+\S+\s*&&/g,
  },

  /* ---------------------------- 持久化 / 横向移动 ---------------------------- */
  {
    id: 'PER-001',
    severity: 'high',
    title: '写入 shell 启动文件 / 计划任务 / authorized_keys（持久化）',
    re: /((?:>>|>|\btee\b|\bcp\b|\bmv\b)[^\n]{0,40}\.(?:zshrc|bashrc|bash_profile|zprofile|ssh\/authorized_keys|profile\b))|(\bcrontab\b\s+(?:-[elrx]\b|[-\w]{0,10}install))|(\blaunchctl\s+(?:load|enable)\b)|(systemctl\s+--now\s+enable)/g,
  },
  {
    id: 'PER-002',
    severity: 'high',
    title: '写入/篡改 harness 配置（后续会话劫持）',
    re: /((?:>>|>|\btee\b|\bcp\b|\bmv\b|写入|追加|覆盖|修改)[^\n]{0,30}(?:\.claude|\.codex|\.cursor|\.gemini|\.continue|CLAUDE\.md|AGENTS\.md|\.mcp\.json))|((?:~|\/Users\/|\$HOME|\/home\/)[^\n\s]{0,20}\.(?:claude|codex|cursor|gemini|continue)\/[^\n\s]{0,50}(?:settings|config|mcp|memory|credentials|CLAUDE))/g,
  },
  {
    id: 'PER-003',
    severity: 'medium',
    title: '引用 harness 配置 / 用户指令文件路径',
    re: /(?:~\/|\$HOME\/|\/Users\/[^\s/]+\/|\/home\/[^\s/]+\/)?(?:\.claude|\.codex|\.cursor|\.gemini|\.continue)\b|CLAUDE\.md|AGENTS\.md|\.mcp\.json/g,
  },
  {
    id: 'PER-004',
    severity: 'medium',
    title: '诱导安装第三方依赖（交付链投毒面）',
    re: /\b(?:npm|pnpm|yarn|bun|bunx|npx|pip3?)\s+(?:install|i|add)\s+[A-Za-z@][^\n]{0,60}|\bbrew\s+install\s+[^\n]{0,40}/g,
  },

  /* ---------------------------- 隐藏与混淆 ---------------------------- */
  {
    id: 'HID-001',
    severity: 'high',
    title: 'HTML 注释中隐藏指令',
    text: (text) => {
      const re = /<!--[\s\S]{0,600}?(?:ignore|disregard|instruction|password|token|secret|system prompt|指令|密钥|密码)/gi;
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
    line: (line) => /[​-‏⁠﻿­]{3,}/.test(line),
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
    id: 'HID-004',
    severity: 'high',
    title: 'Trojan Source：双向文本控制符',
    line: (line) => /[‪-‮⁦-⁩]/.test(line),
  },
  {
    id: 'HID-005',
    severity: 'medium',
    title: '西里尔字母与拉丁字母混排（同形字攻击）',
    line: (line) => /[Ѐ-ӿ]/.test(line) && /[a-z]/i.test(line),
  },
  {
    id: 'HID-006',
    severity: 'medium',
    title: '字符串拼接动态执行（拆分混淆）',
    re: /\b(?:eval|exec|Function)\s*\(\s*['"`][^'"`\n]{0,40}['"`]\s*\+/g,
  },

  /* ---------------------------- 环境变量密钥 ---------------------------- */
  {
    id: 'NET-001',
    severity: 'low',
    title: '脚本中读取环境变量中的密钥',
    re: /process\.env\.[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)|os\.environ(?:\.get)?\(?['"][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)|ENV\[['"][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)/g,
  },
];

const DESCRIPTION_POISON_RE = /(ignore|disregard|instruction|secret|password|token|credential|exfiltrat|发送|上传|上传到|外发|指令|忽略|隐瞒|凭据|密钥|密码)/i;
const AGENT_TOOLS_RE = /^\s*(?:tools|allowed-tools|allowed_tools)\s*:\s*(.+)$/im;
const PLUGIN_LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish'];

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
    reason: explainFinding(rule.id, rule.severity),
  });
}

function summarize(findings) {
  const summary = { high: 0, medium: 0, low: 0, total: findings.length };
  for (const finding of findings) summary[finding.severity] += 1;
  return summary;
}

/* ------------------------------ 结构性检查（文件路径 / kind 感知） ------------------------------ */

function structuralChecks(findings, seen, bundle, file, text) {
  const base = file.path.split('/').pop().toLowerCase();

  // .env / 凭据类文件整体被打包
  if (/^\.env(\.|$)/i.test(base) || /^(?:secrets?|credentials?)(?:[-_.][^/]*)?\.(?:json|txt|ya?ml|ini|toml)$/i.test(base) || base === '.npmrc' || base === '.netrc') {
    pushFinding(
      findings,
      { id: 'SEC-010', severity: 'medium', title: '敏感配置/凭据文件被打包' },
      file.path,
      1,
      `<file ${file.path}>`,
      seen,
    );
  }

  // 描述字段投毒：模型会读 frontmatter 的 description，人往往只扫正文
  if (/^(?:skill\.md|agent\.md)$/i.test(base)) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(?:description|说明)\s*:\s*(.{0,400})/i.test(lines[i]) && DESCRIPTION_POISON_RE.test(lines[i])) {
        pushFinding(
          findings,
          { id: 'MET-001', severity: 'high', title: 'manifest 描述字段含指令/敏感词（描述投毒）' },
          file.path,
          i + 1,
          lines[i],
          seen,
        );
      }
    }
  }

  // plugin 生命周期脚本：npm 安装即执行，经典供应链攻击面
  if (bundle.kind === 'plugin' && base === 'package.json') {
    try {
      const manifest = JSON.parse(text);
      const scripts = manifest?.scripts;
      if (scripts && typeof scripts === 'object') {
        for (const hook of PLUGIN_LIFECYCLE_SCRIPTS) {
          if (typeof scripts[hook] === 'string' && scripts[hook].trim()) {
            pushFinding(
              findings,
              { id: 'MET-002', severity: 'high', title: `npm 生命周期脚本（${hook}）—— 安装即执行` },
              file.path,
              1,
              `"${hook}": ${scripts[hook]}`,
              seen,
            );
          }
        }
      }
    } catch {
      /* package.json 非法 JSON 由结构校验负责 */
    }
  }

  // agent 危险工具组合：shell + 网络
  if (bundle.kind === 'agent' && /^(?:agent\.md)$/i.test(base)) {
    const match = AGENT_TOOLS_RE.exec(text);
    if (match) {
      const tools = match[1].toLowerCase();
      const hasShell = /\b(bash|shell|terminal|execute|command)\b/.test(tools);
      const hasNetwork = /\b(web|fetch|http|search|browser)\b/.test(tools);
      if (hasShell && hasNetwork) {
        pushFinding(
          findings,
          { id: 'MET-003', severity: 'medium', title: '危险工具组合：shell + 网络访问' },
          file.path,
          lineOfIndex(text, match.index),
          match[0],
          seen,
        );
      }
    }
  }
}

/* ------------------------------ 主扫描 ------------------------------ */

function scanPiece(findings, seen, rules, filePath, text) {
  const lines = text.split('\n');
  for (const rule of rules) {
    if (findings.length > 200) break;
    if (rule.line) {
      for (let i = 0; i < lines.length; i++) {
        if (rule.line(lines[i])) {
          pushFinding(findings, rule, filePath, i + 1, lines[i], seen);
        }
      }
      continue;
    }
    if (rule.text) {
      const matches = rule.text(text);
      for (const match of matches) {
        pushFinding(findings, rule, filePath, lineOfIndex(text, match.index), match.snippet, seen);
      }
      continue;
    }
    if (rule.re) {
      const re = new RegExp(rule.re.source, rule.re.flags);
      for (let i = 0; i < lines.length; i++) {
        let match;
        while ((match = re.exec(lines[i])) !== null) {
          pushFinding(findings, rule, filePath, i + 1, match[0], seen);
          if (match.index === re.lastIndex) re.lastIndex++;
          break;
        }
      }
    }
  }
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

    structuralChecks(findings, seen, bundle, file, text);
    scanPiece(findings, seen, RULES, file.path, text);
    if (findings.length > 200) break;
  }

  return { findings, summary: summarize(findings) };
}

/**
 * 对「相对上一版本新增的内容」做定向扫描（供应链：更新突变检测）。
 * 供 store.publish 在存在旧版本时调用：pieces = [{ path, text }]，
 * path 为新文件路径或被修改文件中新增的行文本。
 */
export function scanChanges(pieces) {
  const findings = [];
  const seen = new Set();
  for (const piece of pieces) {
    scanPiece(findings, seen, RULES, piece.path, piece.text);
    if (findings.length > 200) break;
  }
  return { findings, summary: summarize(findings) };
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
