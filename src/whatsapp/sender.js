async function enviarTexto(telefone, texto) {
  const url = `${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`;
  const resp = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', apikey: process.env.EVOLUTION_API_KEY },
    body:    JSON.stringify({ number: telefone, text: texto }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Evolution API: ${err}`);
  }
  return resp.json();
}

module.exports = { enviarTexto };
