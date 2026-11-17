// Intsinzi Exam Lab - backend. Run: ADMIN_KEY=... ANTHROPIC_API_KEY=... node server.js
const express = require('express'), multer = require('multer'), fs = require('fs'), crypto = require('crypto'), path = require('path');
const app = express(), up = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12e6, files: 6 } });
const ADMIN = process.env.ADMIN_KEY, KEY = process.env.ANTHROPIC_API_KEY, MODEL = process.env.MODEL || 'claude-sonnet-5-5';
if (!ADMIN || ADMIN.length < 8 || !KEY) { console.error('Set ADMIN_KEY (8+ chars) and ANTHROPIC_API_KEY'); process.exit(1); }
const F = path.join(process.env.DATA_DIR || __dirname, 'db.json');
let db = { settings: { price: 59, bundlePrice: 1899, bundleDays: 30, payments: 'manual', momo: ['0788454771', '0733647522'] }, pays: [], codes: {}, sessions: {}, records: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(F))); } catch {}
const save = () => fs.writeFileSync(F, JSON.stringify(db));
const rid = n => crypto.randomBytes(n).toString('hex').toUpperCase();
const guard = (q, r, nx) => q.get('x-admin-key') === ADMIN ? nx() : r.status(401).json({ error: 'Unauthorized' });
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- Public config & payments (manual MoMo confirmation by owner) ----
app.get('/api/config', (q, r) => { const { price, bundlePrice, bundleDays, payments, momo } = db.settings; r.json({ price, bundlePrice, bundleDays, payments, momo }); });
app.post('/api/pay', (q, r) => {
  const { phone, ref, plan } = q.body, s = db.settings;
  if (!/^07\d{8}$/.test(phone || '')) return r.status(400).json({ error: 'Enter a valid MoMo number (07xxxxxxxx).' });
  if (!/^[A-Za-z0-9]{6,}$/.test(ref || '')) return r.status(400).json({ error: 'Enter the transaction ID from your payment SMS.' });
  if (db.pays.some(p => p.ref.toLowerCase() === ref.toLowerCase())) return r.status(400).json({ error: 'This transaction ID was already submitted.' });
  const p = { id: rid(5), phone, ref, plan: plan === 'bundle' && db.settings.payments !== 'single' ? 'bundle' : 'single', status: 'pending', t: Date.now() };
  p.amount = p.plan === 'bundle' ? s.bundlePrice : s.price; db.pays.push(p); save(); r.json({ id: p.id });
});
app.get('/api/pay/:id', (q, r) => { const p = db.pays.find(x => x.id === q.params.id); if (!p) return r.status(404).json({}); r.json({ status: p.status, code: p.status === 'confirmed' ? p.code : undefined }); });

// ---- Admin / developer ----
const mkCode = plan => { const c = rid(4), s = db.settings; db.codes[c] = plan === 'bundle' ? { type: 'bundle', exp: Date.now() + s.bundleDays * 864e5 } : { type: 'single', used: 0 }; return c; };
app.get('/api/admin/data', guard, (q, r) => r.json({ pays: db.pays.slice(-200).reverse(), records: db.records.slice(-300).reverse(), settings: db.settings }));
app.post('/api/admin/confirm', guard, (q, r) => { const p = db.pays.find(x => x.id === q.body.id); if (!p || p.status !== 'pending') return r.status(404).json({ error: 'Not found' }); p.status = 'confirmed'; p.code = mkCode(p.plan); save(); r.json({ code: p.code }); });
app.post('/api/admin/reject', guard, (q, r) => { const p = db.pays.find(x => x.id === q.body.id); if (p) p.status = 'rejected'; save(); r.json({}); });
app.post('/api/admin/code', guard, (q, r) => { const c = mkCode(q.body.plan); save(); r.json({ code: c }); });
app.post('/api/admin/settings', guard, (q, r) => {
  const b = q.body, s = db.settings;
  s.price = Math.max(0, +b.price || 0); s.bundlePrice = Math.max(0, +b.bundlePrice || 0); s.bundleDays = Math.max(1, +b.bundleDays || 30);
  s.payments = ['off', 'single'].includes(b.payments) ? b.payments : 'manual'; s.momo = String(b.momo || '').split(',').map(x => x.trim()).filter(Boolean); save(); r.json(s);
});

// ---- Question generation (fresh questions every access) ----
const DIFF = { Standard: 'official national-exam standard', Mock_Grade1: 'MOCK GRADE 1: hardest, multi-step reasoning, higher-order thinking, tricky plausible distractors', Mock_Grade2: 'MOCK GRADE 2: high level, analysis and application', Mock_Grade3: 'MOCK GRADE 3: above-standard, application and deep understanding' };
const slice = (t, n) => { if (t.length <= n) return t; const s = Math.floor(Math.random() * (t.length - n)); return t.slice(s, s + n); };
async function ask(content, prompt) {
  for (let a = 0; a < 2; a++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 6000, system: 'You are a national examiner. Reply with ONLY a JSON array, no markdown.', messages: [{ role: 'user', content: [...content, { type: 'text', text: prompt }] }] }) });
    const j = await res.json(); if (!res.ok) { if (a) throw new Error(j.error?.message || 'AI error'); continue; }
    try { const arr = JSON.parse(j.content.map(c => c.text || '').join('').replace(/```json|```/g, '').trim());
      const ok = arr.filter(x => x.q && Array.isArray(x.o) && x.o.length === 4 && Number.isInteger(x.a) && x.a >= 0 && x.a < 4); if (ok.length) return ok; } catch {}
  }
  throw new Error('Could not prepare questions, please try again.');
}
async function gen(level, subject, exam, n, files) {
  const content = [];
  for (const f of files) {
    const m = f.mimetype, d = f.buffer.toString('base64');
    if (m === 'application/pdf') content.push({ type: 'document', source: { type: 'base64', media_type: m, data: d } });
    else if (/^image\/(png|jpe?g|gif|webp)$/.test(m)) content.push({ type: 'image', source: { type: 'base64', media_type: m, data: d } });
    else content.push({ type: 'text', text: `Material "${f.originalname}":\n` + slice(f.buffer.toString('utf8'), 30000) });
  }
  const per = 10, parts = Math.ceil(n / per), jobs = [];
  for (let i = 0; i < parts; i++) {
    const k = Math.min(per, n - i * per);
    jobs.push(ask(content, `Create ${k} multiple-choice questions (4 options) for the Rwanda ${level} national examination, subject: ${subject}. Difficulty: ${DIFF[exam] || DIFF.Standard}. ` +
      (files.length ? 'Base them on randomly chosen parts of the attached materials. ' : 'Follow the standard national curriculum for this level. ') +
      `This is part ${i + 1} of ${parts}: cover a different region of the syllabus from other parts. Variation seed: ${rid(3)}. Never repeat common textbook examples. ` +
      'Return JSON array of {"q":text,"o":[4 options],"a":index of correct option 0-3,"topic":short topic name,"why":one-sentence explanation}.'));
  }
  const all = (await Promise.all(jobs)).flat(); return all.slice(0, n);
}

// ---- Exam flow ----
app.post('/api/start', up.array('files'), async (q, r) => {
  try {
    const b = q.body, s = db.settings, dev = b.code === ADMIN; let c = null;
    if (!dev && s.payments !== 'off') {
      c = db.codes[String(b.code || '').trim().toUpperCase()];
      if (!c || (c.type === 'single' && c.used >= 1) || (c.exp && Date.now() > c.exp)) return r.status(402).json({ error: 'Valid access code required. Pay and wait for the owner\'s confirmation.' });
    }
    const n = Math.min(100, Math.max(5, +b.n || 50)), min = Math.min(240, Math.max(10, +b.min || 120));
    const qs = await gen(b.level, b.subject, b.exam, n, q.files || []);
    if (c && c.type === 'single') c.used++;
    for (const k in db.sessions) if (db.sessions[k].end < Date.now() - 36e5) delete db.sessions[k];
    const sid = rid(8), anon = 'Candidate-' + rid(2);
    db.sessions[sid] = { anon, level: b.level, subject: b.subject, exam: b.exam, qs, end: Date.now() + min * 6e4, keep: b.keep === '1', proc: b.exam === 'Mock_Grade3', v: 0, log: [], lv: 0 };
    save(); r.json({ sid, anon, proc: db.sessions[sid].proc, end: db.sessions[sid].end, qs: qs.map(({ q, o }) => ({ q, o })) });
  } catch (e) { r.status(500).json({ error: e.message }); }
});
// Mock_Grade3 proctoring: 2 warnings, 3rd malpractice blocks the exam
app.post('/api/violation', (q, r) => {
  const s = db.sessions[q.body.sid]; if (!s || !s.proc || s.blocked) return r.json({ count: s ? s.v : 0, blocked: !!(s && s.blocked) });
  if (Date.now() - s.lv < 4000) return r.json({ count: s.v, blocked: false, ignored: true });
  s.lv = Date.now(); s.v++; s.log.push(String(q.body.kind || 'unknown').slice(0, 60)); if (s.v >= 3) s.blocked = true;
  save(); r.json({ count: s.v, blocked: !!s.blocked });
});
app.post('/api/submit', (q, r) => {
  const s = db.sessions[q.body.sid]; if (!s) return r.status(404).json({ error: 'Session closed.' });
  delete db.sessions[q.body.sid];
  if (s.blocked) { if (s.keep) db.records.push({ anon: s.anon, level: s.level, subject: s.subject, exam: s.exam, blocked: true, violations: s.log, date: new Date().toISOString() }); save(); return r.json({ blocked: true, anon: s.anon }); }
  if (Date.now() > s.end + 15000) { save(); return r.status(403).json({ error: 'Time is over. Access to this exam has been closed.' }); }
  const ans = q.body.answers || [], T = {}, wrong = []; let score = 0;
  s.qs.forEach((x, i) => { const t = T[x.topic || 'General'] ||= { ok: 0, n: 0 }; t.n++;
    if (ans[i] === x.a) { score++; t.ok++; } else wrong.push({ q: x.q, yours: ans[i] == null ? null : x.o[ans[i]], right: x.o[x.a], why: x.why }); });
  const n = s.qs.length, pct = Math.round(score / n * 100);
  const label = pct >= 80 ? 'Excellent' : pct >= 65 ? 'Very good' : pct >= 50 ? 'Pass' : 'Needs improvement';
  const weak = Object.entries(T).filter(([, v]) => v.ok / v.n < 0.5).sort((a, b) => a[1].ok / a[1].n - b[1].ok / b[1].n);
  const recs = weak.map(([k, v]) => `Revise "${k}" (${v.ok}/${v.n} correct) and practise more questions on it.`);
  recs.push(pct >= 80 ? 'Great work! Try a harder Mock grade to stretch yourself.' : pct >= 50 ? 'Good progress. Review the explanations below, then retake with new questions.' : 'Study your notes on the weak topics, then retake the exam; every attempt brings different questions.');
  if (s.keep) db.records.push({ anon: s.anon, level: s.level, subject: s.subject, exam: s.exam, score, n, pct, topics: T, violations: s.log, date: new Date().toISOString() });
  save(); res_(r, { anon: s.anon, score, n, pct, label, topics: T, recs, wrong });
});
const res_ = (r, o) => r.json(o);
app.listen(process.env.PORT || 3000, () => console.log('Intsinzi Exam Lab running'));
