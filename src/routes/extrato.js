const express  = require('express');
const multer   = require('multer');
const { processar } = require('../controllers/extratoController');

const router  = express.Router({ mergeParams: true });
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

router.post('/processar', upload.single('arquivo'), processar);

router.get('/teste-gemini', async (req, res) => {
  try {
    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
    const resp = await ai.models.generateContent({
      model: 'gemini-flash-latest',
      contents: [{ parts: [{ text: 'Responda apenas: OK' }] }],
    });
    res.json({ ok: true, resposta: resp.text });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

module.exports = router;