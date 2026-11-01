// Backend do VidGrab – Node.js + Express + yt-dlp
const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

const PORT = process.env.PORT || 3000;
const TMP = path.join(os.tmpdir(), 'vidgrab');
fs.mkdirSync(TMP, { recursive: true });

const app = express();
app.set('trust proxy', 1); // necessário atrás de Railway/Render/Nginx (IP real no rate limit)
app.use(express.json({ limit: '10kb' }));

// ---------- Rate limit simples (por IP) ----------
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const arr = (hits.get(req.ip) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Muitas requisições. Aguarde um minuto.' });
    arr.push(now); hits.set(req.ip, arr); next();
  };
}

// ---------- Validação de URL (evita acesso a rede interna) ----------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80');
}
async function validateUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Link inválido.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Use um link http(s).');
  const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error('Não foi possível resolver o endereço.');
  if (addrs.some(a => isPrivateIp(a.address))) throw new Error('Endereço não permitido.');
  return u.toString();
}

// ---------- Execução do yt-dlp ----------
function runYtDlp(args, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const p = spawn('yt-dlp', args);
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('Tempo esgotado.')); }, timeoutMs);
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', () => { clearTimeout(timer); reject(new Error('yt-dlp não está instalado no servidor.')); });
    p.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(friendlyError(err)));
    });
  });
}
function friendlyError(e) {
  if (/private|login|sign in|cookies/i.test(e)) return 'Este vídeo é privado ou exige login.';
  if (/unsupported url/i.test(e)) return 'Este site/link não é suportado.';
  if (/not available|removed|unavailable/i.test(e)) return 'Vídeo indisponível ou removido.';
  if (/drm/i.test(e)) return 'Vídeo protegido por DRM; não pode ser baixado.';
  return 'Não foi possível processar este link.';
}

// ---------- API ----------
app.post('/api/info', rateLimit(20, 60_000), async (req, res) => {
  try {
    const url = await validateUrl(req.body.url);
    const json = await runYtDlp(['-J', '--no-playlist', '--no-warnings', '--', url], 60_000);
    const d = JSON.parse(json);
    res.json({
      title: d.title, thumbnail: d.thumbnail, duration: d.duration,
      uploader: d.uploader, platform: d.extractor_key,
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

const files = new Map(); // id -> { file, name, mime }

app.get('/api/prepare', rateLimit(8, 60_000), async (req, res) => {
  try {
    const url = await validateUrl(req.query.url);
    const format = req.query.format === 'mp3' ? 'mp3' : 'mp4';
    const q = [360, 480, 720, 1080, 1440, 2160].includes(+req.query.quality) ? +req.query.quality : 720;
    const id = crypto.randomBytes(12).toString('hex');
    const outTpl = path.join(TMP, id + '.%(ext)s');

    const args = ['--no-playlist', '--no-warnings', '--max-filesize', '1G', '-o', outTpl, '--print', 'after_move:filepath'];
    if (format === 'mp3') {
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    } else {
      args.push('-f', `bv*[height<=${q}]+ba/b[height<=${q}]/b`, '--merge-output-format', 'mp4');
    }
    args.push('--', url);

    const out = (await runYtDlp(args)).trim().split('\n').pop();
    if (!out || !fs.existsSync(out)) throw new Error('Falha ao gerar o arquivo.');

    const title = (await runYtDlp(['--get-title', '--no-playlist', '--', url], 30_000).catch(() => 'video')).trim();
    const safe = title.replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 80) || 'video';
    files.set(id, { file: out, name: `${safe}.${format}`, mime: format === 'mp3' ? 'audio/mpeg' : 'video/mp4' });
    setTimeout(() => cleanup(id), 10 * 60 * 1000); // expira em 10 min
    res.json({ id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/file/:id', (req, res) => {
  const f = files.get(req.params.id);
  if (!f) return res.status(404).send('Arquivo expirado. Gere o download novamente.');
  res.setHeader('Content-Type', f.mime);
  // Não apaga após o download: o usuário pode salvar E compartilhar. Expira sozinho em 10 min.
  res.download(f.file, f.name);
});

function cleanup(id) {
  const f = files.get(id);
  if (!f) return;
  files.delete(id);
  fs.unlink(f.file, () => {});
}

app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`VidGrab rodando em http://localhost:${PORT}`));
