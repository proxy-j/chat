// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(express.json());
app.use(express.static('public'));

// In-memory storage
const channels = {
    general: [],
    random: [],
    gaming: []
};

const users = new Map(); // WebSocket -> user info

// WebSocket connection handler
wss.on('connection', (ws) => {
    console.log('New client connected');
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            handleMessage(ws, message);
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    });

    ws.on('close', () => {
        const user = users.get(ws);
        if (user) {
            console.log(`User ${user.username} disconnected`);
            broadcastUserList();
            users.delete(ws);
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// Handle different message types
function handleMessage(ws, message) {
    switch (message.type) {
        case 'join':
            handleJoin(ws, message);
            break;
        case 'message':
            handleChatMessage(ws, message);
            break;
        case 'getHistory':
            handleGetHistory(ws, message);
            break;
        case 'typing':
            handleTyping(ws, message);
            break;
        default:
            console.log('Unknown message type:', message.type);
    }
}

// User joins
function handleJoin(ws, message) {
    const { username } = message;
    users.set(ws, {
        username,
        id: generateId()
    });

    // Send welcome message
    ws.send(JSON.stringify({
        type: 'joined',
        username,
        channels: Object.keys(channels)
    }));

    // Broadcast updated user list
    broadcastUserList();

    console.log(`User ${username} joined`);
}

// Handle chat messages
function handleChatMessage(ws, message) {
    const user = users.get(ws);
    if (!user) return;

    const { channel, text } = message;
    
    const chatMessage = {
        id: generateId(),
        author: user.username,
        text,
        channel,
        timestamp: new Date().toISOString()
    };

    // Store message
    if (channels[channel]) {
        channels[channel].push(chatMessage);
        
        // Keep only last 100 messages per channel
        if (channels[channel].length > 100) {
            channels[channel].shift();
        }
    }

    // Broadcast to all connected clients
    broadcast({
        type: 'message',
        message: chatMessage
    });

    console.log(`Message from ${user.username} in #${channel}: ${text}`);
}

// Get channel history
function handleGetHistory(ws, message) {
    const { channel } = message;
    
    if (channels[channel]) {
        ws.send(JSON.stringify({
            type: 'history',
            channel,
            messages: channels[channel]
        }));
    }
}

// Handle typing indicator
function handleTyping(ws, message) {
    const user = users.get(ws);
    if (!user) return;

    const { channel, isTyping } = message;
    
    broadcast({
        type: 'typing',
        username: user.username,
        channel,
        isTyping
    }, ws);
}

// Broadcast user list
function broadcastUserList() {
    const userList = Array.from(users.values()).map(u => u.username);
    
    broadcast({
        type: 'userList',
        users: userList
    });
}

// Broadcast to all clients (except sender if specified)
function broadcast(message, excludeWs = null) {
    const data = JSON.stringify(message);
    
    wss.clients.forEach((client) => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

// Generate unique ID
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// REST API endpoints
app.get('/api/channels', (req, res) => {
    res.json({
        channels: Object.keys(channels)
    });
});

app.get('/api/channels/:channel/messages', (req, res) => {
    const { channel } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    
    if (channels[channel]) {
        const messages = channels[channel].slice(-limit);
        res.json({ messages });
    } else {
        res.status(404).json({ error: 'Channel not found' });
    }
});

app.post('/api/channels', (req, res) => {
    const { name } = req.body;
    
    if (!name || channels[name]) {
        return res.status(400).json({ error: 'Invalid or duplicate channel name' });
    }
    
    channels[name] = [];
    
    broadcast({
        type: 'channelCreated',
        channel: name
    });
    
    res.json({ success: true, channel: name });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        users: users.size,
        channels: Object.keys(channels).length
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket server is ready`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
    });
});
