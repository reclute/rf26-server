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

    // Oyun güncellemesi
    socket.on('game_update', (data) => {
        if (!socket.currentRoom) return;
        socket.to(socket.currentRoom).emit('game_update', {
            playerId: socket.playerId,
            ...data
        });
    });

    // Gol güncelleme - skor her iki oyuncuya da gönderilir
    socket.on('goal_update', (data) => {
        if (!socket.currentRoom) return;
        const room = rooms[socket.currentRoom];
        if (!room) return;

        console.log(`⚽ GOL! Room: ${socket.currentRoom}, Skor: ${data.playerScore}-${data.aiScore}`);
        
        // Odadaki HERKESE (gönderende dahil) skor güncellemesini yayınla
        io.to(socket.currentRoom).emit('goal_update', {
            playerScore: data.playerScore,
            aiScore: data.aiScore,
            scorer: data.scorer
        });
    });

    // Emoji gönderme
    socket.on('send_emoji', (data) => {
        if (!socket.currentRoom) return;
        socket.to(socket.currentRoom).emit('emoji_received', {
            playerId: socket.playerId,
            emoji: data.emoji
        });
        console.log(`Player ${socket.playerId} sent emoji: ${data.emoji}`);
    });

    // Oyun bitişi - skor güncelleme
    socket.on('game_end', (data) => {
        if (!socket.currentRoom) return;
        const room = rooms[socket.currentRoom];
        if (!room) return;

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

// Sunucuyu başlat
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎮 RF 26 Online Server running on port ${PORT}`);
    console.log(`🌐 Socket.IO server ready`);
    console.log(`📂 Serving files from parent directory (rf26/)`);
    console.log(`🔗 Open: http://localhost:${PORT}`);
});

// Temizlik için
process.on('SIGINT', () => {
    console.log('\n Shutting down server...');
    io.close();
    server.close();
    process.exit(0);
});