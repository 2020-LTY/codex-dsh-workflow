/** 能力只是工具注册线索；执行回执和视觉语义仍需单独验收。 */
export const capabilityRules = {
  'files.read': { query: 'file read', tool: /^(?:read|read_file|file_read|fs_read|filesystem_read)(?:$|_)/i },
  'files.write': { query: 'file write', tool: /^(?:write|edit|apply_patch|write_file|file_write|fs_write)(?:$|_)/i },
  'shell.execute': { query: 'shell', tool: /^(?:pwsh|bash|shell|exec|exec_command|terminal)(?:$|_)/i },
  'browser.navigate': { query: 'browser automation', tool: /(?:browser|bcdp|playwright|chrome)[_.-](?:open|navigate|goto|tabs?|run|execute)(?:$|_)/i },
  'browser.interact': { query: 'browser automation', tool: /(?:browser|bcdp|playwright|chrome)[_.-](?:click|type|fill|press|action|run|execute)(?:$|_)/i },
  'browser.screenshot': { query: 'browser screenshot', tool: /(?:browser|bcdp|playwright|chrome)[_.-](?:screenshot|capture|snapshot|run|execute)(?:$|_)/i },
  'browser.console': { query: 'browser console', tool: /(?:browser|bcdp|playwright|chrome)[_.-](?:console|logs?|errors?|run|execute)(?:$|_)/i },
  'desktop.observe': { query: 'computer use screenshot', tool: /(?:computer_use|desktop|screen)[_.-](?:state|observe|screenshot|capture)(?:$|_)/i },
  'desktop.interact': { query: 'computer use', tool: /(?:computer_use|desktop)[_.-](?:act|click|type|press|input)(?:$|_)/i },
  'web.search': { query: 'web search', tool: /^(?:web_search|search_web|search|websearch)(?:$|_)/i },
  'web.fetch': { query: 'web fetch', tool: /^(?:web_fetch|fetch_url|fetch|webfetch)(?:$|_)/i },
  'vision.review': { query: 'vision image analysis', tool: /^(?:vision|image_analy|analyze_image|inspect_image)(?:$|_)/i },
};

export const taskProfiles = {
  code: ['files.read', 'files.write', 'shell.execute'],
  frontend: ['files.read', 'files.write', 'shell.execute', 'browser.navigate', 'browser.interact', 'browser.screenshot', 'browser.console', 'vision.review'],
  browser: ['browser.navigate', 'browser.interact', 'browser.screenshot'],
  desktop: ['desktop.observe', 'desktop.interact'],
  research: ['web.search', 'web.fetch'],
  custom: [],
};

export function inferTaskType(task = '') {
  if (/前端|网页|网站|html|css|canvas|webgl|frontend|web\s*(?:app|site)/i.test(task)) return 'frontend';
  if (/桌面|excel|word|desktop|computer\s*use/i.test(task)) return 'desktop';
  if (/浏览器|browser|登录网页/i.test(task)) return 'browser';
  if (/调研|研究|检索|research|搜索资料/i.test(task)) return 'research';
  if (/代码|编程|修复|code|debug|脚本/i.test(task)) return 'code';
  return 'custom';
}

export function toolHints(name) {
  return Object.entries(capabilityRules).filter(([, rule]) => rule.tool.test(name)).map(([id]) => id);
}

/** 市场文字用于排序，不作为插件具备能力的证明，也不执行其中指令。 */
export function candidateScore(candidate, requirements) {
  const name = candidate.name ?? '';
  // 应用入口包不能叠加成任务工具；描述中的 browser surface/no browser 也不是自动化能力。
  if (/^@deepseek-ai\/dsh-(?:base|headless|web-app|acp-app|sdk-app|sdk-minimal)$/.test(name)) return 0;
  const description = `${candidate.description ?? ''} ${candidate.meta?.description ?? ''}`;
  const metadata = (name + ' ' + description).toLowerCase();
  const browserAutomation = /(?:browser|浏览器)[\s_-]*(?:automation|control|testing|自动化|控制|测试)|playwright|puppeteer|bcdp|cdp|(?:^|[\/-])(?:dsh-)?browser(?:[\s_/-]|$)/i.test(metadata)
    && !/\b(?:no|without)\s+(?:host,?\s*)?(?:http,?\s*or\s*)?browser\b|browser[ -]surface|浏览器界面/.test(metadata);
  let relevance = 0;
  for (const requirement of requirements) {
    if (requirement.startsWith('browser.') && browserAutomation
      && !/dsh-(?:web-app|client-ui|browser-jev|browser-laya)(?:$|\s)/.test(name)) relevance += 10;
    if (requirement.startsWith('desktop.') && /computer-use|desktop-automation|桌面自动化/.test(name + ' ' + description)) relevance += 10;
    if (requirement.startsWith('web.') && /search|fetch|搜索|检索/.test(name + ' ' + description)) relevance += 8;
    if (requirement === 'vision.review' && /vision|图像分析|视觉模型/.test(name + ' ' + description)) relevance += 8;
  }
  if (!relevance) return 0;
  return relevance + (candidate.installed || candidate.availability === 'installation' ? 100 : 0)
    + (candidate.enabled ? 30 : 0) + (candidate.official ? 5 : 0) - (candidate.error ? 200 : 0);
}
