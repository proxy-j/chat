const WebSocket = require('ws');
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const wss = new WebSocket.Server({ server });

// Data structures
const users = new Map(); // uuid -> user data
const connections = new Map(); // ws -> user data
const channels = {
  announcements: [],
  general: [],
  gaming: [],
  memes: []
};
const privateChats = new Map(); // chatId -> messages array
const privateChatParticipants = new Map(); // chatId -> [uuid1, uuid2]
const bannedUsers = new Set();
const bannedIPs = new Set();
const userWarnings = new Map(); // uuid -> count
const slowMode = { enabled: false, duration: 5 };
const messageTimestamps = new Map(); // uuid -> last message timestamp

// Passwords
const PASSWORDS = {
  owner: '10owna12',
  admin: 'mod-is-rly-awesome',
  vip: 'very-important-person'
};

// Helper functions
function generateId() {
  return crypto.randomBytes(16).toString('hex');
}

function broadcast(data, exclude = null) {
  connections.forEach((user, ws) => {
    if (ws !== exclude && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  });
}

function sendToUser(uuid, data) {
  connections.forEach((user, ws) => {
    if (user.uuid === uuid && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  });
}

function sendToUsers(uuids, data) {
  uuids.forEach(uuid => sendToUser(uuid, data));
}

function getUserList() {
  const list = [];
  connections.forEach(user => {
    list.push({
      username: user.username,
      isAdmin: user.isAdmin,
      isVIP: user.isVIP,
      isOwner: user.isOwner
    });
  });
  return list;
}

function isUserOnline(username) {
  for (const user of connections.values()) {
    if (user.username === username) return true;
  }
  return false;
}

function getOnlineUserByUsername(username) {
  for (const [ws, user] of connections.entries()) {
    if (user.username === username) return { ws, user };
  }
  return null;
}

function canModerate(moderator, target) {
  if (target.isOwner) return false;
  if (moderator.isOwner) return true;
  if (moderator.isAdmin && !target.isAdmin) return true;
  return false;
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  const clientIP = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';

  // Check IP ban
  if (bannedIPs.has(clientIP)) {
    ws.send(JSON.stringify({
      type: 'banned',
      message: 'You are banned from this server (IP ban)'
    }));
    ws.close();
    return;
  }

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(ws, data, clientIP);
    } catch (error) {
      console.error('Error handling message:', error);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  });

  ws.on('close', () => {
    const user = connections.get(ws);
    if (user) {
      connections.delete(ws);
      broadcast({ type: 'userList', users: getUserList() });
    }
  });
});

function handleMessage(ws, data, clientIP) {
  const handlers = {
    join: handleJoin,
    message: handleChannelMessage,
    privateMessage: handlePrivateMessage,
    privateChatRequest: handlePrivateChatRequest,
    privateChatResponse: handlePrivateChatResponse,
    getHistory: handleGetHistory,
    getPrivateHistory: handleGetPrivateHistory,
    addReaction: handleAddReaction,
    removeReaction: handleRemoveReaction,
    typing: handleTyping,
    
    // Admin commands
    adminKick: handleAdminKick,
    adminTimeout: handleAdminTimeout,
    adminBan: handleAdminBan,
    adminUnban: handleAdminUnban,
    adminUnbanIP: handleAdminUnbanIP,
    adminForceMute: handleAdminForceMute,
    adminWarning: handleAdminWarning,
    adminDeleteMessage: handleAdminDeleteMessage,
    adminGetBanList: handleAdminGetBanList,
    adminBroadcast: handleAdminBroadcast,
    adminSlowMode: handleAdminSlowMode,
    adminClearChat: handleAdminClearChat,
    
    // Admin troll commands
    adminSpinScreen: (ws, data) => handleAdminEffect(ws, data, 'spinScreen'),
    adminShakeScreen: (ws, data) => handleAdminEffect(ws, data, 'shakeScreen'),
    adminFlipScreen: (ws, data) => handleAdminEffect(ws, data, 'flipScreen'),
    adminInvertColors: (ws, data) => handleAdminEffect(ws, data, 'invertColors'),
    adminRainbow: (ws, data) => handleAdminEffect(ws, data, 'rainbow'),
    adminBlur: (ws, data) => handleAdminEffect(ws, data, 'blur'),
    adminMatrix: (ws, data) => handleAdminEffect(ws, data, 'matrix'),
    adminEmojiSpam: (ws, data) => handleAdminEffect(ws, data, 'emojiSpam'),
    adminConfetti: handleAdminConfettiAll,
    adminRickRoll: (ws, data) => handleAdminEffect(ws, data, 'rickRoll'),
    adminForceDisconnect: handleAdminForceDisconnect,
    
    // Owner commands
    ownerAnnouncement: handleOwnerAnnouncement
  };

  const handler = handlers[data.type];
  if (handler) {
    handler(ws, data, clientIP);
  }
}

function handleJoin(ws, data, clientIP) {
  // Check username ban
  if (bannedUsers.has(data.username)) {
    ws.send(JSON.stringify({
      type: 'banned',
      message: 'You are banned from this server'
    }));
    ws.close();
    return;
  }

  // Generate or retrieve UUID
  let uuid = data.uuid || generateId();
  
  // Determine role
  let isOwner = false;
  let isAdmin = false;
  let isVIP = false;

  if (data.ownerPassword === PASSWORDS.owner) {
    isOwner = true;
    isAdmin = true;
  } else if (data.adminPassword === PASSWORDS.admin) {
    isAdmin = true;
  } else if (data.vipPassword === PASSWORDS.vip) {
    isVIP = true;
  }

  // Store user
  const user = {
    uuid,
    username: data.username,
    isOwner,
    isAdmin,
    isVIP,
    ip: clientIP
  };

  connections.set(ws, user);
  users.set(uuid, user);

  // Send joined confirmation
  ws.send(JSON.stringify({
    type: 'joined',
    uuid,
    isOwner,
    isAdmin,
    isVIP
  }));

  // Broadcast updated user list
  broadcast({ type: 'userList', users: getUserList() });
}

function handleChannelMessage(ws, data) {
  const user = connections.get(ws);
  if (!user) return;

  // Check slow mode
  if (slowMode.enabled) {
    const lastMsg = messageTimestamps.get(user.uuid);
    if (lastMsg && Date.now() - lastMsg < slowMode.duration * 1000) {
      ws.send(JSON.stringify({
        type: 'error',
        message: `Slow mode: wait ${slowMode.duration}s between messages`
      }));
      return;
    }
  }

  messageTimestamps.set(user.uuid, Date.now());

  const message = {
    id: generateId(),
    author: user.username,
    text: data.text,
    channel: data.channel,
    timestamp: Date.now(),
    isOwner: user.isOwner,
    isAdmin: user.isAdmin,
    isVIP: user.isVIP,
    replyTo: data.replyTo || null,
    reactions: {}
  };

  if (channels[data.channel]) {
    channels[data.channel].push(message);
    
    // Keep only last 100 messages per channel
    if (channels[data.channel].length > 100) {
      channels[data.channel].shift();
    }

    broadcast({ type: 'message', message });
  }
}

function handlePrivateMessage(ws, data) {
  const user = connections.get(ws);
  if (!user) return;

  const message = {
    id: generateId(),
    author: user.username,
    text: data.text,
    chatId: data.chatId,
    timestamp: Date.now(),
    isOwner: user.isOwner,
    isAdmin: user.isAdmin,
    isVIP: user.isVIP,
    replyTo: data.replyTo || null,
    reactions: {}
  };

  if (!privateChats.has(data.chatId)) {
    privateChats.set(data.chatId, []);
  }

  privateChats.get(data.chatId).push(message);

  // Send to both participants
  const participants = privateChatParticipants.get(data.chatId);
  if (participants) {
    sendToUsers(participants, { type: 'privateMessage', message });
  }
}

function handlePrivateChatRequest(ws, data) {
  const user = connections.get(ws);
  if (!user) return;

  const target = getOnlineUserByUsername(data.targetUsername);
  if (!target) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'User not online'
    }));
    return;
  }

  // Send request to target
  target.ws.send(JSON.stringify({
    type: 'privateChatRequest',
    from: user.username,
    fromUuid: user.uuid
  }));
}

function handlePrivateChatResponse(ws, data) {
  const user = connections.get(ws);
  if (!user) return;

  const requester = getOnlineUserByUsername(data.from);
  if (!requester) return;

  if (data.accepted) {
    const chatId = generateId();
    privateChatParticipants.set(chatId, [user.uuid, requester.user.uuid]);
    privateChats.set(chatId, []);

    // Notify both users
    ws.send(JSON.stringify({
      type: 'privateChatAccepted',
      chatId,
      with: data.from
    }));

    requester.ws.send(JSON.stringify({
      type: 'privateChatAccepted',
      chatId,
      with: user.username
    }));
  } else {
    requester.ws.send(JSON.stringify({
      type: 'privateChatRejected',
      by: user.username
    }));
  }
}

function handleGetHistory(ws, data) {
  const user = connections.get(ws);
  if (!user) return;

  const messages = channels[data.channel] || [];
  ws.send(JSON.stringify({
    type: 'history',
    channel: data.channel,
    messages
  }));
}

function handleGetPrivateHistory(ws, data) {
  const user = connections.get(ws);
  if (!user) return;

  const messages = privateChats.get(data.chatId) || [];
  ws.send(JSON.stringify({
    type: 'privateHistory',
    chatId: data.chatId,
    messages
  }));
}

function handleAddReaction(ws, data) {
  const user = connections.get(ws);
  if (!user) return;

  let message;
  if (data.isPrivate) {
    const messages = privateChats.get(data.chatId) || [];
    message = messages.find(m => m.id === data.messageId);
  } else {
    message = channels[data.channel]?.find(m => m.id === data.messageId);
  }

  if (message) {
    if (!message.reactions[data.emoji]) {
      message.reactions[data.emoji] = [];
    }
    if (!message.reactions[data.emoji].includes(user.username)) {
      message.reactions[data.emoji].push(user.username);
    }

    const update = {
      type: 'reactionUpdate',
      messageId: data.messageId,
      reactions: message.reactions,
      channel: data.channel,
      isPrivate: data.isPrivate,
      chatId: data.chatId
    };

    if (data.isPrivate) {
      const participants = privateChatParticipants.get(data.chatId);
      if (participants) sendToUsers(participants, update);
    } else {
      broadcast(update);
    }
  }
}

function handleRemoveReaction(ws, data) {
  const user = connections.get(ws);
  if (!user) return;

  let message;
  if (data.isPrivate) {
    const messages = privateChats.get(data.chatId) || [];
    message = messages.find(m => m.id === data.messageId);
  } else {
    message = channels[data.channel]?.find(m => m.id === data.messageId);
  }

  if (message && message.reactions[data.emoji]) {
    message.reactions[data.emoji] = message.reactions[data.emoji].filter(
      u => u !== user.username
    );
    if (message.reactions[data.emoji].length === 0) {
      delete message.reactions[data.emoji];
    }

    const update = {
      type: 'reactionUpdate',
      messageId: data.messageId,
      reactions: message.reactions,
      channel: data.channel,
      isPrivate: data.isPrivate,
      chatId: data.chatId
    };

    if (data.isPrivate) {
      const participants = privateChatParticipants.get(data.chatId);
      if (participants) sendToUsers(participants, update);
    } else {
      broadcast(update);
    }
  }
}

function handleTyping(ws, data) {
  const user = connections.get(ws);
  if (!user) return;

  broadcast({
    type: 'typing',
    username: user.username,
    channel: data.channel,
    isTyping: data.isTyping,
    isPrivate: data.isPrivate
  }, ws);
}

// Admin commands
function handleAdminKick(ws, data) {
  const admin = connections.get(ws);
  if (!admin || (!admin.isAdmin && !admin.isOwner)) return;

  const target = getOnlineUserByUsername(data.targetUsername);
  if (!target) return;

  if (!canModerate(admin, target.user)) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Cannot moderate this user'
    }));
    return;
  }

  target.ws.send(JSON.stringify({
    type: 'kicked',
    message: `You have been kicked${data.reason ? ': ' + data.reason : ''}`,
    redirectUrl: 'https://google.com'
  }));

  setTimeout(() => target.ws.close(), 500);

  ws.send(JSON.stringify({
    type: 'adminActionSuccess',
    message: `Kicked ${data.targetUsername}`
  }));
}

function handleAdminTimeout(ws, data) {
  const admin = connections.get(ws);
  if (!admin || (!admin.isAdmin && !admin.isOwner)) return;

  const target = getOnlineUserByUsername(data.targetUsername);
  if (!target) return;

  if (!canModerate(admin, target.user)) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Cannot moderate this user'
    }));
    return;
  }

  target.ws.send(JSON.stringify({
    type: 'timedOut',
    message: `You have been timed out for ${data.duration}s${data.reason ? ': ' + data.reason : ''}`
  }));

  ws.send(JSON.stringify({
    type: 'adminActionSuccess',
    message: `Timed out ${data.targetUsername} for ${data.duration}s`
  }));
}

function handleAdminBan(ws, data) {
  const admin = connections.get(ws);
  if (!admin || (!admin.isAdmin && !admin.isOwner)) return;

  const target = getOnlineUserByUsername(data.targetUsername);
  
  if (target && !canModerate(admin, target.user)) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Cannot moderate this user'
    }));
    return;
  }

  // Apply ban based on type
  if (data.banType === 'username' || data.banType === 'both') {
    bannedUsers.add(data.targetUsername);
  }
  
  if (target && (data.banType === 'ip' || data.banType === 'both')) {
    bannedIPs.add(target.user.ip);
  }

  if (target) {
    target.ws.send(JSON.stringify({
      type: 'banned',
      message: `You have been banned${data.reason ? ': ' + data.reason : ''}`
    }));
    setTimeout(() => target.ws.close(), 500);
  }

  ws.send(JSON.stringify({
    type: 'adminActionSuccess',
    message: `Banned ${data.targetUsername}`
  }));
}

function handleAdminUnban(ws, data) {
  const admin = connections.get(ws);
  if (!admin || (!admin.isAdmin && !admin.isOwner)) return;

  bannedUsers.delete(data.username);

  ws.send(JSON.stringify({
    type: 'adminActionSuccess',
    message: `Unbanned ${data.username}`
  }));
}

function handleAdminUnbanIP(ws, data) {
  const admin = connections.get(ws);
  if (!admin || (!admin.isAdmin && !admin.isOwner)) return;

  bannedIPs.delete(data.ip);

  ws.send(JSON.stringify({
    type: 'adminActionSuccess',
    message: `Unbanned IP ${data.ip}`
  }));
}

function handleAdminForceMute(ws, data) {
  const admin = connections.get(ws);
  if (!admin || (!admin.isAdmin && !admin.isOwner)) return;

  const target = getOnlineUserByUsername(data.targetUsername);
  if (!target) return;

  if (!canModerate(admin, target.user)) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Cannot moderate this user'
    }));
    return;
  }

  target.ws.send(JSON.stringify({
    type: 'forceMute',
    duration: data.duration
  }));

  ws.send(JSON.stringify({
    type: 'adminActionSuccess',
    message: `Muted ${data.targetUsername} for ${data.duration}s`
  }));
}

function handleAdminWarning(ws, data) {
  const admin = connections.get(ws);
  if (!admin || (!admin.isAdmin && !admin.isOwner)) return;

  const target = getOnlineUserByUsername(data.targetUsername);
  if (!target) return;

  if (!canModerate(admin, target.user)) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Cannot moderate this user'
    }));
    return;
  }

  const count = (userWarnings.get(target.user.uuid) || 0) + 1;
  userWarnings.set(target.user.uuid, count);

  target.ws.send(JSON.stringify({
    type: 'warning',
    message: data.reason || 'You have been warned',
    count
  }));

  ws.send(JSON.stringify({
    type: 'adminActionSuccess',
    message: `Warned ${data.targetUsername} (Warning #${count})`
  }));
}

function handleAdminDeleteMessage(ws, data) {
  const admin = connections.get(ws);
  if (!admin || (!admin.isAdmin && !admin.isOwner)) return;

  if (channels[data.channel]) {
    channels[data.channel] = channels[data.channel].filter(
      m => m.id !== data.messageId
    );

    broadcast({
      type: 'messageDeleted',
      messageId: data.messageId,
      channel: data.channel
    });
  }

  ws.send(JSON.stringify({
    type: 'adminActionSuccess',
    message: 'Message deleted'
  }));
}

function handleAdminGetBanList(ws) {
  const admin = connections.get(ws);
  if (!admin || (!admin.isAdmin && !admin.isOwner)) return;

  ws.send(JSON.stringify({
    type: 'banList',
    bannedUsers: Array.from(bannedUsers),
    bannedIPs: Array.from(bannedIPs)
  }));
}

function handleAdminBroadcast(ws, data) {
  const admin = connections.get(ws);
  if (!admin || (!admin.isAdmin && !admin.isOwner)) return;

  broadcast({
    type: 'broadcast',
    message: data.message
  });

  ws.send(JSON.stringify({
    type: 'adminActionSuccess',
    message: 'Broadcast sent'
  }));
}

function handleAdminSlowMode(ws, data) {
  const admin = connections.get(ws);
  if (!admin || (!admin.isAdmin && !admin.isOwner)) return;

  slowMode.enabled = data.enabled;
  slowMode.duration = data.duration;

  ws.send(JSON.stringify({
    type: 'adminActionSuccess',
    message: `Slow mode ${data.enabled ? 'enabled' : 'disabled'}`
  }));
}

function handleAdminClearChat(ws, data) {
  const admin = connections.get(ws);
  if (!admin || (!admin.isAdmin && !admin.isOwner)) return;

  if (channels[data.channel]) {
    channels[data.channel] = [];

    broadcast({
      type: 'chatCleared',
      channel: data.channel
    });
  }

  ws.send(JSON.stringify({
    type: 'adminActionSuccess',
    message: `Cleared #${data.channel}`
  }));
}

function handleAdminEffect(ws, data, effectType) {
  const admin = connections.get(ws);
  if (!admin || (!admin.isAdmin && !admin.isOwner)) return;

  const target = getOnlineUserByUsername(data.targetUsername);
  if (!target) return;

  target.ws.send(JSON.stringify({ type: effectType }));

  ws.send(JSON.stringify({
    type: 'adminActionSuccess',
    message: `Effect sent to ${data.targetUsername}`
  }));
}

function handleAdminConfettiAll(ws) {
  const admin = connections.get(ws);
  if (!admin || (!admin.isAdmin && !admin.isOwner)) return;

  broadcast({ type: 'confetti' });

  ws.send(JSON.stringify({
    type: 'adminActionSuccess',
    message: 'Confetti sent to all users'
  }));
}

function handleAdminForceDisconnect(ws, data) {
  const admin = connections.get(ws);
  if (!admin || (!admin.isAdmin && !admin.isOwner)) return;

  const target = getOnlineUserByUsername(data.targetUsername);
  if (!target) return;

  if (!canModerate(admin, target.user)) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Cannot moderate this user'
    }));
    return;
  }

  target.ws.send(JSON.stringify({ type: 'forceDisconnect' }));
  setTimeout(() => target.ws.close(), 500);

  ws.send(JSON.stringify({
    type: 'adminActionSuccess',
    message: `Disconnected ${data.targetUsername}`
  }));
}

function handleOwnerAnnouncement(ws, data) {
  const owner = connections.get(ws);
  if (!owner || !owner.isOwner) return;

  const message = {
    id: generateId(),
    author: 'ANNOUNCEMENT',
    text: data.text,
    channel: 'announcements',
    timestamp: Date.now(),
    isSystem: true,
    reactions: {}
  };

  channels.announcements.push(message);

  broadcast({
    type: 'announcement',
    message
  });

  ws.send(JSON.stringify({
    type: 'adminActionSuccess',
    message: 'Announcement posted'
  }));
}

console.log('WebSocket server is ready');
