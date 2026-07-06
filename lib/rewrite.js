// 内容重写：找热榜关联点 + 跨平台改写
// make(deps) 工厂注入 callLlmJson / getSkill / syncRealtimeHotspots / latestHotBatch
const { localDate } = require('./utils');
const { logAction } = require('./observability');
const { WEB_SEARCH_TOOL } = require('./llm');

function make(deps) {
  const { callLlmJson, getSkill, syncRealtimeHotspots, latestHotBatch } = deps;

  async function findRewriteHotspots(body) {
    const text = String(body.text || '').trim();
    if (!text) throw new Error('请输入需要分析的文章');
    const today = localDate();
    let localItems = latestHotBatch('all', today, 'realtime');
    let dataSource = 'database';
    let apiCalls = 0;
    if (!localItems.batch || localItems.batch.data_date !== today || !localItems.items?.length) {
      if (!body.allowApi) {
        logAction('rewrite-hotspots', 'button', 'no-today-data', { dataDate: today }, 0, 0);
        return { needsApiConfirmation: true, dataDate: today, hotspots: [], keywords: [], source: 'none' };
      }
      await syncRealtimeHotspots('灵感熔炉-创作助手确认刷新');
      localItems = latestHotBatch('all', today, 'realtime');
      dataSource = 'redfox-api';
      apiCalls = 1;
    }
    const analysis = await callLlmJson([
      {
        role: 'system',
        content: '你是中文内容编辑。提取适合搜索实时热榜的短关键词，必须包含文章里的核心实体或行业词，避免完整长句和"介绍、方法、分享"等空词。中文词控制在2-8字，英文词控制在1-3个单词。例如"NAS本地AI Agent"应拆成"NAS""AI Agent""本地AI"。输出严格 JSON：{"topic":"","keywords":[""]}，关键词 3-5 个。',
      },
      { role: 'user', content: text.slice(0, 12000) },
    ]);
    const keywords = Array.isArray(analysis.keywords)
      ? [...new Set(analysis.keywords.map(value => String(value).trim()).filter(Boolean))].slice(0, 5)
      : [];
    if (!keywords.length) return { topic: analysis.topic || '', keywords: [], hotspots: [] };
    const searchKeywords = [...new Set(keywords.flatMap(keyword => {
      const englishTokens = keyword.match(/[a-z][a-z0-9.+#-]*/gi) || [];
      return [keyword, ...englishTokens.filter(token => token.length >= 2)];
    }))].slice(0, 8);
    const uniqueCandidates = new Map();
    for (const row of localItems.items || []) {
      const raw = row.raw || {};
      const sources = Array.isArray(raw.sources) ? raw.sources : [];
      const base = sources[0] || raw;
      const item = {
        id: row.key,
        title: row.title,
        hotCount: row.score,
        platform: base.platform || 'all',
        platformName: base.platformName || (raw.plats || []).join('、') || '全网',
        rank: row.rank,
        createdAt: base.createdAt || raw.latestAt || localItems.batch?.completed_at,
        raw,
      };
      const matched = searchKeywords.some(keyword =>
        item.title.toLowerCase().includes(keyword.toLowerCase())
      );
      if (matched && !uniqueCandidates.has(item.id)) uniqueCandidates.set(item.id, item);
    }
    const candidates = Array.from(uniqueCandidates.values()).slice(0, 50);
    if (!candidates.length) {
      logAction('rewrite-hotspots', 'button', dataSource, { keywords, candidates: 0, dataDate: today }, apiCalls, 1);
      return { topic: analysis.topic || '', keywords, hotspots: [], source: dataSource, apiCalls, llmCalls: 1 };
    }

    let matches = [];
    try {
      const ranked = await callLlmJson([
        {
          role: 'system',
          content: '判断热点能否自然用于文章标题和前言。禁止只因共享"AI"等宽泛词就强行关联。输出严格 JSON：{"matches":[{"index":1,"relevance":0,"angle":""}]}。只保留相关度不低于60的项目，最多12项。',
        },
        {
          role: 'user',
          content: `文章主题：${analysis.topic || ''}\n文章摘要：${text.slice(0, 2500)}\n\n候选热点：\n${candidates.map((item, index) => `${index + 1}. [${item.platformName}] ${item.title}（热度 ${item.hotCount}）`).join('\n')}`,
        },
      ]);
      matches = Array.isArray(ranked.matches) ? ranked.matches : [];
    } catch (error) {
      console.warn('热点相关度分析失败，使用关键词匹配：', error.message);
      matches = candidates.map((item, index) => ({
        index: index + 1,
        relevance: keywords.some(keyword => item.title.toLowerCase().includes(keyword.toLowerCase())) ? 70 : 0,
        angle: '',
      }));
    }
    const hotspots = matches
      .filter(match => Number(match.relevance) >= 60)
      .map(match => {
        const idx = Number(match.index);
        // LLM 偶尔返回 0/负数/越界，显式 clamp；JS arr[-1] 已是 undefined，但与 inspiration 模块保持一致
        if (!Number.isInteger(idx) || idx < 1 || idx > candidates.length) return null;
        const item = candidates[idx - 1];
        return item ? { ...item, relevance: Number(match.relevance), angle: String(match.angle || '') } : null;
      })
      .filter(Boolean)
      .slice(0, 12);
    logAction('rewrite-hotspots', 'button', dataSource, {
      keywords, candidates: candidates.length, matches: hotspots.length, dataDate: today,
    }, apiCalls, 2);
    return {
      topic: String(analysis.topic || ''), keywords, hotspots,
      source: dataSource, apiCalls, llmCalls: 2, dataDate: today,
    };
  }

  async function rewriteForPlatform(body) {
    const text = String(body.text || '').trim();
    if (!text) throw new Error('请输入原文');
    const platform = String(body.platform || '小红书');
    const tone = String(body.tone || '专业、清晰、有观点');
    const mode = String(body.mode || 'rewrite');
    const hotspot = body.hotspot && typeof body.hotspot === 'object' ? {
      title: String(body.hotspot.title || '').slice(0, 200),
      platformName: String(body.hotspot.platformName || '').slice(0, 30),
      angle: String(body.hotspot.angle || '').slice(0, 300),
    } : null;
    const hotspotInstruction = hotspot?.title
      ? `选定热点：${hotspot.title}（${hotspot.platformName}）。可用关联角度：${hotspot.angle || '自行判断'}。热点主要用于标题和前言，正文不得为了关联而篡改原文事实；若关联牵强，应在标题和前言中弱化处理。`
      : '未选择热点，不要虚构或强行加入热点。';
    const writeSkillMap = {
      '小红书': 'xiaohongshu-write',
      '公众号': 'wechat-write',
      '知乎': 'zhihu-write',
      '抖音': 'multi-write',
      '视频号': 'multi-write',
      '快手': 'multi-write',
      '哔站': 'multi-write',
    };
    const rewriteSkillMap = {
      '小红书': 'xiaohongshu-rewrite',
      '公众号': 'wechat-rewrite',
      '知乎': 'zhihu-rewrite',
      '抖音': 'multi-rewrite',
      '视频号': 'multi-rewrite',
      '快手': 'multi-rewrite',
      '哔站': 'multi-rewrite',
    };
    const skillSlug = mode === 'create'
      ? (writeSkillMap[platform] || 'multi-write')
      : (rewriteSkillMap[platform] || 'multi-rewrite');
    const finalSkillSlug = getSkill(skillSlug) ? skillSlug : (rewriteSkillMap[platform] || 'multi-rewrite');
    let skillInstruction = '';
    const skill = getSkill(finalSkillSlug);
    if (skill?.description) {
      skillInstruction = `\n\n参考 RedFox ${finalSkillSlug} skill 方法论（按此风格输出）：\n${String(skill.description).slice(0, 400)}`;
    }
    let styleInstruction = '';
    if (body.styleProfile && typeof body.styleProfile === 'object') {
      const p = body.styleProfile;
      const bits = [];
      if (p['标题DNA']?.典型句式?.length) bits.push(`标题参考句式：${p['标题DNA'].典型句式.slice(0, 3).join('；')}`);
      if (p['标题DNA']?.情绪钩子) bits.push(`标题情绪钩子：${p['标题DNA'].情绪钩子}`);
      if (p['表达风格']?.句式) bits.push(`句式偏好：${p['表达风格'].句式}`);
      if (p['表达风格']?.词汇偏好) bits.push(`词汇偏好：${p['表达风格'].词汇偏好}`);
      if (p['表达风格']?.节奏) bits.push(`节奏：${p['表达风格'].节奏}`);
      if (p['表达风格']?.幽默度) bits.push(`幽默度：${p['表达风格'].幽默度}`);
      if (p['创作边界']?.length) bits.push(`避免：${p['创作边界'].join('、')}`);
      if (bits.length) styleInstruction = `\n\n参考风格档案（仅作为风格指引，不得编造新事实）：\n${bits.join('\n')}`;
    }
    const modeInstruction = mode === 'create'
      ? `基于用户给定的主题/大纲/结构要求，创作一篇全新的${platform}内容。用户素材中已明确提到的具体内容（如产品名称、功能点、推荐人群等）必须如实呈现；用户要求介绍/对比的主体可按其提供的要点扩展结构与表达，但不得无中生有地补充用户未提及的功能细节、数据、时间表。`
      : mode === 'adapt'
        ? `直接把素材改写为${platform}风格（不补充新事实，仅风格转换、句式重组）。`
        : `将素材重构为${platform}内容（在原素材基础上扩展结构和打磨）。`;
    let userInstructionPriority = mode === 'create'
      ? `

【用户指令优先级最高】用户在原始素材中已明确写出的内容（标题、对比对象、核心定位、推荐人群、文章结构如"前言+内容+总结"等）必须严格遵循，不要用 skill 方法论覆盖用户的明确要求。skill 风格仅作为参考润色手段。`
      : '';
    const useWebSearch = mode === 'create' && String(text || '').length < 300;
    const toolOption = useWebSearch ? { tools: WEB_SEARCH_TOOL } : {};
    if (useWebSearch) {
      userInstructionPriority += '\n\n你可以使用 web_search 工具查询最新的产品、功能点、热点等信息，需要时就调用，不要直接瞎编。';
    }
    const result = await callLlmJson([
      {
        role: 'system',
        content: `你是中文自媒体编辑。${modeInstruction}风格：${tone}。${userInstructionPriority}热点只用于标题和前言的自然切入，不能借热点编造正文事实。输出严格 JSON：{"title":"","intro":"","content":""}。title 是成稿标题，intro 是独立前言，content 是不重复标题和前言的正文。${skillInstruction}${styleInstruction}`,
      },
      {
        role: 'user',
        content: `${hotspotInstruction}

原始素材：
${text}`,
      },
    ], toolOption);
    let validated = result;
    const needFactCheck = mode !== 'create' || useWebSearch;
    if (needFactCheck) {
      try {
        const factCheckInstruction = useWebSearch
          ? '你是事实校对编辑。create 模式下用户开了联网搜索，AI 可能引用了搜索结果。规则：（1）用户原始素材中明确出现过的内容全部保留；（2）从联网搜索得到的内容可保留，但删除凭空编造的具体数字、时间、价格、统计百分比、版本号、产品参数（除非这些信息来自素材或搜索结果可验证）；（3）保留 JSON 字段不变。'
          : '你是严格的事实校对编辑。逐句检查草稿，只保留能从"原始素材"或"允许使用的热点标题"直接推出的内容。删除所有新增的原因、功能细节、时间判断、法规推测、产品示例和数据，不得用常识补全。素材信息少时允许成稿很短。保持 JSON 字段不变，只输出 {"title":"","intro":"","content":""}。';
        validated = await callLlmJson([
          { role: 'system', content: factCheckInstruction },
          {
            role: 'user',
            content: `原始素材：
${text}

允许使用的热点标题：
${hotspot?.title || '无'}

待校对草稿：
${JSON.stringify(result)}`,
          },
        ]);
      } catch (error) {
        console.warn('重构事实校对失败，返回初稿：', error.message);
      }
    }
    return {
      title: String(validated.title || '').trim(),
      intro: String(validated.intro || '').trim(),
      content: String(validated.content || '').trim(),
      model: process.env.LLM_MODEL || 'LLM',
      hotspot,
    };
  }

  return { findRewriteHotspots, rewriteForPlatform };
}

module.exports = { make };
