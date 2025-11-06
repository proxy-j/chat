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
// app.use(express.static('public')); // Your original code had this
// NEW: Serve the HTML file from the root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});


// In-memory storage
const channels = {
    general: [],
    random: [],
    gaming: []
};

const users = new Map(); // WebSocket -> user info { username, id, ip, isAdmin, muteExpires }

// NEW: Ban management
const bannedUsernames = new Set();
const bannedIPs = new Map(); // ip -> { expires: Date }

// NEW: Check for expired bans every minute
setInterval(() => {
    const now = new Date();
    bannedIPs.forEach((banInfo, ip) => {
        if (banInfo.expires < now) {
            bannedIPs.delete(ip);
            console.log(`Ban expired for IP: ${ip}`);
        }
    });
    
    // Check for expired mutes
    users.forEach((user) => {
        if (user.muteExpires && user.muteExpires < now) {
            user.muteExpires = null;
            console.log(`Mute expired for user: ${user.username}`);
            const ws = findSocketByUsername(user.username);
            if(ws) {
                ws.send(JSON.stringify({ type: 'info', message: 'Your mute has expired.' }));
            }
        }
    });
}, 60 * 1000); // Run every 60 seconds


// WebSocket connection handler
// NEW: Added 'req' to get the IP address
wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    
    // NEW: Check for IP ban
    const banInfo = bannedIPs.get(ip);
    if (banInfo) {
        if (banInfo.expires > new Date()) {
            console.log(`Blocked connection from banned IP: ${ip}`);
            ws.send(JSON.stringify({ 
                type: 'error', 
                message: 'You are banned from this server.',
                kick: true // NEW: Tell client to disconnect
            }));
            ws.terminate();
            return;
        } else {
            // Ban expired, remove it
            bannedIPs.delete(ip);
        }
    }
    
    console.log(`New client connected from IP: ${ip}`);
    
    // Send immediate confirmation
    ws.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to server'
    }));
    
    ws.on('message', (data) => {
        try {
            console.log('Received message:', data.toString());
            const message = JSON.parse(data.toString());
            // NEW: Pass IP to message handler
            handleMessage(ws, message, ip);
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
        } else {
            console.log('Client disconnected (was not fully joined)');
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// Handle different message types
// NEW: Added 'ip'
function handleMessage(ws, message, ip) {
    console.log('Handling message type:', message.type);
    
    // NEW: Check for admin credentials before allowing admin actions
    if (message.type.startsWith('admin_')) {
        const user = users.get(ws);
        if (!user || !user.isAdmin) {
            console.warn(`Non-admin user ${user?.username} tried to use admin command: ${message.type}`);
            ws.send(JSON.stringify({ type: 'error', message: 'You are not authorized for this action.' }));
            return;
        }
    }
    
    switch (message.type) {
        case 'join':
            // NEW: Pass IP to join handler
            handleJoin(ws, message, ip);
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
        // --- NEW ADMIN ACTIONS ---
        case 'admin_kick':
            handleAdminKick(ws, message);
            break;
        case 'admin_mute':
            handleAdminMute(ws, message);
            break;
        case 'admin_ban':
            handleAdminBan(ws, message);
            break;
        case 'admin_clear':
            handleAdminClear(ws, message);
            break;
        default:
            console.log('Unknown message type:', message.type);
    }
}

// User joins
// NEW: Added 'ip'
function handleJoin(ws, message, ip) {
    const { username, isAdmin } = message;
    console.log(`User joining: ${username} (Admin: ${isAdmin})`);
    
    // NEW: Check for username ban
    if (bannedUsernames.has(username)) {
        console.log(`Rejected banned username: ${username}`);
        ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'This username is banned.',
            kick: true 
        }));
        ws.terminate();
        return;
    }
    
    // NEW: Check for duplicate username
    if (findUserByUsername(username)) {
         ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'This username is already taken.',
            kick: true 
        }));
        ws.terminate();
        return;
    }

    // NEW: Store all user info
    users.set(ws, {
        username,
        id: generateId(),
        ip,
        isAdmin: isAdmin || false, // Default to false if not provided
        muteExpires: null
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
    
    // NEW: Check for mute
    if (user.muteExpires && user.muteExpires > new Date()) {
        const remaining = Math.round((user.muteExpires - new Date()) / 60000);
        const reason = `You are muted. Expires in ${remaining} minutes.`;
        console.log(`Blocked message from muted user: ${user.username}`);
        ws.send(JSON.stringify({
            type: 'error',
            message: reason
        }));
        return;
    }

    const { channel, text } = message;
    console.log(`Message from ${user.username} in #${channel}: ${text}`);
    
    const chatMessage = {
        id: generateId(),
        author: user.username,
        text,
        channel,
        timestamp: new Date().toISOString(),
        isAdmin: user.isAdmin // NEW: Include admin status in message
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

    // NEW: Don't let muted users send typing events
    if (user.muteExpires && user.muteExpires > new Date()) {
        return;
    }

    const { channel, isTyping } = message;
    
    broadcast({
        type: 'typing',
        username: user.username,
        channel,
        isTyping
    }, ws);
}

// --- NEW HELPER FUNCTIONS ---

// Find user object by username
function findUserByUsername(username) {
    for (const user of users.values()) {
        if (user.username === username) {
            return user;
        }
    }
    return null;
}

// Find WebSocket by username
function findSocketByUsername(username) {
     for (const [ws, user] of users.entries()) {
        if (user.username === username) {
            return ws;
        }
    }
    return null;
}

// Calculate expiration date
function calculateExpiry(durationMinutes) {
    if (durationMinutes === 0) {
        // Permanent ban/mute
        return new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000); // 100 years
    }
    return new Date(Date.now() + durationMinutes * 60 * 1000);
}


// --- NEW ADMIN HANDLERS ---

function handleAdminKick(ws, message) {
    const { targetUsername } = message;
    const targetSocket = findSocketByUsername(targetUsername);
    
    if (targetSocket) {
        console.log(`Admin ${users.get(ws).username} kicked ${targetUsername}`);
        targetSocket.send(JSON.stringify({ 
            type: 'error', 
            message: 'You have been kicked by an admin.', 
            kick: true 
        }));
        targetSocket.terminate();
        
        ws.send(JSON.stringify({ type: 'admin_confirm', message: `User ${targetUsername} has been kicked.` }));
        broadcastUserList(); // Update list since user is gone
    } else {
        ws.send(JSON.stringify({ type: 'error', message: `User ${targetUsername} not found.` }));
    }
}

function handleAdminMute(ws, message) {
    const { targetUsername, duration } = message;
    const targetUser = findUserByUsername(targetUsername);
    
    if (targetUser) {
        targetUser.muteExpires = calculateExpiry(duration);
        const reason = `You are muted for ${duration === 0 ? 'permanently' : `${duration} minutes`}.`;
        
        console.log(`Admin ${users.get(ws).username} muted ${targetUsername} for ${duration}m`);
        
        const targetSocket = findSocketByUsername(targetUsername);
        if (targetSocket) {
            targetSocket.send(JSON.stringify({ type: 'muted', reason }));
        }
        
        ws.send(JSON.stringify({ type: 'admin_confirm', message: `User ${targetUsername} has been muted.` }));
        broadcastUserList(); // Update list to show mute status
    } else {
        ws.send(JSON.stringify({ type: 'error', message: `User ${targetUsername} not found.` }));
    }
}

function handleAdminBan(ws, message) {
    const { targetUsername, duration, banType } = message;
    const targetUser = findUserByUsername(targetUsername);
    
    if (!targetUser) {
         ws.send(JSON.stringify({ type: 'error', message: `User ${targetUsername} not found.` }));
         return;
    }
    
    const expiryDate = calculateExpiry(duration);
    
    if (banType === 'username') {
        bannedUsernames.add(targetUsername); // Note: Username bans are permanent in this simple model
        console.log(`Admin ${users.get(ws).username} banned username ${targetUsername}`);
        ws.send(JSON.stringify({ type: 'admin_confirm', message: `Username ${targetUsername} has been permanently banned.` }));
    
    } else if (banType === 'ip') {
        bannedIPs.set(targetUser.ip, { expires: expiryDate });
        const banLength = duration === 0 ? 'permanently' : `for ${duration} minutes`;
        console.log(`Admin ${users.get(ws).username} banned IP ${targetUser.ip} ${banLength}`);
        ws.send(JSON.stringify({ type: 'admin_confirm', message: `IP ${targetUser.ip} for ${targetUsername} has been banned ${banLength}.` }));
    
    } else {
         ws.send(JSON.stringify({ type: 'error', message: `Invalid ban type.` }));
         return;
    }
    
    // Kick the user after banning
    const targetSocket = findSocketByUsername(targetUsername);
    if (targetSocket) {
        targetSocket.send(JSON.stringify({ 
            type: 'error', 
            message: 'You have been banned from the server.', 
            kick: true 
        }));
        targetSocket.terminate();
    }
}

function handleAdminClear(ws, message) {
    const { channel } = message;
    if (channels[channel]) {
        channels[channel] = [];
        console.log(`Admin ${users.get(ws).username} cleared channel #${channel}`);
        
        // Broadcast an empty history to clear everyone's screen
        broadcast({
            type: 'history',
            channel,
            messages: []
        });
        
        ws.send(JSON.stringify({ type: 'admin_confirm', message: `Channel #${channel} has been cleared.` }));
    } else {
         ws.send(JSON.stringify({ type: 'error', message: `Channel ${channel} not found.` }));
    }
}


// Broadcast user list
function broadcastUserList() {
    // NEW: Send a richer user object
    const userList = Array.from(users.values()).map(u => ({
        username: u.username,
        isAdmin: u.isAdmin,
        isMuted: u.muteExpires && u.muteExpires > new Date()
    }));
    
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
    
    // console.log(`Broadcast sent to ${sentCount} clients`); // This is too noisy
}

// Generate unique ID
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// --- REST API (unchanged, but kept) ---
app.get('/api/channels', (req, res) => {
    res.json({
        channels: Object.keys(channels)
    });
});
// ... (other API routes) ...

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        users: users.size,
        channels: Object.keys(channels).length,
        bannedIPs: bannedIPs.size,
        bannedUsernames: bannedUsernames.size
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
