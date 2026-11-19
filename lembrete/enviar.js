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

const horaAgora = Number(new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', hour12: false, timeZone: 'America/Sao_Paulo' }).format(new Date()));

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
    const hora = Number(item.h ?? 21);
    if (!forcar && hora !== horaAgora) continue;
    try {
      await webpush.sendNotification(sub, JSON.stringify({ title: 'Biblioteca', body }), { TTL: 3600, urgency: 'normal' });
      enviados++;
      console.log(`Enviado pro ${item.a || 'aparelho'} (${hora}h).`);
    } catch (err) {
      const gone = err.statusCode === 404 || err.statusCode === 410;
      console.log(`Falhou pro ${item.a || 'aparelho'}: ${err.statusCode || ''} ${gone ? '(código vencido: ative o lembrete de novo no app e troque o código)' : err.body || err.message}`);
    }
  }
  console.log(`Hora em Brasília: ${horaAgora}h. Lembretes enviados: ${enviados}.`);
})();
