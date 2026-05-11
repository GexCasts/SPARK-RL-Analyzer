import crypto from "node:crypto";
import net from "node:net";

const FEED_HOST = "127.0.0.1";
const FEED_PORT = 49123;
const WS_HOST = "127.0.0.1";
const WS_PORT = 49124;

const clients = new Set();
let feedSocket = null;
let reconnectTimer = null;
let streamBuffer = "";
let latestMessage = null;

function log(message){
  console.log(`[rl-stats-bridge] ${message}`);
}

function sendWebSocketText(socket, text){
  if(socket.destroyed) return;
  const payload = Buffer.from(text, "utf8");
  let header;
  if(payload.length < 126){
    header = Buffer.from([0x81, payload.length]);
  }else if(payload.length < 65536){
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  }else{
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function broadcast(text){
  latestMessage = text;
  for(const client of clients) sendWebSocketText(client, text);
}

function extractJsonObjects(chunk){
  streamBuffer += chunk;
  const messages = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastEnd = 0;

  for(let i = 0; i < streamBuffer.length; i++){
    const char = streamBuffer[i];
    if(inString){
      if(escaped){
        escaped = false;
      }else if(char === "\\"){
        escaped = true;
      }else if(char === "\""){
        inString = false;
      }
      continue;
    }
    if(char === "\""){
      inString = true;
    }else if(char === "{"){
      if(depth === 0) start = i;
      depth++;
    }else if(char === "}"){
      depth--;
      if(depth === 0 && start >= 0){
        messages.push(streamBuffer.slice(start, i + 1));
        lastEnd = i + 1;
        start = -1;
      }
    }
  }

  streamBuffer = depth > 0 && start >= 0 ? streamBuffer.slice(start) : streamBuffer.slice(lastEnd);
  return messages;
}

function connectFeed(){
  if(feedSocket && !feedSocket.destroyed) return;
  feedSocket = net.createConnection({host: FEED_HOST, port: FEED_PORT}, ()=>{
    log(`connected to Rocket League feed at ${FEED_HOST}:${FEED_PORT}`);
  });
  feedSocket.setEncoding("utf8");
  feedSocket.on("data", data=>{
    for(const message of extractJsonObjects(data)) broadcast(message);
  });
  feedSocket.on("error", err=>{
    log(`feed error: ${err.message}`);
  });
  feedSocket.on("close", ()=>{
    log("feed disconnected; retrying soon");
    feedSocket = null;
    if(!reconnectTimer){
      reconnectTimer = setTimeout(()=>{
        reconnectTimer = null;
        connectFeed();
      }, 1500);
    }
  });
}

function acceptWebSocket(socket, request){
  const key = request.match(/Sec-WebSocket-Key:\s*(.+)\r?\n/i)?.[1]?.trim();
  if(!key){
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));
  clients.add(socket);
  log(`browser connected; clients=${clients.size}`);
  if(latestMessage) sendWebSocketText(socket, latestMessage);
  socket.on("close", ()=>{
    clients.delete(socket);
    log(`browser disconnected; clients=${clients.size}`);
  });
  socket.on("error", ()=>{
    clients.delete(socket);
  });
}

const server = net.createServer(socket=>{
  socket.once("data", firstChunk=>{
    acceptWebSocket(socket, firstChunk.toString("utf8"));
  });
});

server.listen(WS_PORT, WS_HOST, ()=>{
  log(`browser WebSocket bridge listening at ws://${WS_HOST}:${WS_PORT}`);
  log(`upstream feed is ${FEED_HOST}:${FEED_PORT}`);
  connectFeed();
});
