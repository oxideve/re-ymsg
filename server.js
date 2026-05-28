const net = require('net');

const YMSG_PORT = 5050; 
const activeSessions = new Map();

// Costruttore corretto per Yahoo 5.5 (Usa la struttura esatta dei byte catturati)
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
    
    // Scriviamo la versione come 0x0A00 (corrispondente a YMSG10 rilevato nel dump)
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

const server = net.createServer((socket) => {
    console.log(`\n=========================================================`);
    console.log(`[YAHOO 5.5] Canale di comunicazione allineato.`);
    console.log(`=========================================================`);

    socket.on('data', (data) => {
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
            const sessionId = socket._buffer.readUInt32BE(16);

            if (socket._buffer.length < 20 + bodyLength) break;

            const bodyBuffer = socket._buffer.slice(20, 20 + bodyLength);
            socket._buffer = socket._buffer.slice(20 + bodyLength); 

            const kvs = parseYmsgBody(bodyBuffer);
            console.log(`[YMSG IN] Servizio: ${service} (0x${service.toString(16).toUpperCase()}), Sessione: ${sessionId}`);

            // ---------------------------------------------------------
            // GESTIONE SERVIZIO 76 (0x4C): HANDSHAKE INIZIALE YAHOO 5.5
            // ---------------------------------------------------------
            if (service === 76) {
                console.log(`[HANDSHAKE] Ricevuto servizio 76. Valido il canale con il client.`);
                socket.write(buildYmsgPacket(76, 1, sessionId, {}));
                console.log(`[YMSG OUT] Risposto all'Handshake 76.`);
            }

            // ---------------------------------------------------------
            // GESTIONE SERVIZIO 22 o 87: RICHIESTA AUTENTICAZIONE INIZIALE
            // ---------------------------------------------------------
else if (service === 22 || service === 87) {
                const username = kvs['1'] || "utente_yahoo";
                socket.username = username.toLowerCase();
                console.log(`[AUTH STEP 1] Ricevuto login per: ${username}. Rispondo al servizio ${service}.`);

                // Struttura esatta del pacchetto di sfida originale Yahoo 5.5
                const challenge = {
                    '1': username,
                    '94': 'sfida_cruda_yahoo_55', // La stringa di sfida
                    '96': '0',                    // Token di sblocco crittografico 1
                    '97': '0',                    // Token di sblocco crittografico 2
                    '13': '1'                     // Flag di attivazione sessione
                };
                
                // Rispondiamo usando lo STESSO servizio richiesto e lo STESSO sessionId
                socket.write(buildYmsgPacket(service, 1, sessionId, challenge));
                console.log(`[YMSG OUT] Sfida strutturata inviata per la sessione ${sessionId}.`);
            }

            // ---------------------------------------------------------
            // GESTIONE SERVIZIO 84 (0x54): RISPOSTA ALLA SFIDA / LOGIN OK
            // ---------------------------------------------------------
            else if (service === 84) {
                const username = socket.username || kvs['1'] || "utente_yahoo";
                console.log(`[AUTH STEP 2] Il client ha risposto alla sfida. Forzo LOGIN OK.`);

                const loginOk = {
                    '1': username,
                    '0': username, 
                    '8': '1',      
                    '37': '0'
                };

                socket.write(buildYmsgPacket(84, 0, sessionId, loginOk));
                console.log(`[YMSG OUT] !!! SBLOCCO INVIATO! ${username} È ONLINE !!!`);
            }

            // ---------------------------------------------------------
            // GESTIONE SERVIZIO 21 (0x15): ENVIRONMENT/IMV
            // ---------------------------------------------------------
            else if (service === 21) {
                console.log(`[INFO] Ricevuto pacchetto plugin (Servizio 21). Rispondo specchio.`);
                socket.write(buildYmsgPacket(21, 0, sessionId, kvs));
            }
        }
    });

    socket.on('end', () => console.log(`[SOCKET] Sconnesso.`));
    socket.on('error', (e) => console.log(`[SOCKET ERR] ${e.message}`));
});

server.listen(YMSG_PORT, '0.0.0.0', () => {
    console.log(`=========================================================`);
    console.log(`[SERVER] Emulatore Chirurgico Yahoo 5.5 Pronto sulla porta ${YMSG_PORT}`);
    console.log(`=========================================================`);
});