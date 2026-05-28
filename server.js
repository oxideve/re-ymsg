const net = require('net');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

const YMSG_PORT = 5050;
const DB_PATH = path.join(__dirname, 'database.db');

// Mappe di controllo per i canali
const activeSessions = new Map(); // Username -> Socket principale
const sessionToUser = new Map();  // SessionId -> Username
let db;

// =================================================================
// INIZIALIZZAZIONE DATABASE SQLITE
// =================================================================
async function initDatabase() {
    try {
        db = await open({ filename: DB_PATH, driver: sqlite3.Database });
        console.log(`[SQLITE] Connesso al database: ${DB_PATH}`);
        
        await db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password TEXT DEFAULT '1',
                nickname TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS friends (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                friend_username TEXT NOT NULL,
                group_id TEXT DEFAULT '1',
                UNIQUE(username, friend_username)
            )
        `);
        console.log('[SQLITE] Tabelle verificate/create.');
    } catch (err) {
        console.error('[SQLITE ERROR]', err.message);
    }
}

// =================================================================
// COSTRUTTORE E PARSER DI PACCHETTI YAHOO
// =================================================================
function buildYmsgPacket(service, status, sessionId, keyValuePairs) {
    let bodyBuffers = [];
    for (const [key, value] of Object.entries(keyValuePairs)) {
        bodyBuffers.push(Buffer.from(String(key), 'utf8'));
        bodyBuffers.push(Buffer.from([0xC0, 0x80]));
        bodyBuffers.push(Buffer.from(String(value), 'utf8'));
        bodyBuffers.push(Buffer.from([0xC0, 0x80]));
    }
    const bodyBuffer = Buffer.concat(bodyBuffers);

    const headerBuffer = Buffer.alloc(20);
    headerBuffer.write("YMSG", 0, 4, 'ascii');          
    headerBuffer.writeUInt16BE(0x0A00, 4);       
    headerBuffer.writeUInt16BE(0, 6);                    
    headerBuffer.writeUInt16BE(bodyBuffer.length, 8);    
    headerBuffer.writeUInt16BE(service, 10);             
    headerBuffer.writeUInt32BE(status, 12);              
    headerBuffer.writeUInt32BE(sessionId, 16);           

    return Buffer.concat([headerBuffer, bodyBuffer]);
}

function parseYmsgBody(buffer) {
    const pairs = {};
    let start = 0;
    while (start < buffer.length) {
        let sep1 = buffer.indexOf(Buffer.from([0xC0, 0x80]), start);
        if (sep1 === -1) break;
        const key = buffer.toString('utf8', start, sep1);
        let sep2 = buffer.indexOf(Buffer.from([0xC0, 0x80]), sep1 + 2);
        if (sep2 === -1) break;
        const value = buffer.toString('utf8', sep1 + 2, sep2);
        pairs[key] = value;
        start = sep2 + 2;
    }
    return pairs;
}

// =================================================================
// CORE SERVER TCP
// =================================================================
const server = net.createServer((socket) => {
    socket.setKeepAlive(true, 30000);

    socket.on('data', async (data) => {
        socket._buffer = socket._buffer ? Buffer.concat([socket._buffer, data]) : data;

        while (socket._buffer.length >= 20) {
            const signature = socket._buffer.toString('ascii', 0, 4);
            if (signature !== "YMSG") {
                socket._buffer = socket._buffer.slice(1); 
                continue;
            }

            const bodyLength = socket._buffer.readUInt16BE(8);
            const service = socket._buffer.readUInt16BE(10);
            const status = socket._buffer.readUInt32BE(12);
            let sessionId = socket._buffer.readUInt32BE(16);

            if (socket._buffer.length < 20 + bodyLength) break;

            const bodyBuffer = socket._buffer.slice(20, 20 + bodyLength);
            socket._buffer = socket._buffer.slice(20 + bodyLength); 

            const kvs = parseYmsgBody(bodyBuffer);

            if (service !== 21 && service !== 75) {
                console.log(`[YMSG IN] Servizio: ${service} | SessionId Client: ${sessionId}`);
            }

            // 1. HANDSHAKE (76)
            if (service === 76) {
                socket.write(buildYmsgPacket(76, 1, sessionId, {}));
            }

            // 2. LOGIN STEP 1 (87 o 22)
            else if (service === 22 || service === 87) {
                const usernameInput = kvs['1'] ? kvs['1'].toLowerCase().trim() : null;
                if (!usernameInput) { socket.end(); return; }
                
                socket.username = usernameInput;

                if (sessionId !== 0 && sessionToUser.has(sessionId)) {
                    console.log(`[CHANNELS] Intercettato secondo socket di servizio per sessione: ${sessionId}`);
                    socket.write(buildYmsgPacket(service, 1, sessionId, { '1': usernameInput }));
                    continue;
                }

                try {
                    const existingUser = await db.get('SELECT * FROM users WHERE username = ?', [usernameInput]);
                    if (!existingUser) {
                        await db.run('INSERT INTO users (username, password, nickname) VALUES (?, ?, ?)', [usernameInput, '1', kvs['1']]);
                        console.log(`[DB] Auto-Registrato: ${usernameInput}`);
                    }
                } catch (e) { console.error(e.message); }

                if (sessionId === 0) {
                    sessionId = Math.floor(Math.random() * 50000) + 10000;
                }

                socket.sessionId = sessionId;
                sessionToUser.set(sessionId, usernameInput);

                const challenge = {
                    '1': kvs['1'],
                    '94': 'sfida_cruda_yahoo_55',
                    '96': '0', '97': '0', '13': '1'
                };
                socket.write(buildYmsgPacket(service, 1, sessionId, challenge));
                console.log(`[YMSG OUT] Sfida inviata a ${usernameInput}. Assegnato SessionID: ${sessionId}`);
            }

            // 3. LOGIN FINALE (84)
            else if (service === 84) {
                const username = socket.username || (kvs['1'] ? kvs['1'].toLowerCase().trim() : "utente_yahoo");
                socket.username = username;
                const currentSessionId = socket.sessionId || sessionId;
                
                activeSessions.set(username, socket);

                let displayNickname = username;
                try {
                    const dbUser = await db.get('SELECT nickname FROM users WHERE username = ?', [username]);
                    if (dbUser) displayNickname = dbUser.nickname;
                } catch (e) {}

                const loginOk = {
                    '1': username,
                    '0': displayNickname, 
                    '8': '1',      
                    '37': '0'
                };

                socket.write(buildYmsgPacket(84, 0, currentSessionId, loginOk));
                console.log(`[STATUS] !!! SBLOCCATO !!! -> ${displayNickname} È STABILE ONLINE.`);

                // TRASMISSIONE LISTA AMICI
                try {
                    const dbFriends = await db.all('SELECT friend_username FROM friends WHERE username = ?', [username]);
                    for (const f of dbFriends) {
                        const targetFriend = f.friend_username;
                        const isOnline = activeSessions.has(targetFriend.toLowerCase().trim()) ? '1' : '0';
                        socket.write(buildYmsgPacket(1, 0, currentSessionId, { '7': targetFriend, '8': isOnline }));
                        
                        if (isOnline === '1') {
                            const friendSocket = activeSessions.get(targetFriend.toLowerCase().trim());
                            if (friendSocket) {
                                friendSocket.write(buildYmsgPacket(1, 0, friendSocket.sessionId || currentSessionId, { '7': displayNickname, '8': '1' }));
                            }
                        }
                    }
                } catch (bErr) { console.error(bErr.message); }
            }

            // 4. AGGIUNTA AMICO (131)
            else if (service === 131) {
                const myUser = kvs['1'] || socket.username || "Sconosciuto";
                const friendUser = kvs['7'] || "Nessuno";
                const group = kvs['65'] || "1";

                const myUsernameKey = myUser.toLowerCase().trim();
                const friendUsernameKey = friendUser.toLowerCase().trim();
                const currentSessionId = socket.sessionId || sessionId;

                try {
                    await db.run('INSERT OR IGNORE INTO friends (username, friend_username, group_id) VALUES (?, ?, ?)', [myUsernameKey, friendUser, group]);
                    console.log(`[SQLITE] Relazione salvata: ${myUsernameKey} ha aggiunto ${friendUser}`);
                    
                    socket.write(buildYmsgPacket(131, 0, currentSessionId, { '1': myUser, '7': friendUser, '65': group, '14': kvs['14'] || '' }));
                    
                    const targetSocket = activeSessions.get(friendUsernameKey);
                    if (targetSocket) {
                        socket.write(buildYmsgPacket(1, 0, currentSessionId, { '7': friendUser, '8': '1' }));
                        targetSocket.write(buildYmsgPacket(1, 0, targetSocket.sessionId || currentSessionId, { '7': myUser, '8': '1' }));
                    } else {
                        socket.write(buildYmsgPacket(1, 0, currentSessionId, { '7': friendUser, '8': '0' }));
                    }
                } catch (sqlErr) { console.error(sqlErr.message); }
            }

            // 5. CATTURA E INOLTRO MESSAGGI DI CHAT CORRETTO (4 o 6)
            else if (service === 4 || service === 6) {
                const mittente = kvs['1'] || socket.username || "Sconosciuto";
                const destinatario = kvs['5'] || "Tutti";
                const messaggio = kvs['14'] || "";

                console.log(`\n=========================================================`);
                console.log(`[CHAT] Inoltro messaggio da: ${mittente} -> A: ${destinatario}`);
                console.log(`=========================================================`);

                // Struttura corretta per la ricezione:
                // Chiave 1: l'utente che riceve il messaggio (destinatario)
                // Chiave 4: l'utente che ha originato il messaggio (mittente)
                const messagePayload = {
                    '1': destinatario,   
                    '4': mittente,       
                    '5': destinatario,   
                    '14': messaggio,     
                    '97': '1',           
                    '63': ';0',          
                    '64': '0'            
                };

                const targetSocket = activeSessions.get(destinatario.toLowerCase().trim());
                if (targetSocket) {
                    targetSocket.write(buildYmsgPacket(service, 1, targetSocket.sessionId || sessionId, messagePayload));
                    
                    if (socket !== targetSocket && socket.username === destinatario.toLowerCase().trim()) {
                        socket.write(buildYmsgPacket(service, 1, sessionId, messagePayload));
                    }
                    console.log(`[CHAT OUT] Messaggio recapitato con mittente associato.`);
                } else {
                    console.log(`[CHAT WARNING] Impossibile inoltrare: ${destinatario} è offline.`);
                }
            }

            // 6. ENVIRONMENT/PLUGIN (21)
            else if (service === 21) {
                socket.write(buildYmsgPacket(21, 0, sessionId, kvs));
            }
        }
    });

    socket.on('end', () => {
        if (socket.username) {
            console.log(`[SOCKET] Sconnesso: ${socket.username}`);
            activeSessions.delete(socket.username);
            if (socket.sessionId) sessionToUser.delete(socket.sessionId);
        }
    });
    socket.on('error', () => {});
});

async function main() {
    await initDatabase();
    server.listen(YMSG_PORT, '0.0.0.0', () => {
        console.log(`=========================================================`);
        console.log(`[SERVER RETRÒ YAHOO 5.5 CHAT COMPLETATA] Porta ${YMSG_PORT}`);
        console.log(`=========================================================`);
    });
}
main();