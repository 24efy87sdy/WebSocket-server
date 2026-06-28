const WebSocket = require('ws');
const os = require('os');
const config = require('./config.js');

// 启用 WebSocket 压缩
const wss = new WebSocket.Server({
    port: config.port,
    perMessageDeflate: {
        zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 },
        zlibInflateOptions: { chunkSize: 10 * 1024 },
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
        serverMaxWindowBits: 10,
        concurrencyLimit: 10,
        threshold: 1024,
    },
});

// 房间存储：Map<房间名, { clients: Set<WebSocket>, joinCounter: number, maxPlayers: number }>
const rooms = new Map();

// IP 连接计数
const ipConnections = new Map();

// ---------- 工具函数 ----------
function generatePlayerId() {
    return `p_${Date.now().toString(36)}_${Math.floor(Math.random() * 1000).toString(36)}`;
}

function log(...args) {
    if (config.enableLog) console.log(...args);
}

function normalizeIP(ip) {
    if (ip === '::1') return '127.0.0.1';          // IPv6 回环地址统一为 IPv4
    if (ip.startsWith('::ffff:')) return ip.substring(7); // IPv4 映射地址
    return ip;
}

function getLocalIPs() {
    const interfaces = os.networkInterfaces();
    const ipList = [];
    const virtualKeywords = ['VMware', 'VirtualBox', 'WSL', 'Docker', 'vEthernet', 'Loopback', '虚拟', 'VPN', 'TAP', 'Tun', 'Hyper-V'];
    for (const name of Object.keys(interfaces)) {
        const isVirtual = virtualKeywords.some(k => name.toLowerCase().includes(k.toLowerCase()));
        if (isVirtual) continue;
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) ipList.push(iface.address);
        }
    }
    return ipList;
}

function getRecommendRoom() {
    for (const [name, room] of rooms) {
        if (room.clients.size < room.maxPlayers) return name;
    }
    return null;
}

// ---------- 预序列化消息函数 ----------
const leaveMsgBase = (leaveId, leaveIndex, roomName, remainCount) =>
    JSON.stringify({ 类型: "玩家离开", 离开玩家ID: leaveId, 离开玩家序号: leaveIndex, 房间名称: roomName, 当前人数: remainCount, 时间戳: Date.now() });

const indexUpdateMsgBase = (roomName, newIndex, total) =>
    JSON.stringify({ 类型: "序号更新", 房间名称: roomName, 新玩家序号: newIndex, 当前人数: total, 时间戳: Date.now() });

function handlePlayerLeaveRoom(ws, roomName) {
    const room = rooms.get(roomName);
    if (!room) return;
    const leaveIndex = ws.roomIndex;
    const leaveId = ws.playerId;
    const clientsSnapshot = [...room.clients];
    const remainCount = clientsSnapshot.length - 1;

    if (config.roomLeave.enableNotify) {
        const leaveMsg = leaveMsgBase(leaveId, leaveIndex, roomName, remainCount);
        clientsSnapshot.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) client.send(leaveMsg);
        });
    }
    if (config.roomLeave.enableReindex && config.roomJoin.indexType === "current") {
        const remainClients = clientsSnapshot.filter(c => c !== ws);
        remainClients.forEach((client, idx) => {
            const newIndex = idx + 1;
            client.roomIndex = newIndex;
            const updateMsg = indexUpdateMsgBase(roomName, newIndex, remainClients.length);
            if (client.readyState === WebSocket.OPEN) client.send(updateMsg);
        });
    }
}

function checkRateLimit(ws) {
    if (!config.rateLimit || !config.rateLimit.enable) return true;
    const now = Date.now();
    const max = config.rateLimit.maxMessagesPerSecond || 10;
    if (!ws._msgTimestamps) ws._msgTimestamps = [];
    ws._msgTimestamps = ws._msgTimestamps.filter(t => now - t < 1000);
    if (ws._msgTimestamps.length >= max) {
        ws.close(1008, '消息发送过快');
        return false;
    }
    ws._msgTimestamps.push(now);
    return true;
}

// ---------- 启动日志 ----------
log('========================================');
log('TurboWarp WebSocket 联机服务器已启动 (增强版)');
log(`本地地址: ws://localhost:${config.port}`);
log('局域网访问地址：');
const localIPs = getLocalIPs();
if (localIPs.length === 0) {
    log('  未检测到局域网IP，请检查网络连接');
} else {
    localIPs.forEach(ip => log(`  ws://${ip}:${config.port}`));
}
log(`全局最大连接数: ${config.maxClients} 人`);
log(`默认单房间最大人数: ${config.room.maxPlayers} 人`);
log(`单IP最大连接数: ${config.maxConnectionsPerIP || '无限制'} 个`);
log(`房间功能: ${config.enableRooms ? '已开启' : '已关闭'}`);
log(`消息压缩: 已开启`);
log(`速率限制: ${config.rateLimit && config.rateLimit.enable ? `开启 (${config.rateLimit.maxMessagesPerSecond || 10}条/秒)` : '关闭'}`);
log(`消息回显: ${config.broadcast.echoBack ? '已开启' : '已关闭'}`);
log(`握手消息: ${config.handshake.enable ? '已开启' : '已关闭'}`);
log(`加入房间回执: ${config.roomJoin.enableReply ? '已开启' : '已关闭'}`);
log(`离开房间通知: ${config.roomLeave.enableNotify ? '已开启' : '已关闭'}`);
log(`离开自动重排号: ${config.roomLeave.enableReindex ? '已开启' : '已关闭'}`);
log(`加入房间广播: ${config.roomJoin.broadcastJoin ? '已开启' : '已关闭'}`);
log(`Ping 延迟测量: 已开启`);
if (config.heartbeat && config.heartbeat.enable) {
    log(`心跳检测: 开启 (间隔 ${config.heartbeat.interval || 30000}ms)`);
} else {
    log('心跳检测: 关闭');
}
if (config.maxMessageSize) {
    log(`消息长度限制: ${config.maxMessageSize} 字节`);
} else {
    log('消息长度限制: 未限制');
}
log('========================================');

// ---------- 心跳保活 ----------
if (config.heartbeat && config.heartbeat.enable) {
    setInterval(() => {
        wss.clients.forEach(ws => {
            if (ws.isAlive === false) { ws.terminate(); return; }
            ws.isAlive = false;
            ws.ping();
        });
    }, config.heartbeat.interval || 30000);
}

// ---------- 新连接处理 ----------
wss.on('connection', (ws, req) => {
    const ip = normalizeIP(req.socket.remoteAddress);  // 归一化 IP
    const maxPerIP = config.maxConnectionsPerIP || Infinity;
    const currentCount = ipConnections.get(ip) || 0;
    if (currentCount >= maxPerIP) {
        ws.send(JSON.stringify({ 类型: "错误", 原因: "同一IP连接数已达上限", 时间戳: Date.now() }));
        ws.close(1013, 'IP连接数过多');
        return;
    }
    ipConnections.set(ip, currentCount + 1);

    if (wss.clients.size > config.maxClients) {
        ws.send(JSON.stringify({ 类型: "错误", 原因: "服务器人数已满", 时间戳: Date.now() }));
        ws.close(1013, '服务器人数已满');
        ipConnections.set(ip, Math.max(0, ipConnections.get(ip) - 1));
        log('新客户端被拒绝：全局人数已达上限');
        return;
    }

    ws.playerId = config.handshake.autoAssignPlayerId ? generatePlayerId() : null;
    ws.currentRoom = null;
    ws.roomIndex = null;
    ws.nickname = '';
    ws.isAlive = true;
    ws._msgTimestamps = [];

    log(`新客户端接入 [${ws.playerId}]，IP: ${ip}，当前总在线：${wss.clients.size}`);

    ws.on('pong', () => { ws.isAlive = true; });

    // 握手消息
    if (config.handshake.enable) {
        const totalRooms = config.enableRooms ? rooms.size : 0;
        const recommendRoom = config.enableRooms ? getRecommendRoom() : null;
        ws.send(JSON.stringify({
            类型: '握手', 玩家ID: ws.playerId, 欢迎文本: config.handshake.welcomeText,
            服务器版本: config.handshake.serverVersion, 房间总数: totalRooms, 推荐房间: recommendRoom, 时间戳: Date.now(),
        }));
    }

    ws.on('message', (data) => {
        const msg = data.toString();

        // 消息长度检查（准确的字节长度）
        if (config.maxMessageSize && Buffer.byteLength(msg, 'utf8') > config.maxMessageSize) {
            ws.send(JSON.stringify({ 类型: "错误", 原因: "消息过长", 时间戳: Date.now() }));
            return;
        }
        if (!checkRateLimit(ws)) return;

        // ======== Ping 延迟测量 ========
        if (msg.startsWith('ping|')) {
            ws.send(`pong|${msg.substring(5)}`);
            return;
        }

        // ---------- 昵称设置 ----------
        if (msg.startsWith('nick|')) {
            const nick = msg.substring(5).trim();
            if (nick.length < 1 || nick.length > 20) {
                ws.send(JSON.stringify({ 类型: "错误", 操作: "设置昵称", 原因: "昵称长度须为1-20个字符", 时间戳: Date.now() }));
                return;
            }
            ws.nickname = nick;
            ws.send(JSON.stringify({ 类型: "昵称已设置", 昵称: nick, 时间戳: Date.now() }));
            return;
        }

        // ---------- 获取当前房间玩家列表 ----------
        if (msg === 'players') {
            if (!ws.currentRoom || !rooms.has(ws.currentRoom)) {
                ws.send(JSON.stringify({ 类型: "错误", 操作: "玩家列表", 原因: "尚未加入房间", 时间戳: Date.now() }));
                return;
            }
            const room = rooms.get(ws.currentRoom);
            const playerList = [];
            room.clients.forEach(client => {
                playerList.push({
                    玩家ID: client.playerId,
                    玩家序号: client.roomIndex,
                    昵称: client.nickname || ''
                });
            });
            ws.send(JSON.stringify({ 类型: "房间玩家列表", 房间名称: ws.currentRoom, 玩家数量: playerList.length, 玩家列表: playerList, 时间戳: Date.now() }));
            return;
        }

        // ---------- 服务器时间 ----------
        if (msg === 'time') {
            ws.send(JSON.stringify({ 类型: "服务器时间", 时间戳: Date.now() }));
            return;
        }

        // 如果未开启房间功能，则拒绝房间相关指令
        if (!config.enableRooms && (msg === 'leave' || msg.startsWith('join|') || msg === 'players' || msg.startsWith('sm|'))) {
            ws.send(JSON.stringify({ 类型: "错误", 原因: "房间功能未开启", 时间戳: Date.now() }));
            return;
        }

        // list 指令
        if (config.enableRooms && msg === 'list') {
            const roomList = [];
            for (const [name, room] of rooms) {
                roomList.push({
                    房间名称: name,
                    当前人数: room.clients.size,
                    最大人数: room.maxPlayers,
                    已满: room.clients.size >= room.maxPlayers,
                });
            }
            ws.send(JSON.stringify({ 类型: "房间列表", 房间数量: roomList.length, 房间列表: roomList, 时间戳: Date.now() }));
            return;
        }

        // status 指令
        if (msg === 'status') {
            const onlineCount = wss.clients.size;
            const roomNames = config.enableRooms ? [...rooms.keys()] : [];
            ws.send(JSON.stringify({ 类型: "服务器状态", 全局在线人数: onlineCount, 房间总数: roomNames.length, 房间名列表: roomNames, 时间戳: Date.now() }));
            return;
        }

        // leave 指令
        if (config.enableRooms && msg === 'leave') {
            if (!ws.currentRoom || !rooms.has(ws.currentRoom)) return;
            const oldRoom = ws.currentRoom;
            handlePlayerLeaveRoom(ws, oldRoom);
            const room = rooms.get(oldRoom);
            room.clients.delete(ws);
            const remainCount = room.clients.size;
            if (remainCount === 0) rooms.delete(oldRoom);
            ws.send(JSON.stringify({ 类型: "退出房间", 房间名称: oldRoom, 当前人数: remainCount, 时间戳: Date.now() }));
            ws.currentRoom = null; ws.roomIndex = null;
            log(`玩家 [${ws.playerId}] 主动退出房间 [${oldRoom}]，剩余人数：${remainCount}`);
            return;
        }

        // join 指令
        if (config.enableRooms && msg.startsWith('join|')) {
            const raw = msg.substring(5);
            const parts = raw.split('|');
            const roomName = (parts[0] || '').trim();
            const maxPlayersRaw = parts[1] ? parseInt(parts[1]) : NaN;
            const maxPlayers = (!isNaN(maxPlayersRaw) && maxPlayersRaw > 0) ? maxPlayersRaw : config.room.maxPlayers;

            if (!roomName || roomName.length === 0 || roomName.length > 20) {
                ws.send(JSON.stringify({ 类型: "错误", 操作: "加入房间", 原因: "房间名长度须为1-20个字符", 时间戳: Date.now() }));
                return;
            }
            if (/[|*\\\/<>:"?]/.test(roomName)) {
                ws.send(JSON.stringify({ 类型: "错误", 操作: "加入房间", 原因: "房间名包含非法字符", 时间戳: Date.now() }));
                return;
            }

            // 退出旧房间
            if (ws.currentRoom && rooms.has(ws.currentRoom)) {
                handlePlayerLeaveRoom(ws, ws.currentRoom);
                const oldRoom = rooms.get(ws.currentRoom);
                oldRoom.clients.delete(ws);
                if (oldRoom.clients.size === 0) rooms.delete(ws.currentRoom);
            }

            // 创建或获取房间
            if (!rooms.has(roomName)) {
                rooms.set(roomName, { clients: new Set(), joinCounter: 0, maxPlayers: maxPlayers });
            }
            const room = rooms.get(roomName);
            if (room.clients.size >= room.maxPlayers) {
                ws.send(JSON.stringify({ 类型: "错误", 操作: "加入房间", 原因: "房间已满", 房间名称: roomName, 当前人数: room.clients.size, 最大人数: room.maxPlayers, 时间戳: Date.now() }));
                return;
            }

            room.joinCounter++;
            room.clients.add(ws);
            ws.currentRoom = roomName;
            const playerIndex = config.roomJoin.indexType === 'current' ? room.clients.size : room.joinCounter;
            ws.roomIndex = playerIndex;

            if (config.roomJoin.enableReply) {
                ws.send(JSON.stringify({ 类型: "加入房间", 房间名称: roomName, 玩家序号: playerIndex, 当前人数: room.clients.size, 最大人数: room.maxPlayers, 玩家ID: ws.playerId, 时间戳: Date.now() }));
            }

            // 向房间其他人广播玩家加入
            if (config.roomJoin.broadcastJoin !== false) {
                const joinMsg = JSON.stringify({
                    类型: "玩家加入",
                    房间名称: roomName,
                    玩家ID: ws.playerId,
                    玩家序号: playerIndex,
                    昵称: ws.nickname || '',
                    当前人数: room.clients.size,
                    时间戳: Date.now()
                });
                room.clients.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) client.send(joinMsg);
                });
            }

            log(`玩家 [${ws.playerId}] 加入房间 [${roomName}]，第${playerIndex}位，当前/最大：${room.clients.size}/${room.maxPlayers}`);
            return;
        }

        // 结构化消息 sm|内容
        if (config.enableRooms && msg.startsWith('sm|')) {
            if (!ws.currentRoom || !rooms.has(ws.currentRoom)) {
                ws.send(JSON.stringify({ 类型: "错误", 操作: "结构化消息", 原因: "尚未加入房间", 时间戳: Date.now() }));
                return;
            }
            const content = msg.substring(3);
            const room = rooms.get(ws.currentRoom);
            const packet = JSON.stringify({
                类型: "结构化消息",
                发送者ID: ws.playerId,
                发送者序号: ws.roomIndex,
                昵称: ws.nickname || '',
                内容: content,
                时间戳: Date.now()
            });
            room.clients.forEach(client => {
                const skip = !config.broadcast.echoBack && client === ws;
                if (!skip && client.readyState === WebSocket.OPEN) client.send(packet);
            });
            return;
        }

        // ---------- 普通消息广播 ----------
        if (config.enableRooms) {
            if (msg.startsWith('!!')) {
                // 全局广播
                wss.clients.forEach(client => {
                    const skip = !config.broadcast.echoBack && client === ws;
                    if (!skip && client.readyState === WebSocket.OPEN) client.send(msg);
                });
            } else {
                // 房间内广播（未在房间则给出提示）
                if (ws.currentRoom && rooms.has(ws.currentRoom)) {
                    const room = rooms.get(ws.currentRoom);
                    room.clients.forEach(client => {
                        const skip = !config.broadcast.echoBack && client === ws;
                        if (!skip && client.readyState === WebSocket.OPEN) client.send(msg);
                    });
                } else {
                    ws.send(JSON.stringify({ 类型: "错误", 原因: "未加入任何房间，消息未发送", 时间戳: Date.now() }));
                }
            }
        } else {
            wss.clients.forEach(client => {
                const skip = !config.broadcast.echoBack && client === ws;
                if (!skip && client.readyState === WebSocket.OPEN) client.send(msg);
            });
        }
    });

    ws.on('close', () => {
        const count = ipConnections.get(ip) || 0;
        if (count <= 1) ipConnections.delete(ip);
        else ipConnections.set(ip, count - 1);

        if (config.enableRooms && ws.currentRoom && rooms.has(ws.currentRoom)) {
            handlePlayerLeaveRoom(ws, ws.currentRoom);
            const room = rooms.get(ws.currentRoom);
            room.clients.delete(ws);
            const remain = room.clients.size;
            if (remain === 0) rooms.delete(ws.currentRoom);
            log(`玩家 [${ws.playerId}] 离开房间 [${ws.currentRoom}]，剩余人数：${remain}`);
        }
        log(`玩家 [${ws.playerId}] 断开连接，IP: ${ip}，当前总在线：${wss.clients.size}`);
    });

    ws.on('error', (err) => log(`连接错误 [${ws.playerId}]：`, err.message));
});