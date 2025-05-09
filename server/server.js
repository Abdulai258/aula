const express = require('express');
const WebSocket = require('ws');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const port = 3000;

// Configuração do Express
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Banco de Dados SQLite
const db = new sqlite3.Database('chat.db', (err) => {
  if (err) console.error('Erro ao conectar ao banco de dados:', err.message);
  else console.log('Conectado ao banco de dados SQLite');
});

// Criar tabelas
db.run(`
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT DEFAULT 'Aberto',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    message TEXT NOT NULL,
    sender TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Rota AJAX para abrir um chamado
app.post('/api/open-ticket', (req, res) => {
  const { username, description } = req.body;
  db.run(
    `INSERT INTO tickets (username, description) VALUES (?, ?)`,
    [username, description],
    (err) => {
      if (err) return res.status(500).json({ error: 'Erro ao abrir o chamado' });
      res.json({ message: 'Chamado aberto com sucesso!', status: 'Aberto' });
    }
  );
});

// Rota AJAX para verificar status do chamado
app.get('/api/check-ticket/:id', (req, res) => {
  const ticketId = req.params.id;
  db.get(
    `SELECT status FROM tickets WHERE id = ?`,
    [ticketId],
    (err, row) => {
      if (err || !row) return res.status(404).json({ error: 'Chamado não encontrado' });
      res.json({ status: row.status });
    }
  );
});

// Iniciar o servidor HTTP
const server = app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});

// Configuração do WebSocket
const wss = new WebSocket.Server({ server });

// Armazenar clientes e administrador
const clients = new Map();
let admin = null;

// Função para salvar mensagem no banco
function saveMessage(username, message, sender) {
  db.run(
    `INSERT INTO messages (username, message, sender) VALUES (?, ?, ?)`,
    [username, message, sender],
    (err) => {
      if (err) console.error('Erro ao salvar mensagem:', err.message);
    }
  );
}

// Função para carregar histórico de mensagens
function loadMessageHistory(callback) {
  db.all(
    `SELECT username, message, sender, timestamp FROM messages ORDER BY timestamp ASC`,
    (err, rows) => {
      if (err) callback([]);
      else callback(rows);
    }
  );
}

// Função para identificar mensagens complexas
function isComplexMessage(message) {
  const msg = message.toLowerCase();
  const complexKeywords = ['ajuda', 'problema', 'como fazer', 'explicar', 'dúvida', 'não sei', 'entender', 'preciso de', 'como posso', 'resolver'];
  const isLongMessage = message.length > 50 || message.split(' ').length > 10;
  const isQuestion = msg.includes('?') || msg.includes('como') || msg.includes('por que') || msg.includes('qual') || msg.includes('o que');
  const isSimpleMessage = msg.includes('oi') || msg.includes('olá') || msg.includes('tchau') || msg.includes('até logo');
  return (isLongMessage || isQuestion || complexKeywords.some(keyword => msg.includes(keyword))) && !isSimpleMessage;
}

// Função para gerar respostas do bot
function getBotResponse(message, username) {
  const msg = message.toLowerCase();
  if (msg.includes('oi') || msg.includes('olá')) return `Bot: Olá, ${username}! Como posso ajudar?`;
  if (msg.includes('tchau') || msg.includes('até logo')) return `Bot: Até logo, ${username}!`;
  if (msg.includes('qual é a capital do brasil')) return `Bot: A capital do Brasil é Brasília, ${username}!`;
  return null; // Para mensagens complexas ou sem resposta fixa
}

wss.on('connection', (ws) => {
  console.log('Novo cliente conectado ao WebSocket');
  ws.on('message', (message) => {
    const msg = message.toString();
    if (msg.startsWith('IDENTIFY:')) {
      const identifier = msg.split(':')[1];
      if (identifier === 'ADMIN') {
        admin = ws;
        console.log('Administrador conectado');
        ws.send('Bot: Você está conectado como administrador.');
        loadMessageHistory((rows) => rows.forEach(row => ws.send(`${row.sender}: ${row.message}`)));
      } else {
        const username = identifier || 'Usuário Anônimo';
        clients.set(ws, username);
        console.log(`Usuário ${username} conectado`);
        ws.send(`Bot: Bem-vindo, ${username}!`);
        const joinMessage = `Bot: ${username} entrou no chat.`;
        wss.clients.forEach(client => client !== ws && client.readyState === WebSocket.OPEN && client.send(joinMessage));
        saveMessage(username, joinMessage, 'bot');
      }
      return;
    }

    const username = clients.get(ws) || 'Usuário Anônimo';
    const userMessage = `${username}: ${msg}`;
    wss.clients.forEach(client => client !== admin && client.readyState === WebSocket.OPEN && client.send(userMessage));
    saveMessage(username, msg, 'user');

    if (ws === admin) {
      const adminMessage = `Admin: ${msg}`;
      wss.clients.forEach(client => client !== admin && client.readyState === WebSocket.OPEN && client.send(adminMessage));
      saveMessage('Admin', msg, 'admin');
      return;
    }

    const botResponse = getBotResponse(msg, username);
    if (botResponse) {
      wss.clients.forEach(client => client !== admin && client.readyState === WebSocket.OPEN && client.send(botResponse));
      saveMessage('Bot', botResponse.split(': ')[1], 'bot');
    } else if (isComplexMessage(msg)) {
      const notifyUser = `Bot: ${username}, sua mensagem é complexa. Encaminhando ao administrador!`;
      wss.clients.forEach(client => client !== admin && client.readyState === WebSocket.OPEN && client.send(notifyUser));
      if (admin && admin.readyState === WebSocket.OPEN) admin.send(`Mensagem de ${username}: ${msg}`);
      else wss.clients.forEach(client => client !== admin && client.readyState === WebSocket.OPEN && client.send(`Bot: Desculpe, ${username}, nenhum administrador disponível.`));
      saveMessage('Bot', notifyUser.split(': ')[1], 'bot');
    }
  });

  ws.on('close', () => {
    const username = clients.get(ws);
    if (ws === admin) {
      admin = null;
      console.log('Administrador desconectado');
    } else {
      clients.delete(ws);
      console.log(`Usuário ${username} desconectado`);
      const leaveMessage = `Bot: ${username} saiu do chat.`;
      wss.clients.forEach(client => client !== admin && client.readyState === WebSocket.OPEN && client.send(leaveMessage));
      saveMessage(username, leaveMessage, 'bot');
    }
  });
});

// Fechar o banco de dados ao encerrar
process.on('SIGINT', () => db.close(() => process.exit(0)));

// Rota AJAX para listar chamados
app.get('/api/tickets', (req, res) => {
    db.all(`SELECT id, username, description, status, created_at FROM tickets`, (err, rows) => {
      if (err) return res.status(500).json({ error: 'Erro ao carregar chamados' });
      res.json(rows);
    });
  });