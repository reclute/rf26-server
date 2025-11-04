const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

// Express app oluştur
const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Static dosyaları servis et (mevcut klasörden)
app.use(express.static(__dirname));

// Oyuncu odaları için veri yapısı
let rooms = {};
let playerCount = 0;

// Online leaderboard - oyuncu istatistikleri
let onlineLeaderboard = {}; // { playerName: { wins: 0, losses: 0, goals: 0, goalsAgainst: 0 } }

// Socket.IO bağlantısı
io.on('connection', (socket) => {
    const playerId = ++playerCount;
    console.log(`Player ${playerId} connected (${socket.id})`);

    socket.playerId = playerId;
    socket.playerName = null;

    // Oda oluştur
    socket.on('create_room', (data) => {
        const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const roomData = {
            id: roomId,
            name: data.roomName || `${data.playerName}'s Room`,
            host: {
                id: socket.id,
                playerId: playerId,
                name: data.playerName || `Player ${playerId}`
            },
            players: [{
                id: socket.id,
                playerId: playerId,
                name: data.playerName || `Player ${playerId}`,
                ready: false
            }],
            maxPlayers: data.maxPlayers || 2,
            gameMode: data.gameMode || '1v1',
            stadium: data.stadium || 'rf-stadium',
            weather: data.weather || 'normal',
            matchDuration: data.matchDuration || 120, // Saniye cinsinden
            isPrivate: data.isPrivate || false,
            password: data.password || null,
            status: 'waiting', // waiting, playing, finished
            createdAt: Date.now()
        };

        rooms[roomId] = roomData;
        socket.join(roomId);
        socket.currentRoom = roomId;
        socket.playerName = data.playerName;

        socket.emit('room_created', { roomId, room: roomData });
        broadcastRoomList();

        console.log(`Room created: ${roomId} by ${data.playerName}`);
    });

    // Oda listesini al
    socket.on('get_rooms', () => {
        const publicRooms = Object.values(rooms).filter(r => !r.isPrivate && r.status === 'waiting');
        socket.emit('rooms_list', publicRooms);
    });

    // Odaya katıl
    socket.on('join_room', (data) => {
        const room = rooms[data.roomId];
        
        if (!room) {
            socket.emit('join_error', { message: 'Oda bulunamadı' });
            return;
        }

        if (room.status !== 'waiting') {
            socket.emit('join_error', { message: 'Oyun zaten başlamış' });
            return;
        }

        if (room.players.length >= room.maxPlayers) {
            socket.emit('join_error', { message: 'Oda dolu' });
            return;
        }

        if (room.password && room.password !== data.password) {
            socket.emit('join_error', { message: 'Yanlış şifre' });
            return;
        }

        const player = {
            id: socket.id,
            playerId: playerId,
            name: data.playerName || `Player ${playerId}`,
            ready: false
        };

        room.players.push(player);
        socket.join(data.roomId);
        socket.currentRoom = data.roomId;
        socket.playerName = data.playerName;

        // Odadaki herkese bildir
        io.to(data.roomId).emit('player_joined', { player, room });
        socket.emit('room_joined', { room });
        broadcastRoomList();

        console.log(`${data.playerName} joined room ${data.roomId}`);
    });

    // Hazır durumu değiştir
    socket.on('toggle_ready', () => {
        if (!socket.currentRoom) return;
        
        const room = rooms[socket.currentRoom];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.ready = !player.ready;
            io.to(socket.currentRoom).emit('player_ready_changed', { playerId: player.playerId, ready: player.ready, room });

            // Tüm oyuncular hazırsa oyunu başlat
            if (room.players.length >= 2 && room.players.every(p => p.ready)) {
                startGame(room);
            }
        }
    });

    // Oyun güncellemesi - pozisyon ve top bilgisi
    socket.on('game_update', (data) => {
        if (!socket.currentRoom) return;
        // Performans için log yok (çok sık çağrılıyor)
        socket.to(socket.currentRoom).emit('game_update', {
            playerId: socket.playerId,
            ...data
        });
    });

    // Top dokunma - hem host hem guest için
    socket.on('ball_touch', (data) => {
        if (!socket.currentRoom) return;
        const room = rooms[socket.currentRoom];
        if (!room) return;
        
        const isHost = room.host && room.host.id === socket.id;
        const playerType = isHost ? 'HOST' : 'GUEST';
        
        console.log(`⚽ ${playerType} topa dokundu:`, {
            ball: `(${data.ballX}, ${data.ballY})`,
            velocity: `(${data.ballVx}, ${data.ballVy})`,
            isHost: data.isHost
        });
        
        // Diğer oyuncuya gönder (broadcast)
        socket.to(socket.currentRoom).emit('ball_touch', {
            playerId: socket.playerId,
            ballX: data.ballX,
            ballY: data.ballY,
            ballVx: data.ballVx,
            ballVy: data.ballVy,
            timestamp: data.timestamp,
            isHost: data.isHost
        });
    });

    // Ball sync - sürekli pozisyon güncellemesi
    socket.on('ball_sync', (data) => {
        if (!socket.currentRoom) return;
        // Diğer oyuncuya gönder (yüksek frekanslı, log yok)
        socket.to(socket.currentRoom).emit('ball_sync', {
            ballX: data.ballX,
            ballY: data.ballY,
            ballVx: data.ballVx,
            ballVy: data.ballVy,
            isHost: data.isHost
        });
    });
    
    // Time sync - HOST gameTime broadcast eder
    socket.on('time_sync', (data) => {
        if (!socket.currentRoom) return;
        // HOST'tan GUEST'e gameTime sync
        socket.to(socket.currentRoom).emit('time_sync', {
            gameTime: data.gameTime,
            playerScore: data.playerScore,
            aiScore: data.aiScore
        });
    });

    // Gol güncelleme - skor her iki oyuncuya da gönderilir
    socket.on('goal_update', (data) => {
        if (!socket.currentRoom) return;
        const room = rooms[socket.currentRoom];
        if (!room) return;

        console.log(`⚽ GOL! Room: ${socket.currentRoom}, Skor: ${data.playerScore}-${data.aiScore}, Scorer: ${data.scorer}`);
        
        // Odadaki HERKESE (gönderende dahil) skor güncellemesini yayınla
        io.to(socket.currentRoom).emit('goal_update', {
            playerScore: data.playerScore,
            aiScore: data.aiScore,
            scorer: data.scorer,
            timestamp: Date.now()
        });
    });

    // Replay başlat - host replay başlattığında diğer oyunculara bildir
    socket.on('start_replay', (data) => {
        if (!socket.currentRoom) {
            console.log('❌ REPLAY EVENT: No room!');
            return;
        }
        
        const room = rooms[socket.currentRoom];
        if (!room) {
            console.log('❌ REPLAY EVENT: Room not found!');
            return;
        }
        
        console.log(`🎬 REPLAY EVENT RECEIVED from ${socket.playerName} in room ${socket.currentRoom}`);
        console.log(`   Scorer: ${data.scorer}`);
        console.log(`   Players in room: ${room.players.map(p => p.name).join(', ')}`);
        
        // SADECE DİĞER OYUNCULARA replay başladığını bildir (host kendi replay'ini başlatıyor)
        socket.to(socket.currentRoom).emit('replay_started', {
            scorer: data.scorer
        });
        
        console.log(`   ✅ Replay event sent to other players in room ${socket.currentRoom}`);
    });

    // Half-time - host half-time'a girdiğinde diğer oyunculara bildir
    socket.on('half_time', (data) => {
        if (!socket.currentRoom) return;
        const room = rooms[socket.currentRoom];
        if (!room) return;
        
        console.log(`⏸️ HALF-TIME in room ${socket.currentRoom}, scores: ${data.playerScore}-${data.aiScore}`);
        
        // Reset half-time ready status
        room.halfTimeReady = new Set();
        
        // Diğer oyunculara half-time'ı bildir
        socket.to(socket.currentRoom).emit('half_time_started', {
            playerScore: data.playerScore,
            aiScore: data.aiScore
        });
    });
    
    // Half-time ready
    socket.on('half_time_ready', () => {
        if (!socket.currentRoom) return;
        const room = rooms[socket.currentRoom];
        if (!room) return;
        
        // Initialize if not exists
        if (!room.halfTimeReady) {
            room.halfTimeReady = new Set();
        }
        
        // Add player to ready set
        room.halfTimeReady.add(socket.id);
        
        const readyCount = room.halfTimeReady.size;
        const totalPlayers = room.players.length;
        
        console.log(`⏸️ Half-time ready: ${readyCount}/${totalPlayers} in room ${socket.currentRoom}`);
        
        // Broadcast ready status
        io.to(socket.currentRoom).emit('half_time_ready_update', {
            readyCount: readyCount,
            totalPlayers: totalPlayers
        });
        
        // If all players ready, resume game
        if (readyCount >= totalPlayers) {
            console.log(`⚽ All players ready, resuming game in room ${socket.currentRoom}`);
            io.to(socket.currentRoom).emit('half_time_resume');
            room.halfTimeReady.clear();
        }
    });

    // Emoji gönderme
    socket.on('send_emoji', (data) => {
        if (!socket.currentRoom) return;
        console.log(`😎 Player ${socket.playerId} (${socket.playerName}) sent emoji: ${data.emoji}`);
        socket.to(socket.currentRoom).emit('emoji_received', {
            playerId: socket.playerId,
            playerName: socket.playerName,
            emoji: data.emoji
        });
    });

    // Oyun bitişi - skor güncelleme
    socket.on('game_end', (data) => {
        if (!socket.currentRoom) return;
        const room = rooms[socket.currentRoom];
        if (!room) return;

        // Room status'ünü 'waiting'e çevir
        room.status = 'waiting';
        
        // Tüm oyuncuları 'not ready' yap
        room.players.forEach(p => p.ready = false);
        
        // Odadaki herkese güncel room'u gönder
        io.to(socket.currentRoom).emit('room_updated', { room });
        
        broadcastRoomList();

        // Her oyuncunun skorunu güncelle
        data.players.forEach(player => {
            if (!onlineLeaderboard[player.name]) {
                onlineLeaderboard[player.name] = {
                    name: player.name,
                    wins: 0,
                    losses: 0,
                    goals: 0,
                    goalsAgainst: 0,
                    gamesPlayed: 0
                };
            }

            const stats = onlineLeaderboard[player.name];
            stats.gamesPlayed++;
            stats.goals += player.score || 0;
            stats.goalsAgainst += player.opponentScore || 0;

            if (player.won) {
                stats.wins++;
            } else {
                stats.losses++;
            }
        });

        console.log(`Game ended in room ${socket.currentRoom}`, data);
    });

    // Offline maç sonucu - AI'ya karşı oynanan maçlar
    socket.on('offline_match_result', (data) => {
        const playerName = data.playerName;
        if (!playerName) return;
        
        if (!onlineLeaderboard[playerName]) {
            onlineLeaderboard[playerName] = {
                name: playerName,
                wins: 0,
                losses: 0,
                goals: 0,
                goalsAgainst: 0,
                gamesPlayed: 0
            };
        }

        const stats = onlineLeaderboard[playerName];
        stats.gamesPlayed++;
        stats.goals += data.playerScore || 0;
        stats.goalsAgainst += data.aiScore || 0;

        if (data.won) {
            stats.wins++;
        } else if (data.lost) {
            stats.losses++;
        }

        console.log(`📊 Offline match result: ${playerName} - ${data.playerScore}:${data.aiScore} (${data.won ? 'WIN' : data.lost ? 'LOSS' : 'DRAW'})`);
    });

    // Leaderboard al
    socket.on('get_leaderboard', () => {
        const leaderboardArray = Object.values(onlineLeaderboard)
            .sort((a, b) => {
                // Önce kazanma sayısına göre sırala
                if (b.wins !== a.wins) return b.wins - a.wins;
                // Eşitse gol farkına göre
                const aGoalDiff = a.goals - a.goalsAgainst;
                const bGoalDiff = b.goals - b.goalsAgainst;
                if (bGoalDiff !== aGoalDiff) return bGoalDiff - aGoalDiff;
                // Eşitse atılan gol sayısına göre
                return b.goals - a.goals;
            })
            .slice(0, 10); // İlk 10 oyuncu

        socket.emit('leaderboard_data', leaderboardArray);
    });

    // Odadan ayrıl
    socket.on('leave_room', () => {
        leaveRoom(socket);
    });

    // Bağlantı kesildiğinde
    socket.on('disconnect', () => {
        console.log(`Player ${playerId} disconnected`);
        leaveRoom(socket);
    });
});

// Oyunu başlat
function startGame(room) {
    room.status = 'playing';
    room.gameStartTime = Date.now();
    
    io.to(room.id).emit('game_start', {
        room,
        players: room.players
    });
    
    broadcastRoomList();
    console.log(`Game started in room ${room.id}`);
}

// Odadan ayrıl
function leaveRoom(socket) {
    if (!socket.currentRoom) return;
    
    const room = rooms[socket.currentRoom];
    if (!room) return;

    const wasHost = room.host.id === socket.id;
    const wasPlaying = room.status === 'playing';
    const roomId = socket.currentRoom;

    // Önce mesajları gönder, sonra oyuncuyu çıkar
    if (wasHost) {
        // Host ayrılıyor - tüm oyunculara bildir
        if (wasPlaying) {
            console.log(`Host left during game in room ${roomId}, closing room`);
            io.to(roomId).emit('host_left_game', {
                message: 'Oda sahibi oyundan ayrıldı'
            });
        } else {
            console.log(`Host left lobby in room ${roomId}, closing room`);
            io.to(roomId).emit('host_left_lobby', {
                message: 'Oda sahibi odadan ayrıldı'
            });
        }
        // Host ayrılırsa odayı sil
        delete rooms[roomId];
    } else {
        // Normal oyuncu ayrılıyor
        // Sonra oyuncuyu çıkar
        room.players = room.players.filter(p => p.id !== socket.id);
        
        // Oda boşaldıysa sil
        if (room.players.length === 0) {
            delete rooms[roomId];
            console.log(`Room ${roomId} deleted (empty)`);
        } else {
            // Hala oyuncu varsa mesajı gönder
            io.to(roomId).emit('player_left', {
                playerId: socket.playerId,
                playerName: socket.playerName,
                wasPlaying: wasPlaying,
                room: room
            });
        }
    }
    
    socket.leave(roomId);
    socket.currentRoom = null;
    broadcastRoomList();
}

// Oda listesini yayınla
function broadcastRoomList() {
    const publicRooms = Object.values(rooms).filter(r => !r.isPrivate && r.status === 'waiting');
    io.emit('rooms_list', publicRooms);
}

// Eski/inactive odaları temizle
function cleanupOldRooms() {
    const now = Date.now();
    const WAITING_TIMEOUT = 5 * 60 * 1000; // 5 dakika
    const PLAYING_TIMEOUT = 30 * 60 * 1000; // 30 dakika
    
    Object.keys(rooms).forEach(roomId => {
        const room = rooms[roomId];
        const age = now - room.createdAt;
        
        // Waiting status'ta 5 dakikadan eski odalar
        if (room.status === 'waiting' && age > WAITING_TIMEOUT) {
            console.log(`🧹 Cleaning up old waiting room: ${roomId} (${Math.round(age/1000/60)} mins old)`);
            // Odadaki herkese bildir
            io.to(roomId).emit('room_closed', { message: 'Room closed due to inactivity' });
            delete rooms[roomId];
            return;
        }
        
        // Playing status'ta 30 dakikadan eski odalar
        if (room.status === 'playing' && age > PLAYING_TIMEOUT) {
            console.log(`🧹 Cleaning up old playing room: ${roomId} (${Math.round(age/1000/60)} mins old)`);
            io.to(roomId).emit('room_closed', { message: 'Room closed due to timeout' });
            delete rooms[roomId];
            return;
        }
    });
    
    broadcastRoomList();
}

// Her 2 dakikada bir eski odaları temizle
setInterval(cleanupOldRooms, 2 * 60 * 1000);

// Sunucuyu başlat
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎮 DBS 26 (Dimension Ball Soccer) Online Server running on port ${PORT}`);
    console.log(`🌐 Socket.IO server ready`);
    console.log(`📂 Serving files from directory (DBS 26/)`);
    console.log(`🔗 Open: http://localhost:${PORT}`);
});

// Temizlik için
process.on('SIGINT', () => {
    console.log('\n Shutting down server...');
    io.close();
    server.close();
    process.exit(0);
});