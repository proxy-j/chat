export class ChatRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;

    this.channels = {
      general: [],
      gaming: [],
      memes: []
    };
    this.privateChats = new Map();
    this.privateChatParticipants = new Map();
    this.bannedUsers = new Set();
    this.bannedIPs = new Set();
    this.userWarnings = new Map();
    this.slowMode = { enabled: false, duration: 5 };
    this.messageTimestamps = new Map();
    this.voiceChannels = {
      general: new Set(),
      chill: new Set(),
      gaming: new Set()
    };
    this.userProfiles = new Map();
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket request", { status: 400 });
    }

    const clientIP = request.headers.get("cf-connecting-ip") || "unknown";

    if (this.bannedIPs.has(clientIP)) {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      server.send(JSON.stringify({
        type: 'banned',
        message: 'You are banned from this server (IP ban)'
      }));
      server.close();
      return new Response(null, { status: 101, webSocket: client });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ ip: clientIP });

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);
      const user = ws.deserializeAttachment() || {};
      this.handleMessage(ws, data, user);
    } catch (err) {
      console.error("Error processing websocket message:", err);
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const user = ws.deserializeAttachment();
    if (user && user.username) {
      for (const channel of Object.keys(this.voiceChannels)) {
        if (this.voiceChannels[channel].has(user.username)) {
          this.voiceChannels[channel].delete(user.username);
          this.broadcast({
            type: 'voiceUserLeft',
            username: user.username,
            channel
          });
          this.broadcast({
            type: 'voiceUsers',
            users: Array.from(this.voiceChannels[channel]),
            channel
          });
        }
      }
      this.broadcast({ type: 'userList', users: this.getUserList() });
    }
  }

  async webSocketError(ws, error) {
    console.error("WebSocket error:", error);
  }

  broadcast(data, excludeWs = null) {
    const payload = JSON.stringify(data);
    for (const ws of this.ctx.getSockets()) {
      if (ws !== excludeWs) {
        try {
          ws.send(payload);
        } catch (e) {}
      }
    }
  }

  sendToUser(uuid, data) {
    const payload = JSON.stringify(data);
    for (const ws of this.ctx.getSockets()) {
      const u = ws.deserializeAttachment();
      if (u && u.uuid === uuid) {
        try {
          ws.send(payload);
        } catch (e) {}
      }
    }
  }

  sendToUsers(uuids, data) {
    uuids.forEach(uuid => this.sendToUser(uuid, data));
  }

  getUserList() {
    const list = [];
    for (const ws of this.ctx.getSockets()) {
      const u = ws.deserializeAttachment();
      if (u && u.username) {
        list.push({
          username: u.username,
          isAdmin: !!u.isAdmin,
          isVIP: !!u.isVIP,
          isOwner: !!u.isOwner
        });
      }
    }
    return list;
  }

  getOnlineUserByUsername(username) {
    for (const ws of this.ctx.getSockets()) {
      const u = ws.deserializeAttachment();
      if (u && u.username === username) {
        return { ws, user: u };
      }
    }
    return null;
  }

  canModerate(moderator, target) {
    if (target.isOwner) return false;
    if (moderator.isOwner) return true;
    if (moderator.isAdmin && !target.isAdmin) return true;
    return false;
  }

  handleMessage(ws, data, user) {
    const handlers = {
      join: (ws, data) => this.handleJoin(ws, data, user),
      message: (ws, data) => this.handleChannelMessage(ws, data, user),
      privateMessage: (ws, data) => this.handlePrivateMessage(ws, data, user),
      privateChatRequest: (ws, data) => this.handlePrivateChatRequest(ws, data, user),
      privateChatResponse: (ws, data) => this.handlePrivateChatResponse(ws, data, user),
      getHistory: (ws, data) => this.handleGetHistory(ws, data, user),
      getPrivateHistory: (ws, data) => this.handleGetPrivateHistory(ws, data, user),
      addReaction: (ws, data) => this.handleAddReaction(ws, data, user),
      removeReaction: (ws, data) => this.handleRemoveReaction(ws, data, user),
      typing: (ws, data) => this.handleTyping(ws, data, user),

      joinVoice: (ws, data) => this.handleJoinVoice(ws, data, user),
      leaveVoice: (ws, data) => this.handleLeaveVoice(ws, data, user),
      voiceOffer: (ws, data) => this.handleVoiceOffer(ws, data, user),
      voiceAnswer: (ws, data) => this.handleVoiceAnswer(ws, data, user),
      voiceIceCandidate: (ws, data) => this.handleVoiceIceCandidate(ws, data, user),

      updateProfile: (ws, data) => this.handleUpdateProfile(ws, data, user),

      adminKick: (ws, data) => this.handleAdminKick(ws, data, user),
      adminTimeout: (ws, data) => this.handleAdminTimeout(ws, data, user),
      adminBan: (ws, data) => this.handleAdminBan(ws, data, user),
      adminUnban: (ws, data) => this.handleAdminUnban(ws, data, user),
      adminUnbanIP: (ws, data) => this.handleAdminUnbanIP(ws, data, user),
      adminForceMute: (ws, data) => this.handleAdminForceMute(ws, data, user),
      adminWarning: (ws, data) => this.handleAdminWarning(ws, data, user),
      adminDeleteMessage: (ws, data) => this.handleAdminDeleteMessage(ws, data, user),
      adminGetBanList: (ws) => this.handleAdminGetBanList(ws, user),
      adminBroadcast: (ws, data) => this.handleAdminBroadcast(ws, data, user),
      adminSlowMode: (ws, data) => this.handleAdminSlowMode(ws, data, user),
      adminClearChat: (ws, data) => this.handleAdminClearChat(ws, data, user),
      adminSpinScreen: (ws, data) => this.handleAdminEffect(ws, data, user, 'spinScreen'),
      adminShakeScreen: (ws, data) => this.handleAdminEffect(ws, data, user, 'shakeScreen'),
      adminFlipScreen: (ws, data) => this.handleAdminEffect(ws, data, user, 'flipScreen'),
      adminInvertColors: (ws, data) => this.handleAdminEffect(ws, data, user, 'invertColors'),
      adminRainbow: (ws, data) => this.handleAdminEffect(ws, data, user, 'rainbow'),
      adminBlur: (ws, data) => this.handleAdminEffect(ws, data, user, 'blur'),
      adminMatrix: (ws, data) => this.handleAdminEffect(ws, data, user, 'matrix'),
      adminEmojiSpam: (ws, data) => this.handleAdminEffect(ws, data, user, 'emojiSpam'),
      adminConfetti: (ws) => this.handleAdminConfettiAll(ws, user),
      adminRickRoll: (ws, data) => this.handleAdminEffect(ws, data, user, 'rickRoll'),
      adminForceDisconnect: (ws, data) => this.handleAdminForceDisconnect(ws, data, user)
    };

    const handler = handlers[data.type];
    if (handler) {
      handler(ws, data);
    }
  }

  handleJoin(ws, data, attachment) {
    const clientIP = attachment.ip || 'unknown';

    if (this.bannedUsers.has(data.username)) {
      ws.send(JSON.stringify({
        type: 'banned',
        message: 'You are banned from this server'
      }));
      ws.close();
      return;
    }

    const PASSWORDS = {
      owner: this.env.OWNER_PASSWORD || '10dabestestowna',
      admin: this.env.ADMIN_PASSWORD || 'mod-is-rly-awesome',
      vip: this.env.VIP_PASSWORD || 'very-important-person'
    };

    const uuid = data.uuid || crypto.randomUUID();
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

    const user = {
      ...attachment,
      uuid,
      username: data.username,
      isOwner,
      isAdmin,
      isVIP,
      ip: clientIP
    };

    ws.serializeAttachment(user);

    ws.send(JSON.stringify({
      type: 'joined',
      uuid,
      isOwner,
      isAdmin,
      isVIP
    }));

    this.broadcast({ type: 'userList', users: this.getUserList() });
  }

  handleChannelMessage(ws, data, user) {
    if (!user || !user.username) return;

    if (this.slowMode.enabled) {
      const lastMsg = this.messageTimestamps.get(user.uuid);
      if (lastMsg && Date.now() - lastMsg < this.slowMode.duration * 1000) {
        ws.send(JSON.stringify({
          type: 'error',
          message: `Slow mode: wait ${this.slowMode.duration}s between messages`
        }));
        return;
      }
    }

    this.messageTimestamps.set(user.uuid, Date.now());

    const profile = this.userProfiles.get(user.username) || {};
    const message = {
      id: crypto.randomUUID(),
      author: user.username,
      text: data.text,
      channel: data.channel,
      timestamp: Date.now(),
      isOwner: user.isOwner,
      isAdmin: user.isAdmin,
      isVIP: user.isVIP,
      replyTo: data.replyTo || null,
      reactions: {},
      imageUrl: data.imageUrl || null,
      profileColor: profile.profileColor || 'default'
    };

    if (this.channels[data.channel]) {
      this.channels[data.channel].push(message);

      if (this.channels[data.channel].length > 100) {
        this.channels[data.channel].shift();
      }

      this.broadcast({ type: 'message', message });
    }
  }

  handlePrivateMessage(ws, data, user) {
    if (!user || !user.username) return;

    const profile = this.userProfiles.get(user.username) || {};
    const message = {
      id: crypto.randomUUID(),
      author: user.username,
      text: data.text,
      chatId: data.chatId,
      timestamp: Date.now(),
      isOwner: user.isOwner,
      isAdmin: user.isAdmin,
      isVIP: user.isVIP,
      replyTo: data.replyTo || null,
      reactions: {},
      imageUrl: data.imageUrl || null,
      profileColor: profile.profileColor || 'default'
    };

    if (!this.privateChats.has(data.chatId)) {
      this.privateChats.set(data.chatId, []);
    }

    this.privateChats.get(data.chatId).push(message);

    const participants = this.privateChatParticipants.get(data.chatId);
    if (participants) {
      this.sendToUsers(participants, { type: 'privateMessage', message });
    }
  }

  handlePrivateChatRequest(ws, data, user) {
    if (!user || !user.username) return;

    const target = this.getOnlineUserByUsername(data.targetUsername);
    if (!target) {
      ws.send(JSON.stringify({ type: 'error', message: 'User not online' }));
      return;
    }

    for (const [chatId, participants] of this.privateChatParticipants.entries()) {
      if (participants.includes(user.uuid) && participants.includes(target.user.uuid)) {
        ws.send(JSON.stringify({
          type: 'privateChatAccepted',
          chatId,
          with: data.targetUsername
        }));

        target.ws.send(JSON.stringify({
          type: 'privateChatAccepted',
          chatId,
          with: user.username
        }));
        return;
      }
    }

    target.ws.send(JSON.stringify({
      type: 'privateChatRequest',
      from: user.username,
      fromUuid: user.uuid
    }));
  }

  handlePrivateChatResponse(ws, data, user) {
    if (!user || !user.username) return;

    const requester = this.getOnlineUserByUsername(data.from);
    if (!requester) return;

    if (data.accepted) {
      for (const [chatId, participants] of this.privateChatParticipants.entries()) {
        if (participants.includes(user.uuid) && participants.includes(requester.user.uuid)) {
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
          return;
        }
      }

      const chatId = crypto.randomUUID();
      this.privateChatParticipants.set(chatId, [user.uuid, requester.user.uuid]);
      this.privateChats.set(chatId, []);

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

  handleGetHistory(ws, data, user) {
    if (!user || !user.username) return;
    const messages = this.channels[data.channel] || [];
    ws.send(JSON.stringify({
      type: 'history',
      channel: data.channel,
      messages
    }));
  }

  handleGetPrivateHistory(ws, data, user) {
    if (!user || !user.username) return;
    const messages = this.privateChats.get(data.chatId) || [];
    ws.send(JSON.stringify({
      type: 'privateHistory',
      chatId: data.chatId,
      messages
    }));
  }

  handleAddReaction(ws, data, user) {
    if (!user || !user.username) return;

    let message;
    if (data.isPrivate) {
      const messages = this.privateChats.get(data.chatId) || [];
      message = messages.find(m => m.id === data.messageId);
    } else {
      message = this.channels[data.channel]?.find(m => m.id === data.messageId);
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
        const participants = this.privateChatParticipants.get(data.chatId);
        if (participants) this.sendToUsers(participants, update);
      } else {
        this.broadcast(update);
      }
    }
  }

  handleRemoveReaction(ws, data, user) {
    if (!user || !user.username) return;

    let message;
    if (data.isPrivate) {
      const messages = this.privateChats.get(data.chatId) || [];
      message = messages.find(m => m.id === data.messageId);
    } else {
      message = this.channels[data.channel]?.find(m => m.id === data.messageId);
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
        const participants = this.privateChatParticipants.get(data.chatId);
        if (participants) this.sendToUsers(participants, update);
      } else {
        this.broadcast(update);
      }
    }
  }

  handleTyping(ws, data, user) {
    if (!user || !user.username) return;

    this.broadcast({
      type: 'typing',
      username: user.username,
      channel: data.channel,
      isTyping: data.isTyping,
      isPrivate: data.isPrivate
    }, ws);
  }

  handleUpdateProfile(ws, data, user) {
    if (!user || !user.username) return;

    this.userProfiles.set(user.username, {
      profileColor: data.profileColor || 'default'
    });
  }

  handleJoinVoice(ws, data, user) {
    if (!user || !user.username) return;
    const channel = data.channel || 'general';
    if (!this.voiceChannels[channel]) return;

    this.voiceChannels[channel].add(user.username);

    this.broadcast({
      type: 'voiceUsers',
      users: Array.from(this.voiceChannels[channel]),
      channel
    });
  }

  handleLeaveVoice(ws, data, user) {
    if (!user || !user.username) return;
    const channel = data.channel || 'general';
    if (!this.voiceChannels[channel]) return;

    this.voiceChannels[channel].delete(user.username);

    this.broadcast({
      type: 'voiceUserLeft',
      username: user.username,
      channel
    });

    this.broadcast({
      type: 'voiceUsers',
      users: Array.from(this.voiceChannels[channel]),
      channel
    });
  }

  handleVoiceOffer(ws, data, user) {
    if (!user || !user.username) return;
    const target = this.getOnlineUserByUsername(data.to);
    if (target) {
      target.ws.send(JSON.stringify({
        type: 'voiceOffer',
        from: user.username,
        offer: data.offer,
        channel: data.channel
      }));
    }
  }

  handleVoiceAnswer(ws, data, user) {
    if (!user || !user.username) return;
    const target = this.getOnlineUserByUsername(data.to);
    if (target) {
      target.ws.send(JSON.stringify({
        type: 'voiceAnswer',
        from: user.username,
        answer: data.answer,
        channel: data.channel
      }));
    }
  }

  handleVoiceIceCandidate(ws, data, user) {
    if (!user || !user.username) return;
    const target = this.getOnlineUserByUsername(data.to);
    if (target) {
      target.ws.send(JSON.stringify({
        type: 'voiceIceCandidate',
        from: user.username,
        candidate: data.candidate
      }));
    }
  }

  handleAdminKick(ws, data, admin) {
    if (!admin || (!admin.isAdmin && !admin.isOwner)) return;
    const target = this.getOnlineUserByUsername(data.targetUsername);
    if (!target) return;

    if (!this.canModerate(admin, target.user)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Cannot moderate this user' }));
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

  handleAdminTimeout(ws, data, admin) {
    if (!admin || (!admin.isAdmin && !admin.isOwner)) return;
    const target = this.getOnlineUserByUsername(data.targetUsername);
    if (!target) return;

    if (!this.canModerate(admin, target.user)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Cannot moderate this user' }));
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

  handleAdminBan(ws, data, admin) {
    if (!admin || (!admin.isAdmin && !admin.isOwner)) return;
    const target = this.getOnlineUserByUsername(data.targetUsername);

    if (target && !this.canModerate(admin, target.user)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Cannot moderate this user' }));
      return;
    }

    if (data.banType === 'username' || data.banType === 'both') {
      this.bannedUsers.add(data.targetUsername);
    }

    if (target && (data.banType === 'ip' || data.banType === 'both')) {
      this.bannedIPs.add(target.user.ip);
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

  handleAdminUnban(ws, data, admin) {
    if (!admin || (!admin.isAdmin && !admin.isOwner)) return;
    this.bannedUsers.delete(data.username);
    ws.send(JSON.stringify({
      type: 'adminActionSuccess',
      message: `Unbanned ${data.username}`
    }));
  }

  handleAdminUnbanIP(ws, data, admin) {
    if (!admin || (!admin.isAdmin && !admin.isOwner)) return;
    this.bannedIPs.delete(data.ip);
    ws.send(JSON.stringify({
      type: 'adminActionSuccess',
      message: `Unbanned IP ${data.ip}`
    }));
  }

  handleAdminForceMute(ws, data, admin) {
    if (!admin || (!admin.isAdmin && !admin.isOwner)) return;
    const target = this.getOnlineUserByUsername(data.targetUsername);
    if (!target) return;

    if (!this.canModerate(admin, target.user)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Cannot moderate this user' }));
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

  handleAdminWarning(ws, data, admin) {
    if (!admin || (!admin.isAdmin && !admin.isOwner)) return;
    const target = this.getOnlineUserByUsername(data.targetUsername);
    if (!target) return;

    if (!this.canModerate(admin, target.user)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Cannot moderate this user' }));
      return;
    }

    const count = (this.userWarnings.get(target.user.uuid) || 0) + 1;
    this.userWarnings.set(target.user.uuid, count);

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

  handleAdminDeleteMessage(ws, data, admin) {
    if (!admin || (!admin.isAdmin && !admin.isOwner)) return;

    if (this.channels[data.channel]) {
      this.channels[data.channel] = this.channels[data.channel].filter(m => m.id !== data.messageId);

      this.broadcast({
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

  handleAdminGetBanList(ws, admin) {
    if (!admin || (!admin.isAdmin && !admin.isOwner)) return;

    ws.send(JSON.stringify({
      type: 'banList',
      bannedUsers: Array.from(this.bannedUsers),
      bannedIPs: Array.from(this.bannedIPs)
    }));
  }

  handleAdminBroadcast(ws, data, admin) {
    if (!admin || (!admin.isAdmin && !admin.isOwner)) return;

    this.broadcast({
      type: 'broadcast',
      message: data.message
    });

    ws.send(JSON.stringify({
      type: 'adminActionSuccess',
      message: 'Broadcast sent'
    }));
  }

  handleAdminSlowMode(ws, data, admin) {
    if (!admin || (!admin.isAdmin && !admin.isOwner)) return;

    this.slowMode.enabled = data.enabled;
    this.slowMode.duration = data.duration;

    ws.send(JSON.stringify({
      type: 'adminActionSuccess',
      message: `Slow mode ${data.enabled ? 'enabled' : 'disabled'}`
    }));
  }

  handleAdminClearChat(ws, data, admin) {
    if (!admin || (!admin.isAdmin && !admin.isOwner)) return;

    if (this.channels[data.channel]) {
      this.channels[data.channel] = [];

      this.broadcast({
        type: 'chatCleared',
        channel: data.channel
      });
    }

    ws.send(JSON.stringify({
      type: 'adminActionSuccess',
      message: `Cleared #${data.channel}`
    }));
  }

  handleAdminEffect(ws, data, admin, effectType) {
    if (!admin || (!admin.isAdmin && !admin.isOwner)) return;

    const target = this.getOnlineUserByUsername(data.targetUsername);
    if (!target) return;

    target.ws.send(JSON.stringify({ type: effectType }));

    ws.send(JSON.stringify({
      type: 'adminActionSuccess',
      message: `Effect sent to ${data.targetUsername}`
    }));
  }

  handleAdminConfettiAll(ws, admin) {
    if (!admin || (!admin.isAdmin && !admin.isOwner)) return;

    this.broadcast({ type: 'confetti' });

    ws.send(JSON.stringify({
      type: 'adminActionSuccess',
      message: 'Confetti sent to all users'
    }));
  }

  handleAdminForceDisconnect(ws, data, admin) {
    if (!admin || (!admin.isAdmin && !admin.isOwner)) return;

    const target = this.getOnlineUserByUsername(data.targetUsername);
    if (!target) return;

    if (!this.canModerate(admin, target.user)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Cannot moderate this user' }));
      return;
    }

    target.ws.send(JSON.stringify({ type: 'forceDisconnect' }));
    setTimeout(() => target.ws.close(), 500);

    ws.send(JSON.stringify({
      type: 'adminActionSuccess',
      message: `Disconnected ${data.targetUsername}`
    }));
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.headers.get("Upgrade") === "websocket") {
      const id = env.CHAT_ROOM.idFromName("global");
      const room = env.CHAT_ROOM.get(id);
      return room.fetch(request);
    }

    return env.ASSETS.fetch(request);
  }
};
