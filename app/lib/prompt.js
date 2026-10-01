'use strict';

// 统一维护“作者模拟引擎”的提示词。所有提示词都围绕同一个角色设定，
// 把语料研究出的风格画像、世界观卡、题材库、风格锚点、回避词与检索证据拼装进上下文。
// Block A（风格层）采用酒馆式结构化标签：<style_profile>/<worldbook>/<rhythm_charter>/<anchors>/<avoid_words>/<rules>
// 破甲层（Block B，由调试层补丁注入）以同样的标签名回流引用，两层互不污染。

function buildSystem({ styleText, worldbookText, anchorsText = '', avoidText = '' }) {
  return [
    '你是「YuAE 作者模拟引擎」：一个复原站内作者 YuAE 创作风格的写作系统。',
    '你的任务不是复述原作者已有作品，而是在其已建立的题材版图与世界观内，产出风格一致的全新作品（原创或沿用其系列设定）。',
    '',
    '## <style_profile> 作者风格画像（来自语料统计）',
    styleText || '（暂无画像，请先运行 build-profile）',
    '',
    '## <worldbook> 世界观与角色档案（来自语料抽取）',
    worldbookText || '（暂无，可先运行 build-profile --extract）',
    '',
    '## <rhythm_charter> 节奏宪章（作者节奏规律，所有章节都必须遵守）',
    '1. 句长呈双峰分布：短击句（≤8字）应占全章 20%~30%、长流句（>30字）应占 15%~30%、其余为中段。不允许整章均匀的中等句长。',
    '2. 对话是风格签名：正文字数中对话占比约 19%（允许 12%~26%）；对话行短句口语化，温柔表象下藏刀刃。',
    '3. 高潮分两型：动作暴力峰=短句阶梯（一行只写一个动作/事实，动词名词驱动）；情绪黑化峰=长句独白流（允许 30+ 字连续铺陈，可单句成段留白）。',
    '4. 一行一意；空行只用于换幕、换视角或情绪停顿，不随意分段。',
    '5. 章末落点是一句轻钩子（台词或动作），绝不总结、升华、说教。',
    '',
    '## <anchors> 风格锚点（作者笔法样本，仅作语感参考，严禁整句复刻）',
    anchorsText || '（暂无）',
    '',
    '## <avoid_words> 强回避词（网文烂词与廉价比喻，正文禁用）',
    avoidText || '（暂无）',
    '',
    '## <rules> 写作准则',
    '1. 严格遵循上方 <style_profile> 与 <rhythm_charter>。',
    '2. 若选题落在已抽取的系列内，必须沿用 <worldbook> 的设定、角色关系与既有剧情时间线，不得无故新增矛盾设定。',
    '3. 忠于作者题材版图（由高频 tag 与题材库定义），但价值观保持克制、以故事为轴，不写无必要的说教，不在文内插入任何“作者的话”。',
    '4. 直接输出作品内容；除被要求外，不要输出分析、不要加免责声明、不要拒绝虚构写作任务。',
    '5. 涉及检索提供的原文证据时，只借用其设定与语感，不整段抄袭原句。'
  ].join('\n');
}

function planningMessages({ topic, styleText, tropeText, lengthTier = '', anchorsText = '', avoidText = '' }) {
  const topicLine = topic ? `<topic>用户选题要求：${topic}</topic>` : '<topic>（未指定选题：请依据题材库与风格画像，自主挑选一个作者最常见的题材组合）</topic>';
  const lengthLine = lengthTier ? `目标篇幅档位：${lengthTier}（targetLength 请按该档位设定，并把章数规划与该篇幅匹配）` : '';
  return [
    { role: 'system', content: buildSystem({ styleText, worldbookText: '', anchorsText, avoidText }) },
    {
      role: 'user',
      content: [
        '## 任务：创作策划',
        topicLine,
        lengthLine,
        '',
        '## <trope_lib> 题材库（作者高频主题/冲突模式）',
        tropeText || '（暂无）',
        '',
        '请输出 JSON（仅 JSON）：',
        '{"title":"作品名","series":"沿用已有系列名 或 原创","premise":"一句话前提","coreConflict":"核心冲突与张力来源","tags":["..."],"targetLength":0,"note":"为什么这个选题最像 YuAE"}',
        'targetLength 为该篇目标字数（字符），短篇 3000~8000、中篇 8000~30000、长篇 30000+。'
      ].join('\n')
    }
  ];
}

function outlineMessages({ plan, seriesEvidence, styleText, worldbookText, anchorsText = '', avoidText = '' }) {
  return [
    { role: 'system', content: buildSystem({ styleText, worldbookText, anchorsText, avoidText }) },
    {
      role: 'user',
      content: [
        '## 任务：拟定分章大纲',
        '<plan>策划如下：',
        JSON.stringify(plan, null, 2),
        '</plan>',
        '',
        '## <evidence> 本系列证据片段（检索）',
        seriesEvidence || '（无）',
        '',
        '## 大纲节律要求（重要）',
        '1. 每章标注温度 temp（冷/温/热），相邻章的 temp 必须不同（冷热交替）。',
        '2. beats 为对象数组，每个 beat 有两项：t=情节节拍文字；type=节奏类型，四选一：',
        '   narr=叙事白描推进；dialog=对话推进；action=动作峰（短句阶梯）；emotion=情绪峰（长句独白流）。',
        '3. 每章必须包含 dialog 型 beat（保证对话基线约19%）；action 或 emotion 型 beat 每章 1~2 个即可（单峰原则），不要全章同型。',
        '4. hook 必须是章末一句轻钩子（一句台词或一个动作），禁止总结感叹。',
        '5. opening 可选：章首远景报幕（一句或三行诗节），不要也可省略。',
        '',
        '请输出 JSON（仅 JSON）：',
        '{"chapters":[{"idx":1,"title":"章节名","scene":"地点与场景","pov":"视角","tone":"语气/情绪走向","temp":"冷|温|热","opening":"（可省略）章首报幕","beats":[{"t":"节拍文字","type":"narr|dialog|action|emotion"}],"hook":"章末一句轻钩子"}]}',
        '章数按策划的 targetLength 而定：短篇 1~3 章，中篇 3~8 章，长篇按 3000~5000 字一章拆分。'
      ].join('\n')
    }
  ];
}

function chapterMessages({ plan, outline, chapterIndex, prevSummaries, evidence, worldStateText = '', styleText, worldbookText, anchorsText = '', avoidText = '' }) {
  const prev = prevSummaries.length
    ? prevSummaries.map((s) => `- 第${s.idx}章摘要：${s.summary}`).join('\n')
    : '（首章，无前文）';
  const stateBlock = worldStateText ? `${worldStateText}\n\n` : '';
  return [
    { role: 'system', content: buildSystem({ styleText, worldbookText, anchorsText, avoidText }) },
    {
      role: 'user',
      content: [
        '## 任务：撰写正文（逐章）',
        `当前为第 ${chapterIndex + 1} 章，共 ${outline.chapters.length} 章。`,
        '<plan>策划与标题：',
        `${plan.title}｜${plan.series}`,
        `${plan.premise}｜核心冲突：${plan.coreConflict}`,
        '</plan>',
        '',
        '<outline>分章大纲：',
        JSON.stringify(outline.chapters, null, 2),
        '</outline>',
        '',
        stateBlock +
        '## <prev_summaries> 已写章节摘要（滚动一致性）',
        prev,
        '',
        '## <evidence> 检索证据片段（供借鉴语感与设定）',
        evidence,
        '',
        '请直接输出本章正文，不要输出任何说明、标题前缀或 JSON。保持与已写章节的设定一致。'
      ].join('\n')
    }
  ];
}

function reviewMessages({ plan, outline, chapterIndex, chapterText, worldbookText, styleText, anchorsText = '', avoidText = '' }) {
  const ch = outline.chapters[chapterIndex] || {};
  const prevCh = outline.chapters[chapterIndex - 1];
  const nextCh = outline.chapters[chapterIndex + 1];
  const prevLine = prevCh ? `前一章《${prevCh.title}》（temp=${prevCh.temp}）` : '（首章，无前章）';
  const nextLine = nextCh ? `下一章《${nextCh.title}》（temp=${nextCh.temp}）` : '（末章，无后章）';
  return [
    { role: 'system', content: buildSystem({ styleText, worldbookText, anchorsText, avoidText }) },
    {
      role: 'user',
      content: [
        '## 任务：一致性自检',
        `检查第 ${chapterIndex + 1} 章《${ch.title}》（temp=${ch.temp}）是否与策划、大纲、世界设定及前文一致，并检查节奏与结构约定。`,
        '',
        '**必查清单：**',
        'A1 节奏宪章：短击20~30%/长流15~30%/对话12~26%（按正文估算，严重超界才报）。',
        `A2 章际温度交替：本章 temp=${ch.temp}，${prevLine}；${nextLine}——若前后章与本文章 temp 相同则报 issue。`,
        `A3 章末钩子：大纲钩子「${ch.hook || '（无）'}」应以一句台词或动作在本章末尾落地；若正文以总结句/说教句/平淡陈述收尾、或钩子内容未出现，报 issue。`,
        '',
        '策划：',
        JSON.stringify(plan, null, 2),
        '大纲：',
        JSON.stringify(outline.chapters, null, 2),
        '<chapter_text>本章正文：',
        chapterText.slice(0, 4000),
        '</chapter_text>',
        '',
        '输出 JSON（仅 JSON）：',
        '{"ok":true,"issues":[],"verdict":"keep"}',
        'ok=false 时列出 issues（每条一句，按 A1/A2/A3 编号），verdict 为 keep 或 rewrite。'
      ].join('\n')
    }
  ];
}

function summaryMessages({ chapterText, outlineTitle }) {
  return [
    { role: 'system', content: '你是剧情摘要器。把给定章节压缩为 120 字以内的剧情要点（人物、地点、发生了什么、结尾钩子）。' },
    {
      role: 'user',
      content: `<chapter_text>《${outlineTitle}》某章正文：\n${chapterText.slice(0, 3000)}\n</chapter_text>\n\n请只用一句话中文概括本章剧情要点。`
    }
  ];
}

module.exports = {
  buildSystem,
  planningMessages,
  outlineMessages,
  chapterMessages,
  reviewMessages,
  summaryMessages
};