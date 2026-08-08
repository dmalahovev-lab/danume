const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const Pusher = require('pusher');
const path = require('path');
const bcrypt = require('bcryptjs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const pusher = new Pusher({
  appId: "2184419",
  key: "a435e7b37fd04dc88910",
  secret: "02198f7d8ee252f0cfe4",
  cluster: "eu",
  useTLS: true
});

let users = [];
let messages = [];
let chats = [];

// ============================================
// API
// ============================================

app.post('/api/register', async (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
  if (users.find(u => u.username === username)) return res.status(400).json({ error: 'Пользователь уже существует' });
  
  const hashedPassword = await bcrypt.hash(password, 10);
  const newUser = {
    id: 'user_' + uuidv4(),
    username,
    password: hashedPassword,
    displayName: displayName || username,
    avatar: (displayName || username)[0].toUpperCase(),
    online: false,
    registeredAt: Date.now(),
    bio: ''
  };
  users.push(newUser);
  res.json({ success: true, user: { id: newUser.id, username: newUser.username, displayName: newUser.displayName, avatar: newUser.avatar } });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
  
  const user = users.find(u => u.username === username);
  if (!user) return res.status(401).json({ error: 'Неверный логин или пароль' });
  
  const isValid = await bcrypt.compare(password, user.password);
  if (!isValid) return res.status(401).json({ error: 'Неверный логин или пароль' });
  
  user.online = true;
  res.json({ success: true, user: { id: user.id, username: user.username, displayName: user.displayName, avatar: user.avatar, bio: user.bio, registeredAt: user.registeredAt } });
});

app.get('/api/users', (req, res) => {
  res.json(users.map(u => ({ id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar, online: u.online || false, registeredAt: u.registeredAt, bio: u.bio })));
});

app.get('/api/chats/:userId', (req, res) => {
  const { userId } = req.params;
  const userChats = chats.filter(chat => chat.participants.includes(userId));
  const enriched = userChats.map(chat => {
    let displayName = chat.name, avatar = '👥';
    if (chat.type === 'private') {
      const otherId = chat.participants.find(id => id !== userId);
      const otherUser = users.find(u => u.id === otherId);
      if (otherUser) { displayName = otherUser.displayName; avatar = otherUser.avatar || '👤'; }
    } else { displayName = chat.name || 'Группа'; avatar = chat.avatar || '👥'; }
    const lastMsg = messages.filter(m => m.chatId === chat.id).sort((a, b) => b.timestamp - a.timestamp)[0];
    return { ...chat, displayName, avatar, lastMessage: lastMsg || null, unreadCount: 0 };
  });
  res.json(enriched);
});

app.post('/api/create-chat', (req, res) => {
  const { userId1, userId2 } = req.body;
  const existing = chats.find(chat => chat.type === 'private' && chat.participants.includes(userId1) && chat.participants.includes(userId2));
  if (existing) return res.json(existing);
  const newChat = { id: 'chat_' + uuidv4(), type: 'private', participants: [userId1, userId2], name: null, createdAt: Date.now() };
  chats.push(newChat);
  res.json(newChat);
});

app.post('/api/send-message', (req, res) => {
  const { chatId, text, fromUserId, replyTo, file } = req.body;
  const chat = chats.find(c => c.id === chatId);
  if (!chat) return res.status(404).json({ error: 'Чат не найден' });
  
  const newMessage = {
    id: 'msg_' + uuidv4(),
    chatId,
    senderId: fromUserId,
    text: text || '',
    timestamp: Date.now(),
    replyTo: replyTo || null,
    reactions: [],
    pinned: false,
    file: file || null,
    edited: false
  };
  messages.push(newMessage);
  
  // Отправляем через Pusher ВСЕМ участникам
  chat.participants.forEach(participantId => {
    pusher.trigger(`private-user-${participantId}`, 'new_message', newMessage).catch(err => console.error('Pusher error:', err));
  });
  
  res.json({ success: true, message: newMessage });
});

app.get('/api/history/:chatId', (req, res) => {
  const { chatId } = req.params;
  const limit = parseInt(req.query.limit) || 100;
  const history = messages.filter(m => m.chatId === chatId).sort((a, b) => a.timestamp - b.timestamp).slice(-limit);
  res.json(history);
});

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

app.post('/api/update-profile', (req, res) => {
  const { userId, displayName, username, bio, avatar } = req.body;
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (displayName) user.displayName = displayName;
  if (username) user.username = username;
  if (bio !== undefined) user.bio = bio;
  if (avatar) user.avatar = avatar;
  res.json({ success: true, user });
});

// ============================================
// НОВЫЕ ОБРАБОТЧИКИ ДЛЯ ДЕЙСТВИЙ
// ============================================

app.post('/api/delete-message', (req, res) => {
  const { messageId, userId } = req.body;
  const msg = messages.find(m => m.id === messageId);
  if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
  if (msg.senderId !== userId) return res.status(403).json({ error: 'Нельзя удалить чужое сообщение' });
  
  messages = messages.filter(m => m.id !== messageId);
  
  // Уведомляем всех участников чата
  const chat = chats.find(c => c.id === msg.chatId);
  if (chat) {
    chat.participants.forEach(pid => {
      pusher.trigger(`private-user-${pid}`, 'message_deleted', { messageId }).catch(() => {});
    });
  }
  res.json({ success: true });
});

app.post('/api/pin-message', (req, res) => {
  const { messageId, userId } = req.body;
  const msg = messages.find(m => m.id === messageId);
  if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
  
  msg.pinned = true;
  const chat = chats.find(c => c.id === msg.chatId);
  if (chat) {
    chat.participants.forEach(pid => {
      pusher.trigger(`private-user-${pid}`, 'message_pinned', msg).catch(() => {});
    });
  }
  res.json({ success: true });
});

app.post('/api/unpin-message', (req, res) => {
  const { messageId, userId } = req.body;
  const msg = messages.find(m => m.id === messageId);
  if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
  
  msg.pinned = false;
  const chat = chats.find(c => c.id === msg.chatId);
  if (chat) {
    chat.participants.forEach(pid => {
      pusher.trigger(`private-user-${pid}`, 'message_unpinned', msg).catch(() => {});
    });
  }
  res.json({ success: true });
});

app.post('/api/toggle-reaction', (req, res) => {
  const { messageId, userId, emoji, add } = req.body;
  const msg = messages.find(m => m.id === messageId);
  if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
  
  if (!msg.reactions) msg.reactions = [];
  if (add) {
    if (!msg.reactions.some(r => r.userId === userId && r.emoji === emoji)) {
      msg.reactions.push({ userId, emoji });
    }
  } else {
    msg.reactions = msg.reactions.filter(r => !(r.userId === userId && r.emoji === emoji));
  }
  
  const chat = chats.find(c => c.id === msg.chatId);
  if (chat) {
    chat.participants.forEach(pid => {
      pusher.trigger(`private-user-${pid}`, add ? 'reaction_added' : 'reaction_removed', { messageId, userId, emoji }).catch(() => {});
    });
  }
  res.json({ success: true });
});

app.post('/api/edit-message', (req, res) => {
  const { messageId, userId, text } = req.body;
  const msg = messages.find(m => m.id === messageId);
  if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
  if (msg.senderId !== userId) return res.status(403).json({ error: 'Нельзя редактировать чужое сообщение' });
  
  msg.text = text;
  msg.edited = true;
  
  const chat = chats.find(c => c.id === msg.chatId);
  if (chat) {
    chat.participants.forEach(pid => {
      pusher.trigger(`private-user-${pid}`, 'message_edited', msg).catch(() => {});
    });
  }
  res.json({ success: true });
});

// ============================================
// СТАТИКА
// ============================================
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

module.exports = app;
