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
    
    // Send immediate confirmation
    ws.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to server'
    }));
    
    ws.on('message', (data) => {
        try {
            console.log('Received message:', data.toString());
            const message = JSON.parse(data.toString());
            handleMessage(ws, message);
        } catch (error) {
            console.error('Error parsing message:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Error parsing message'
            }));
        }
    });

    ws.on('close', () => {
        const user = users.get(ws);
        if (user) {
            console.log(`User ${user.username} disconnected`);
            users.delete(ws);
            broadcastUserList();
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// Handle different message types
function handleMessage(ws, message) {
    console.log('Handling message type:', message.type);
    
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
    console.log(`User joining: ${username}`);
    
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

    console.log(`User ${username} joined. Total users: ${users.size}`);
}

// Handle chat messages
function handleChatMessage(ws, message) {
    const user = users.get(ws);
    if (!user) {
        console.log('Message from unknown user, ignoring');
        return;
    }

    const { channel, text } = message;
    console.log(`Message from ${user.username} in #${channel}: ${text}`);
    
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
        
        console.log(`Message stored. Channel ${channel} now has ${channels[channel].length} messages`);
    } else {
        console.log(`Channel ${channel} not found`);
    }

    // Broadcast to all connected clients
    const broadcastData = {
        type: 'message',
        message: chatMessage
    };
    
    console.log('Broadcasting message to all clients');
    broadcast(broadcastData);
}

// Get channel history
function handleGetHistory(ws, message) {
    const { channel } = message;
    console.log(`History requested for channel: ${channel}`);
    
    if (channels[channel]) {
        ws.send(JSON.stringify({
            type: 'history',
            channel,
            messages: channels[channel]
        }));
        console.log(`Sent ${channels[channel].length} messages for #${channel}`);
    } else {
        ws.send(JSON.stringify({
            type: 'history',
            channel,
            messages: []
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
    
    console.log('Broadcasting user list:', userList);
    
    broadcast({
        type: 'userList',
        users: userList
    });
}

// Broadcast to all clients (except sender if specified)
function broadcast(message, excludeWs = null) {
    const data = JSON.stringify(message);
    let sentCount = 0;
    
    wss.clients.forEach((client) => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(data);
            sentCount++;
        }
    });
    
    console.log(`Broadcast sent to ${sentCount} clients`);
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
    console.log(`=================================`);
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket server is ready`);
    console.log(`Open http://localhost:${PORT} in your browser`);
    console.log(`=================================`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
    });
});
