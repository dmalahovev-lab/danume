const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const Pusher = require('pusher');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ============================================
// SUPABASE
// ============================================
const supabaseUrl = process.env.SUPABASE_URL || 'https://nqtdqzkzolkjkxzxoxre.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5xdGRxemt6b2xramt4enhveHJlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxNzI3MzcsImV4cCI6MjEwMTc0ODczN30.TJXRWvqg_a7Ml6rZoNgXQ8OzcrWDkvYWmZPPFC7JStM';
const supabase = createClient(supabaseUrl, supabaseKey);

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
// API
// ============================================

// Регистрация/вход
app.post('/api/login', async (req, res) => {
  const { username, displayName } = req.body;
  
  if (!username) {
    return res.status(400).json({ error: 'Username обязателен' });
  }
  
  try {
    // Ищем пользователя
    let { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .single();
    
    if (error && error.code !== 'PGRST116') {
      throw error;
    }
    
    if (!user) {
      // Создаём нового
      const newUser = {
        id: 'user_' + uuidv4(),
        username: username,
        display_name: displayName || username,
        avatar: (displayName || username)[0].toUpperCase(),
        online: true,
        registered_at: new Date().toISOString(),
        bio: ''
      };
      
      const { data, error: insertError } = await supabase
        .from('users')
        .insert([newUser])
        .select()
        .single();
      
      if (insertError) throw insertError;
      user = data;
    } else {
      // Обновляем статус
      await supabase
        .from('users')
        .update({ online: true })
        .eq('id', user.id);
    }
    
    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        avatar: user.avatar,
        bio: user.bio || '',
        registeredAt: user.registered_at
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получение всех пользователей
app.get('/api/users', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, username, display_name, avatar, online, registered_at, bio')
      .order('display_name');
    
    if (error) throw error;
    
    const users = data.map(u => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      avatar: u.avatar || u.display_name?.[0]?.toUpperCase() || '👤',
      online: u.online || false,
      registeredAt: u.registered_at,
      bio: u.bio
    }));
    
    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получение чатов
app.get('/api/chats/:userId', async (req, res) => {
  const { userId } = req.params;
  
  try {
    const { data: chats, error } = await supabase
      .from('chats')
      .select('*')
      .contains('participants', [userId]);
    
    if (error) throw error;
    
    const enriched = await Promise.all(chats.map(async (chat) => {
      let displayName = chat.name;
      let avatar = '👥';
      
      if (chat.type === 'private') {
        const otherId = chat.participants.find(id => id !== userId);
        const { data: otherUser } = await supabase
          .from('users')
          .select('display_name, avatar')
          .eq('id', otherId)
          .single();
        
        if (otherUser) {
          displayName = otherUser.display_name;
          avatar = otherUser.avatar || '👤';
        }
      } else {
        displayName = chat.name || 'Группа';
        avatar = chat.avatar || '👥';
      }
      
      const { data: lastMsg } = await supabase
        .from('messages')
        .select('*')
        .eq('chat_id', chat.id)
        .order('timestamp', { ascending: false })
        .limit(1)
        .maybeSingle();
      
      return {
        ...chat,
        displayName,
        avatar,
        lastMessage: lastMsg || null,
        unreadCount: 0
      };
    }));
    
    res.json(enriched);
  } catch (error) {
    console.error('Error fetching chats:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Создание чата
app.post('/api/create-chat', async (req, res) => {
  const { userId1, userId2 } = req.body;
  
  try {
    // Проверяем, есть ли уже чат
    const { data: existing } = await supabase
      .from('chats')
      .select('*')
      .eq('type', 'private')
      .contains('participants', [userId1])
      .contains('participants', [userId2]);
    
    if (existing && existing.length > 0) {
      return res.json(existing[0]);
    }
    
    const newChat = {
      id: 'chat_' + uuidv4(),
      type: 'private',
      participants: [userId1, userId2],
      name: null,
      creator_id: userId1,
      created_at: new Date().toISOString()
    };
    
    const { data, error } = await supabase
      .from('chats')
      .insert([newChat])
      .select()
      .single();
    
    if (error) throw error;
    
    res.json(data);
  } catch (error) {
    console.error('Error creating chat:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Отправка сообщения
app.post('/api/send-message', async (req, res) => {
  const { chatId, text, fromUserId, replyTo, file } = req.body;
  
  if (!chatId || !fromUserId) {
    return res.status(400).json({ error: 'Не все поля заполнены' });
  }
  
  try {
    const { data: chat, error: chatError } = await supabase
      .from('chats')
      .select('participants')
      .eq('id', chatId)
      .single();
    
    if (chatError || !chat) {
      return res.status(404).json({ error: 'Чат не найден' });
    }
    
    const newMessage = {
      id: 'msg_' + uuidv4(),
      chat_id: chatId,
      sender_id: fromUserId,
      text: text || '',
      timestamp: Date.now(),
      reply_to: replyTo || null,
      reactions: [],
      pinned: false,
      file: file || null,
      edited: false
    };
    
    const { data, error } = await supabase
      .from('messages')
      .insert([newMessage])
      .select()
      .single();
    
    if (error) throw error;
    
    // Отправляем через Pusher
    chat.participants.forEach(participantId => {
      pusher.trigger(`private-user-${participantId}`, 'new_message', {
        ...data,
        chatId: chatId
      }).catch(err => console.error('Pusher error:', err));
    });
    
    res.json({ success: true, message: data });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// История чата
app.get('/api/history/:chatId', async (req, res) => {
  const { chatId } = req.params;
  const limit = parseInt(req.query.limit) || 100;
  
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('chat_id', chatId)
      .order('timestamp', { ascending: true })
      .limit(limit);
    
    if (error) throw error;
    
    // Преобразуем для фронтенда
    const messages = data.map(m => ({
      id: m.id,
      chatId: m.chat_id,
      senderId: m.sender_id,
      text: m.text,
      timestamp: m.timestamp,
      replyTo: m.reply_to,
      reactions: m.reactions || [],
      pinned: m.pinned || false,
      file: m.file || null,
      edited: m.edited || false
    }));
    
    res.json(messages);
  } catch (error) {
    console.error('Error fetching history:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Pusher авторизация
app.post('/pusher/auth', (req, res) => {
  const socketId = req.body.socket_id;
  const channel = req.body.channel_name;
  
  const userId = channel.replace('private-user-', '');
  
  // Проверяем, существует ли пользователь
  supabase
    .from('users')
    .select('id')
    .eq('id', userId)
    .single()
    .then(({ data }) => {
      if (data) {
        const auth = pusher.authorizeChannel(socketId, channel);
        res.send(auth);
      } else {
        res.status(403).send('Forbidden');
      }
    })
    .catch(() => {
      res.status(403).send('Forbidden');
    });
});

// Обновление профиля
app.post('/api/update-profile', async (req, res) => {
  const { userId, displayName, username, bio, avatar } = req.body;
  
  try {
    const updates = {};
    if (displayName) updates.display_name = displayName;
    if (username) updates.username = username;
    if (bio !== undefined) updates.bio = bio;
    if (avatar) updates.avatar = avatar;
    
    const { data, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', userId)
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ success: true, user: data });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
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
// ЭКСПОРТ
// ============================================
module.exports = app;
