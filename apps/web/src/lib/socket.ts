import { io, type Socket } from "socket.io-client";

let socket: Socket | null = null;

export function connectSocket(accessToken: string): Socket {
  if (socket) {
    socket.disconnect();
  }
  socket = io({
    path: "/socket.io",
    auth: { token: accessToken },
    // Websocket-only had no fallback: if any hop between the browser and the
    // VPS (a carrier/corporate proxy, a misbehaving intermediary) strips the
    // Upgrade header, the socket never connects and the whole app silently
    // loses realtime — inbound messages, delivery/read ticks, queue updates
    // — with nothing on screen to explain why. Polling first, then upgrading
    // to a websocket, is socket.io's own default and degrades gracefully.
    transports: ["polling", "websocket"],
  });
  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
