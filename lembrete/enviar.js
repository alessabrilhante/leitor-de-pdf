// Manda o lembrete de leitura pros aparelhos cadastrados.
// Os códigos ficam no segredo LEMBRETE_ASSINATURAS (um por linha), copiados do app.
const webpush = require('web-push');

const VAPID_PUBLICA = 'BEj1m2_i9y9AWZpXzUUiqR4qwDYSpEqiFTQSvEeeY-EmprHoEztcP570rAlKbonABUyjin54B7ZhSaqGhtLwu4c';
const privada = process.env.VAPID_PRIVATE_KEY;
const linhas = (process.env.LEMBRETE_ASSINATURAS || '').split('\n').map((l) => l.trim()).filter(Boolean);
const forcar = process.env.FORCAR === 'true';

if (!privada) { console.log('Falta o segredo VAPID_PRIVATE_KEY.'); process.exit(0); }
if (!linhas.length) { console.log('Nenhum aparelho cadastrado em LEMBRETE_ASSINATURAS.'); process.exit(0); }

webpush.setVapidDetails('https://alessabrilhante.github.io/leitor-de-pdf/', VAPID_PUBLICA, privada);

const fs = require('fs');
const path = require('path');

// agora, em minutos do dia, no horário de Brasília
const partes = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/Sao_Paulo' })
  .formatToParts(new Date()).map((p) => [p.type, p.value]));
const agora = Number(partes.hour) * 60 + Number(partes.minute);
const horaAgora = `${partes.hour}:${partes.minute}`;

// horário do lembrete: lembrete/horario.txt (ex.: 21:30) vale pra todos os aparelhos.
// Sem o arquivo, usa o horário que veio no código de cada aparelho.
let horarioArquivo = null;
try {
  const t = fs.readFileSync(path.join(__dirname, 'horario.txt'), 'utf8').match(/(\d{1,2})[:h](\d{2})?/);
  if (t) horarioArquivo = Number(t[1]) * 60 + Number(t[2] || 0);
} catch { /* sem arquivo */ }
const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

const frases = [
  'Que tal ler umas páginas agora? 📚',
  'Seu livro tá te esperando 💗',
  'Bora manter a sequência? Umas páginas já contam 🔥',
  'Hora de ler um pouquinho 📖',
];
const body = frases[new Date().getDate() % frases.length];

(async () => {
  let enviados = 0;
  for (const linha of linhas) {
    let item;
    try { item = JSON.parse(linha); } catch { console.log('Linha que não é código do app, pulei.'); continue; }
    const sub = item.s || item;
    const alvo = horarioArquivo ?? (Number(item.h ?? 21) * 60 + Number(item.m ?? 0));
    const diff = (agora - alvo + 1440) % 1440;
    // a tarefa roda a cada 15 min e às vezes atrasa: manda na primeira rodada depois do horário
    if (!forcar && diff >= 15) continue;
    const hora = fmt(alvo);
    try {
      await webpush.sendNotification(sub, JSON.stringify({ title: 'Hora de ler 📚', body }), { TTL: 3600, urgency: 'normal' });
      enviados++;
      console.log(`Enviado pro ${item.a || 'aparelho'} (${hora}).`);
    } catch (err) {
      const gone = err.statusCode === 404 || err.statusCode === 410;
      console.log(`Falhou pro ${item.a || 'aparelho'}: ${err.statusCode || ''} ${gone ? '(código vencido: ative o lembrete de novo no app e troque o código)' : err.body || err.message}`);
    }
  }
  console.log(`Agora em Brasília: ${horaAgora}. Horário do arquivo: ${horarioArquivo == null ? 'não definido' : fmt(horarioArquivo)}. Lembretes enviados: ${enviados}.`);
})();
