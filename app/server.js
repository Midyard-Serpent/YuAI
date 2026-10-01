const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { doPlan, doOutline, doChapter, summarizeChapter, resetIndex } = require('./lib/workflow');
const { loadConfig } = require('./lib/config');
const { getConn, setConn, publicConn } = require('./lib/settings-store');
const { runBuild, extractWorldbook } = require('./lib/build');
const { loadWorks } = require('./lib/corpus');
const { GeminiClient } = require('./lib/gemini');
const { analyzeChapter } = require('./lib/analyze');
const { defaultMemory, normalizeMemory, loadMemory, saveMemory } = require('./lib/memory');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.post('/api/plan', async (req, res) => {
  try {
    const { topic, series, mock, overrides } = req.body;
    const plan = await doPlan({ topic, series, mock, overrides });
    res.json({ success: true, data: plan });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/outline', async (req, res) => {
  try {
    const { plan, mock, overrides } = req.body;
    const outline = await doOutline({ plan, mock, overrides });
    res.json({ success: true, data: outline });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/chapter', async (req, res) => {
  try {
    const { plan, outline, chapterIndex, prevSummaries, mock, overrides, slug } = req.body;
    const result = await doChapter({ plan, outline, chapterIndex, prevSummaries, mock, overrides, slug });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/util/summarize-chapter', (req, res) => {
  try {
    const { outlineChapter } = req.body;
    const summary = summarizeChapter(outlineChapter);
    res.json({ success: true, data: summary });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/save', (req, res) => {
  try {
    const { title, md, plan, outline, chaptersData } = req.body;
    const cfg = loadConfig(__dirname);
    const slug = `${Date.now()}_${title.replace(/[\\/:*?"<>|\r\n\t\s]+/g, '_').slice(0, 50)}`;
    const outDir = path.join(cfg.outDir, slug);
    
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, '作品.md'), md, 'utf8');
    fs.writeFileSync(path.join(outDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
    fs.writeFileSync(path.join(outDir, 'outline.json'), JSON.stringify(outline, null, 2), 'utf8');
    
    chaptersData.forEach((ch, idx) => {
      fs.writeFileSync(path.join(outDir, `chapter_${String(idx + 1).padStart(2, '0')}.txt`), ch, 'utf8');
    });

    res.json({ success: true, outDir });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 作品库 / 大纲工作台 / 拨档 / 补丁 / 符合度（主前端工作台后端能力） ──
function readJSONSafe(file) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  } catch {
    return null;
  }
}

function sanitizeSlugForPath(slug) {
  return String(slug || '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
}

app.get('/api/works', (req, res) => {
  try {
    const cfg = loadConfig(__dirname);
    const list = fs.existsSync(cfg.outDir)
      ? fs.readdirSync(cfg.outDir)
          .filter((d) => fs.statSync(path.join(cfg.outDir, d)).isDirectory())
          .map((slug) => {
            const dir = path.join(cfg.outDir, slug);
            const plan = readJSONSafe(path.join(dir, 'plan.json'));
            const chapters = fs.existsSync(dir)
              ? fs.readdirSync(dir).filter((f) => /^chapter_\d+\.txt$/.test(f)).length
              : 0;
            return { slug, title: plan?.title || slug, series: plan?.series || '', chapters, hasMd: fs.existsSync(path.join(dir, '作品.md')), outDir: dir };
          })
          .sort((a, b) => String(b.slug).localeCompare(String(a.slug)))
      : [];
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/outline/save', (req, res) => {
  try {
    const { slug, outline } = req.body || {};
    if (!slug || !outline) throw new Error('缺少 slug / outline');
    const cfg = loadConfig(__dirname);
    const outDir = path.join(cfg.outDir, sanitizeSlugForPath(slug));
    if (!fs.existsSync(outDir)) throw new Error('作品目录不存在: ' + outDir);
    fs.writeFileSync(path.join(outDir, 'outline.json'), JSON.stringify(outline, null, 2), 'utf8');
    res.json({ success: true, data: { outDir } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/work/:slug/:file', (req, res) => {
  try {
    const { slug, file } = req.params;
    const ok = /^(plan\.json|outline\.json|state\.json|memory_sheets\.json|作品\.md|chapter_\d+\.txt|chapter_\d+\.segments\.json)$/.test(file);
    if (!ok) throw new Error('非法文件名');
    const cfg = loadConfig(__dirname);
    const p = path.join(cfg.outDir, sanitizeSlugForPath(slug), file);
    if (!fs.existsSync(p)) return res.status(404).json({ success: false, error: 'not found' });
    if (file.endsWith('.json') || file.endsWith('.md')) {
      const text = fs.readFileSync(p, 'utf8');
      return res.json({ success: true, data: file.endsWith('.json') ? readJSONSafe(p) : text });
    }
    res.json({ success: true, data: fs.readFileSync(p, 'utf8') });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/model-dial', (req, res) => {
  try {
    const cfg = loadConfig(__dirname);
    res.json({ success: true, data: readJSONSafe(path.join(cfg.profileDir, 'model-dial.json')) || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/model-dial', (req, res) => {
  try {
    const cfg = loadConfig(__dirname);
    const list = Array.isArray(req.body) ? req.body : (req.body && req.body.list) || [];
    fs.writeFileSync(path.join(cfg.profileDir, 'model-dial.json'), JSON.stringify(list, null, 2), 'utf8');
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/patches', (req, res) => {
  try {
    const patchesDir = path.join(__dirname, 'patches');
    const cfg = readJSONSafe(path.join(patchesDir, 'patches.json')) || {};
    const systemAppendContent = cfg.systemAppend && fs.existsSync(path.join(patchesDir, cfg.systemAppend))
      ? fs.readFileSync(path.join(patchesDir, cfg.systemAppend), 'utf8')
      : '';
    res.json({ success: true, data: { config: cfg, systemAppendContent } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/patches', (req, res) => {
  try {
    const { config, systemAppendContent } = req.body || {};
    const patchesDir = path.join(__dirname, 'patches');
    fs.mkdirSync(patchesDir, { recursive: true });
    if (config) fs.writeFileSync(path.join(patchesDir, 'patches.json'), JSON.stringify(config, null, 2), 'utf8');
    if (config && config.systemAppend && typeof systemAppendContent === 'string') {
      fs.writeFileSync(path.join(patchesDir, config.systemAppend), systemAppendContent, 'utf8');
    }
    res.json({ success: true, data: { config, systemAppendContent } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 结构化长期记忆（DataTable）：读 / 写 ──
app.get('/api/memory/:slug', (req, res) => {
  try {
    const { slug } = req.params;
    const cfg = loadConfig(__dirname);
    const safeSlug = sanitizeSlugForPath(slug);
    let mem = loadMemory(cfg, safeSlug, normalizeMemory);
    if (!mem) mem = defaultMemory();
    res.json({ success: true, data: mem });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/memory/:slug', (req, res) => {
  try {
    const { slug } = req.params;
    const body = req.body || {};
    const cfg = loadConfig(__dirname);
    const safeSlug = sanitizeSlugForPath(slug);
    const mem = normalizeMemory(body);
    const p = saveMemory(cfg, safeSlug, mem);
    res.json({ success: true, data: { memory: mem, path: p } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/analyze', (req, res) => {
  try {
    const { slug, chapter } = req.body || {};
    const cfg = loadConfig(__dirname);
    const outDir = path.join(cfg.outDir, sanitizeSlugForPath(slug || ''));
    const file = /^chapter_\d+\.txt$/.test(chapter || '') ? chapter : 'chapter_01.txt';
    const p = path.join(outDir, file);
    if (!fs.existsSync(p)) return res.status(404).json({ success: false, error: '章节不存在: ' + file });
    let chapterTarget = 0, segments = null;
    const segFile = p.replace(/\.txt$/, '.segments.json');
    if (fs.existsSync(segFile)) {
      const meta = readJSONSafe(segFile);
      chapterTarget = Number(meta?.chapterTarget || 0);
      segments = meta?.segments || null;
    }
    const text = fs.readFileSync(p, 'utf8');
    res.json({ success: true, data: analyzeChapter(text, { chapterTarget, segments }) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 状态 & 设置 ──
app.get('/api/status', (req, res) => {
  try {
    const cfg = loadConfig(__dirname);
    const conn = getConn();
    const has = (p) => fs.existsSync(path.join(cfg.profileDir, p));
    res.json({
      success: true,
      data: {
        online: true,
        indexReady: has('index.json'),
        styleReady: has('style.json'),
        worldbookReady: has('worldbook.json'),
        keyConfigured: !!conn.apiKey,
        model: conn.model,
        baseUrl: conn.baseUrl,
        corpusDir: cfg.corpusDir,
        profileDir: cfg.profileDir,
        outDir: cfg.outDir
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/settings', (req, res) => {
  res.json({ success: true, data: publicConn() });
});

app.post('/api/settings', (req, res) => {
  try {
    const { model, baseUrl, apiKey } = req.body || {};
    setConn({ model, baseUrl, apiKey });
    res.json({ success: true, data: publicConn() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 语料维护 ──
app.post('/api/rebuild-profile', async (req, res) => {
  try {
    const { chunk, mock } = req.body || {};
    const result = await runBuild({ extract: false, mock: !!mock, chunk: chunk || null, log: console.log });
    resetIndex(); // 使缓存索引失效，下次检索自动加载新索引
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/extract-worldbook', async (req, res) => {
  try {
    const { mock } = req.body || {};
    const cfg = loadConfig(__dirname);
    const conn = getConn();
    const geminiCfg = { ...cfg.gemini, model: conn.model || cfg.gemini.model, baseUrl: conn.baseUrl || cfg.gemini.baseUrl, apiKey: conn.apiKey || cfg.gemini.apiKey };
    const client = new GeminiClient(geminiCfg, { mock: !!mock });
    const works = loadWorks(cfg.corpusDir);
    const worldbook = await extractWorldbook(client, works, cfg);
    fs.mkdirSync(cfg.profileDir, { recursive: true });
    const outName = mock ? 'worldbook.mock.json' : 'worldbook.json';
    fs.writeFileSync(path.join(cfg.profileDir, outName), JSON.stringify(worldbook, null, 2), 'utf8');
    res.json({ success: true, data: { series: Object.keys(worldbook.series || {}), file: outName } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 连接诊断（避免用户填错模型/端点/Key） ──
app.post('/api/models', async (req, res) => {
  try {
    const conn = getConn();
    const baseUrl = ((req.body && req.body.baseUrl) || conn.baseUrl || '').replace(/\/+$/, '');
    const apiKey = (req.body && req.body.apiKey) || conn.apiKey || '';
    if (!baseUrl) throw new Error('缺少 API 端点');
    const headers = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const r = await fetch(`${baseUrl}/models`, { method: 'GET', headers });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`拉取模型失败(${r.status}): ${text.slice(0, 200)}`);
    }
    const data = await r.json();
    const models = (Array.isArray(data && data.data) ? data.data : [])
      .map((m) => m && m.id)
      .filter(Boolean);
    res.json({ success: true, data: { models } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

app.post('/api/test-connection', async (req, res) => {
  const conn = getConn();
  const cfg = loadConfig(__dirname);
  const baseUrl = (req.body && req.body.baseUrl) || conn.baseUrl || cfg.gemini.baseUrl;
  const model = (req.body && req.body.model) || conn.model || cfg.gemini.model;
  const apiKey = (req.body && req.body.apiKey) || conn.apiKey || cfg.gemini.apiKey;
  if (!apiKey) {
    res.json({ success: true, data: { ok: false, error: '缺少 API Key' } });
    return;
  }
  try {
    const client = new GeminiClient({ ...cfg.gemini, baseUrl, model, apiKey }, { mock: false });
    const t0 = Date.now();
    const sample = await client.chat([{ role: 'user', content: 'ping' }], { maxTokens: 8, temperature: 0 });
    res.json({ success: true, data: { ok: true, model, latencyMs: Date.now() - t0, sample: String(sample).slice(0, 60) } });
  } catch (err) {
    res.json({ success: true, data: { ok: false, error: err.message || String(err) } });
  }
});

// 静态托管主前端构建产物（web/dist）；存在 dist 时单端口即可用工作台
const DIST_DIR = path.join(__dirname, 'web', 'dist');
const INDEX_HTML = path.join(DIST_DIR, 'index.html');
if (fs.existsSync(INDEX_HTML)) {
  app.use(express.static(DIST_DIR));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile(INDEX_HTML);
  });
}

const PORT = 43130;
app.listen(PORT, () => {
  console.log(`🚀 作者模拟器后端已启动: http://127.0.0.1:${PORT}`);
});