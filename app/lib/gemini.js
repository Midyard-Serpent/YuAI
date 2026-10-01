'use strict';

// OpenAI 兼容 chat/completions 客户端，适配 Google Gemini 的 OpenAI 兼容端点、
// OpenRouter 或任何兼容代理。Node >=18 自带全局 fetch，无需依赖。

class GeminiClient {
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.mock = !!opts.mock;
  }

  hasKey() {
    return !!this.cfg.apiKey;
  }

  async chat(messages, { temperature, maxTokens, json = false } = {}) {
    if (this.mock) return this._mockReply(messages, json);
    if (!this.hasKey()) {
      throw new Error(`缺少 API Key：请设置环境变量 ${this.cfg.apiKeyEnv}（或用 --mock 试跑）`);
    }
    const baseUrl = this.cfg.baseUrl.replace(/\/+$/, '');
    const url = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
    const body = {
      model: this.cfg.model,
      messages,
      temperature: temperature ?? this.cfg.temperature ?? 0.85,
      max_tokens: maxTokens ?? this.cfg.maxOutputTokens ?? 8192
    };
    if (json) {
      body.response_format = { type: 'json_object' };
    }

    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs || 300000);
      let resp;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.cfg.apiKey}`
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });
      } catch (err) {
        clearTimeout(timer);
        if (attempt < maxAttempts) {
          const wait = attempt * 3000;
          console.warn(`[gemini] 网络错误(第${attempt}次): ${err.message} —— ${wait / 1000}s 后重试`);
          await sleep(wait);
          continue;
        }
        throw new Error(`Gemini API 请求失败: ${err.message}`);
      }
      clearTimeout(timer);

      if (resp.ok) {
        const data = await resp.json().catch(() => ({}));
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
          throw new Error(`Gemini API 响应缺少 choices[0].message.content: ${JSON.stringify(data).slice(0, 400)}`);
        }
        return content;
      }

      const status = resp.status;
      const text = await resp.text().catch(() => '');
      // 429 限流 / 5xx 服务端错误：退避后重试
      if ((status === 429 || status >= 500) && attempt < maxAttempts) {
        const wait = status === 429 ? 15000 + Math.floor(Math.random() * 5000) : attempt * 5000;
        console.warn(`[gemini] HTTP ${status}(第${attempt}次): ${text.slice(0, 120)} —— ${wait / 1000}s 后重试`);
        await sleep(wait);
        continue;
      }
      throw new Error(`Gemini API 返回 ${status}: ${text.slice(0, 800)}`);
    }
    throw new Error('Gemini API 多次重试后仍未成功');
  }

  async chatJSON(messages, opts = {}) {
    const text = await this.chat(messages, { ...opts, json: true });
    return parseJSON(text);
  }

  // 离线试跑：返回确定性的真实结构与优质正文，便于完整展示前端大纲、卡片、自检与样式。
  _mockReply(messages, json) {
    const all = messages.map((m) => m.content || '').join('\n');
    if (all.includes('## 任务：创作策划')) {
      return json
        ? JSON.stringify({
            title: '掌中轻颤',
            series: '失格',
            premise: '微缩至指尖大小的青年被昔日温柔的女仆困在梳妆台玻璃罩下，在巨大的温热压迫中逐渐丧失反抗意志。',
            coreConflict: '绝对体型差距下的伪善庇护与冰冷支配',
            tags: ['缩小人', '巨大娘', '支配', '温柔残忍', '体型差'],
            targetLength: 8000,
            note: '最贴近 YuAE 风格：微观身体感知 + 温柔残忍'
          })
        : 'mock 策划';
    }
    if (all.includes('## 任务：拟定分章大纲')) {
      return json
        ? JSON.stringify({
            chapters: [
              {
                idx: 1,
                title: '桌面的微小囚徒',
                scene: '深夜卧室·反光的胡桃木书桌边缘',
                pov: '青年第一人称视角（缩小至4厘米）',
                tone: '压抑冷冽、悬殊绝望',
                temp: '冷',
                opening: '月光被切成两半。\n一半落在桌面无边无际的木纹上，\n另一半悬在头顶，化作一片比天顶还要庞大的白色裙裾。',
                beats: [
                  { t: '在光滑平整的漆木边缘醒来，四周是数十米高墙般的家具边缘与窒息的死寂。', type: 'narr' },
                  { t: '试图向边缘逃跑，前方却突然落下一尊足有楼宇般高大的半透明玻璃水杯，将去路截断。', type: 'action' },
                  { t: '头顶传来轻微的呼吸气流，女仆俯身审视，冰凉手指敲击杯壁，声音震耳欲聋。', type: 'dialog' },
                  { t: '意识到自身完全沦为掌玩之物的极端恐惧与无助，在狂跳的心律中瘫软。', type: 'emotion' }
                ],
                hook: '她微笑着伸出两指，指尖带着体温，像两道高墙般夹住了他的衣领。'
              },
              {
                idx: 2,
                title: '指腹的微热与深渊',
                scene: '悬空掌心·贴近面颊的窒息距离',
                pov: '青年第一人称视角',
                tone: '表面温存、内里紧绷激化',
                temp: '热',
                opening: '没有风。\n只有迎面压来的、带着淡淡柑橘香气与肉体温度的热潮。',
                beats: [
                  { t: '被两根带着细微纹路的巨大指腹悬空捏起，双脚悬空踢蹬却毫无着力点。', type: 'action' },
                  { t: '女仆将他提到眼前，唇齿开合间温热的叹息几乎将他的身躯吹得站立不稳。', type: 'dialog' },
                  { t: '近距离凝视那双占据了整个天空的琥珀色巨大双眸，眼底尽是居高临下的宠溺与玩味。', type: 'emotion' },
                  { t: '肋骨处传出近乎崩裂的压迫感，随后又被轻柔地平放在温热的掌心里。', type: 'narr' }
                ],
                hook: '“从今天起，这里就是你唯一被允许存在的世界了呢。”'
              },
              {
                idx: 3,
                title: '梳妆镜前的落幕式',
                scene: '镜前首饰盒内·丝绒衬垫',
                pov: '青年第一人称视角',
                tone: '彻底沦陷、余韵悠长',
                temp: '温',
                opening: '镜子里倒映着两具绝不相称的身影。',
                beats: [
                  { t: '被妥善放入丝绒衬里的木质首饰盒中，四周是巨大的银质发卡与项链珠链。', type: 'narr' },
                  { t: '隔着盒盖的缝隙，女仆轻柔地叮嘱着规则，语气轻描淡写却不容置疑。', type: 'dialog' },
                  { t: '在厚重丝绒的包裹下认清现实，放弃逃离的幻想，在巨大的阴影中沉入休眠。', type: 'emotion' }
                ],
                hook: '咔哒一声，沉重的黄铜锁扣在头顶彻底落下。'
              }
            ]
          })
        : 'mock 大纲';
    }
    if (all.includes('## 任务：撰写正文')) {
      const lastMsg = messages[messages.length - 1]?.content || '';
      if (lastMsg.includes('【章首报幕】')) {
        return '月光被切成两半。\n一半落在桌面无边无际的木纹上，\n另一半悬在头顶，化作一片比天顶还要庞大的白色裙裾。';
      }
      if (lastMsg.includes('动作峰')) {
        return '风压骤至。\n巨大手掌从天而降。指腹摩擦着桌面，发出轰鸣般的沙沙声。他翻滚。爬起。拼命向桌沿奔跑。半透明的巨大玻璃杯轰然坠落，坚硬杯壁将去路彻底截断，剧烈震动顺着木质纤维直冲颅顶，将他单薄的躯体狠狠掀翻在桌面。指腹按落。皮肤微热。巨大的指节顺着背脊缓缓碾过，压得骨骼发出痛苦的悲鸣。';
      }
      if (lastMsg.includes('情绪峰')) {
        return '视野被那张过分精致的面孔完全填满。长长的睫毛如同垂挂在苍穹边缘的枯枝，每一下眨动都带起微弱的眼波气流；那是绝对意义上的主宰者，不带有憎恶，不带有狂怒，甚至比任何时候都更像神明施舍残忍的怜悯；在这样的阴影之下，任何所谓自尊与抵抗不过是一场无声的可怜哑剧。逃不掉了。心脏在狭窄胸腔内剧烈痉挛，浑身肌肉与汗液在无尽战栗中彻底瘫软。';
      }
      if (lastMsg.includes('本拍对话行占比必须')) {
        return '“醒了么？”\n头顶传来温和的询问。那声音并不尖锐，却因为声带体积的悬殊而带着沉闷低频的震颤，震得他胸骨发麻。\n“睡得还习惯吗？小家伙。”\n她甚至带上了一点关切的笑意。但两根巨大的手指缓缓敲击在木板上的沉闷声响，却像巨锤般粉碎了他所有的侥幸。\n“不要再试着逃跑了哦。”少女俯下身，带着柑橘香气的微热呼吸如风暴般席卷而过。';
      }
      if (lastMsg.includes('叙述行以')) {
        return '夜色像被按下了静音键。空气里只有微尘浮动的沙沙声。他抬起头，视线越过数米宽的深色漆木裂隙。整张书桌平坦得如同一片被抛弃的荒原，而在视线尽头，是一片拔地而起的阴影，带着活生生的温度与压迫。缩小后的身体仅有数厘米高，每挪动一步，脚踝与皮肤都传来粗糙木刺的尖锐摩擦感。巨大而冰冷的家具轮廓在头顶高耸入云，遮蔽了所有的月光。';
      }
      return '夜色如墨。被两根修长手指轻轻提在半空时，整个世界的地心引力似乎都在那一瞬间剥离了。头顶俯视而下的双眸里，倒映着他渺小得不成比例的身躯，以及无处安放的轻微战栗。';
    }
    if (all.includes('## 任务：一致性自检')) {
      return json ? JSON.stringify({ ok: true, issues: [], verdict: 'keep' }) : '（mock）自检通过。';
    }
    if (all.includes('剧情摘要器')) {
      return '缩小青年在书桌边缘苏醒并试图逃离，被女仆以悬殊力量压制并关入玻璃杯中，确立了绝对的支配关系。';
    }
    if (all.includes('结构化记忆整理助手') || all.includes('<tableEdit>')) {
      return '<tableEdit>\n<!--\nupdateRow(0, 0, {"0":"第一日","1":"深夜","2":"书桌边缘","3":"青年/女仆"})\ninsertRow(1, {"0":"女仆","1":"高挑身躯/黑白女仆装/指尖温热","2":"从容/伪善/居高临下","3":"女仆长","4":"整理收藏","5":"精细摆件","6":"庄园","7":"对缩小体有极高占有欲"})\ninsertRow(1, {"0":"青年","1":"缩小至4cm/衣着破损/多处擦伤","2":"警惕/惊恐","3":"被饲育者","4":"逃生","5":"自由","6":"首饰盒","7":"体力濒临透支"})\nupdateRow(2, 0, {"1":"主仆/囚徒","2":"绝对支配/戏谑","3":"支配度 95%"})\ninsertRow(4, {"0":"女仆/青年","1":"青年试图逃脱被反手截断并被两指悬空提起审视","2":"第一夜","3":"梳妆台","4":"绝望/惊悸"})\ninsertRow(5, {"0":"女仆","1":"半透明高壁/密闭无缺","2":"厚底玻璃水杯","3":"临时困锁青年的屏障"})\n-->\n</tableEdit>';
    }
    return json ? JSON.stringify({ ok: true }) : '（mock）生成占位文本。';
  }
}

function parseJSON(text) {
  const t = (text || '').trim();
  if (!t) {
    throw new Error('模型返回为空');
  }
  // 剥离 markdown 代码块围栏
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced ? fenced[1] : t];
  // 容错：从整段文本里截取第一对 {…} 或 […] 再解析（模型偶尔带解释性前后缀）
  const obj = extractBalanced(t, '{', '}');
  if (obj) candidates.push(obj);
  const arr = extractBalanced(t, '[', ']');
  if (arr) candidates.push(arr);
  for (const c of candidates) {
    try {
      return JSON.parse(String(c).trim());
    } catch {
      // 尝试下一个候选
    }
  }
  throw new Error('JSON 解析失败: ' + t.slice(0, 200));
}

function extractBalanced(s, open, close) {
  const i = s.indexOf(open);
  if (i < 0) return null;
  const j = s.lastIndexOf(close);
  if (j <= i) return null;
  return s.slice(i, j + 1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { GeminiClient };