const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const Pusher = require('pusher');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ============================================
// PUSHER
// ============================================
const pusher = new Pusher({
  appId: "2184419",
  key: "a435e7b37fd04dc88910",
  secret: "02198f7d8ee252f0cfe4",
  cluster: "eu",
  useTLS: true
});

// ============================================
// ХРАНИЛИЩЕ
// ============================================
let users = [];
let messages = [];
let chats = [];

// ============================================
// API
// ============================================

// Регистрация/вход
app.post('/api/login', (req, res) => {
  const { username, displayName } = req.body;
  
  if (!username) {
    return res.status(400).json({ error: 'Username обязателен' });
  }
  
  let user = users.find(u => u.username === username);
  
  if (!user) {
    user = {
      id: 'user_' + uuidv4(),
      username: username,
      displayName: displayName || username,
      avatar: (displayName || username)[0].toUpperCase(),
      online: false,
      registeredAt: Date.now(),
      bio: ''
    };
    users.push(user);
  }
  
  user.online = true;
  
  res.json({
    success: true,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatar: user.avatar,
      bio: user.bio,
      registeredAt: user.registeredAt
    }
  });
});

// Получение пользователей
app.get('/api/users', (req, res) => {
  res.json(users.map(u => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    avatar: u.avatar,
    online: u.online || false,
    registeredAt: u.registeredAt,
    bio: u.bio
  })));
});

// Получение чатов
app.get('/api/chats/:userId', (req, res) => {
  const { userId } = req.params;
  
  const userChats = chats.filter(chat => chat.participants.includes(userId));
  
  const enriched = userChats.map(chat => {
    let displayName = chat.name;
    let avatar = '👥';
    
    if (chat.type === 'private') {
      const otherId = chat.participants.find(id => id !== userId);
      const otherUser = users.find(u => u.id === otherId);
      if (otherUser) {
        displayName = otherUser.displayName;
        avatar = otherUser.avatar || '👤';
      }
    } else {
      displayName = chat.name || 'Группа';
      avatar = chat.avatar || '👥';
    }
    
    const lastMsg = messages
      .filter(m => m.chatId === chat.id)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    
    return {
      ...chat,
      displayName,
      avatar,
      lastMessage: lastMsg || null,
      unreadCount: 0
    };
  });
  
  res.json(enriched);
});

// Создание чата
app.post('/api/create-chat', (req, res) => {
  const { userId1, userId2 } = req.body;
  
  const existing = chats.find(chat => 
    chat.type === 'private' &&
    chat.participants.includes(userId1) &&
    chat.participants.includes(userId2)
  );
  
  if (existing) {
    return res.json(existing);
  }
  
  const newChat = {
    id: 'chat_' + uuidv4(),
    type: 'private',
    participants: [userId1, userId2],
    name: null,
    createdAt: Date.now()
  };
  
  chats.push(newChat);
  res.json(newChat);
});

// Отправка сообщения
app.post('/api/send-message', (req, res) => {
  const { chatId, text, fromUserId, replyTo } = req.body;
  
  if (!chatId || !text || !fromUserId) {
    return res.status(400).json({ error: 'Не все поля заполнены' });
  }
  
  const chat = chats.find(c => c.id === chatId);
  if (!chat) {
    return res.status(404).json({ error: 'Чат не найден' });
  }
  
  const newMessage = {
    id: 'msg_' + uuidv4(),
    chatId: chatId,
    senderId: fromUserId,
    text: text,
    timestamp: Date.now(),
    replyTo: replyTo || null,
    reactions: [],
    pinned: false
  };
  
  messages.push(newMessage);
  
  // Отправляем через Pusher
  chat.participants.forEach(participantId => {
    pusher.trigger(`private-user-${participantId}`, 'new_message', {
      ...newMessage,
      chatId: chatId
    }).catch(err => {
      console.error('Pusher error:', err);
    });
  });
  
  res.json({ success: true, message: newMessage });
});

// История чата
app.get('/api/history/:chatId', (req, res) => {
  const { chatId } = req.params;
  const limit = parseInt(req.query.limit) || 100;
  
  const history = messages
    .filter(m => m.chatId === chatId)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-limit);
  
  res.json(history);
});

// Pusher авторизация
app.post('/pusher/auth', (req, res) => {
  const socketId = req.body.socket_id;
  const channel = req.body.channel_name;
  
  const userId = channel.replace('private-user-', '');
  const user = users.find(u => u.id === userId);
  
  if (user) {
    const auth = pusher.authorizeChannel(socketId, channel);
    res.send(auth);
  } else {
    res.status(403).send('Forbidden');
  }
});

// ============================================
// СТАТИКА
// ============================================
app.use(express.static(path.join(__dirname, '../public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ============================================
// ЭКСПОРТ ДЛЯ VERCEL
// ============================================
module.exports = app;
