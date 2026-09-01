const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/info', (req, res) => {
  res.json({
    name: 'DramaBox API',
    version: '1.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

app.get('/api/random', (req, res) => {
  const items = [
    'The story begins with a mysterious letter...',
    'In a world where shadows speak...',
    'She never expected to find the truth...',
    'Three strangers. One destiny.',
    'Behind every smile lies a secret.',
    'The clock strikes midnight, and the game begins.',
    'They said it was impossible. Until now.',
  ];
  res.json({
    quote: items[Math.floor(Math.random() * items.length)],
    number: Math.floor(Math.random() * 100) + 1,
  });
});

app.get('/api/cuaca', (req, res) => {
  const kondisi = ['Cerah', 'Berawan', 'Hujan Ringan', 'Hujan Deras', 'Berangin', 'Gerimis'];
  const kota = ['Palembang', 'Jakarta', 'Bandung', 'Surabaya', 'Medan', 'Makassar'];
  res.json({
    kota: kota[Math.floor(Math.random() * kota.length)],
    suhu: `${Math.floor(Math.random() * 15) + 25}°C`,
    kondisi: kondisi[Math.floor(Math.random() * kondisi.length)],
    kelembaban: `${Math.floor(Math.random() * 30) + 60}%`,
  });
});

app.listen(PORT, () => {
  console.log(`Server berjalan di http://localhost:${PORT}`);
});
