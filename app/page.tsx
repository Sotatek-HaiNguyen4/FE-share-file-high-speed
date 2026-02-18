/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

// const SIGNALING_SERVER = "http://192.168.1.13:4000"; // đổi IP
const SIGNALING_SERVER = "https://be-share-file-high-speed-1.onrender.com/"; // đổi IP
const CHUNK_SIZE = 16 * 1024;

export default function Home() {
  const [roomId, setRoomId] = useState("1234");
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<{ text: string; mine: boolean }[]>(
    [],
  );

  const [connectionState, setConnectionState] = useState("Disconnected");
  const [sendProgress, setSendProgress] = useState(0);
  const [receiveProgress, setReceiveProgress] = useState(0);
  const [sendingFileName, setSendingFileName] = useState("");
  const [receivingFileName, setReceivingFileName] = useState("");

  const socketRef = useRef<any>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const isCreatorRef = useRef(false);

  const fileBufferRef = useRef<ArrayBuffer[]>([]);
  const receivedSizeRef = useRef(0);
  const fileMetaRef = useRef<{ name: string; size: number } | null>(null);

  // ================= SOCKET =================
  useEffect(() => {
    socketRef.current = io(SIGNALING_SERVER);

    socketRef.current.on("user-joined", async () => {
      if (!isCreatorRef.current) return;

      const offer = await peerRef.current?.createOffer();
      await peerRef.current?.setLocalDescription(offer!);
      socketRef.current.emit("offer", { roomId, offer });
    });

    socketRef.current.on("offer", async (offer: any) => {
      await peerRef.current?.setRemoteDescription(
        new RTCSessionDescription(offer),
      );
      const answer = await peerRef.current?.createAnswer();
      await peerRef.current?.setLocalDescription(answer!);
      socketRef.current.emit("answer", { roomId, answer });
    });

    socketRef.current.on("answer", async (answer: any) => {
      await peerRef.current?.setRemoteDescription(
        new RTCSessionDescription(answer),
      );
    });

    socketRef.current.on("ice-candidate", async (candidate: any) => {
      await peerRef.current?.addIceCandidate(new RTCIceCandidate(candidate));
    });

    return () => socketRef.current.disconnect();
  }, []);

  // ================= PEER =================
  const createPeer = () => {
    // const peer = new RTCPeerConnection({
    //   iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    // });

    const peer = new RTCPeerConnection();

    peer.onconnectionstatechange = () => {
      setConnectionState(peer.connectionState);
    };

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current.emit("ice-candidate", {
          roomId,
          candidate: event.candidate,
        });
      }
    };

    peer.ondatachannel = (event) => {
      setupDataChannel(event.channel);
    };

    peerRef.current = peer;
  };

  // ================= DATA CHANNEL =================
  const setupDataChannel = (channel: RTCDataChannel) => {
    channel.binaryType = "arraybuffer"; // 🔥 QUAN TRỌNG FIX SAFARI

    dataChannelRef.current = channel;

    channel.onopen = () => {
      setConnectionState("Connected");
    };

    channel.onmessage = async (e) => {
      if (typeof e.data === "string") {
        const msg = JSON.parse(e.data);

        if (msg.type === "chat") {
          setMessages((prev) => [...prev, { text: msg.text, mine: false }]);
        }

        if (msg.type === "file-meta") {
          fileMetaRef.current = msg;
          fileBufferRef.current = [];
          receivedSizeRef.current = 0;
          setReceivingFileName(msg.name);
          setReceiveProgress(0);
        }

        if (msg.type === "file-end") {
          const blob = new Blob(fileBufferRef.current);
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = fileMetaRef.current?.name || "download";
          a.click();
          setReceiveProgress(100);
        }
      } else {
        // 🔥 FIX SAFARI CHUNK BUG
        let buffer: ArrayBuffer;

        if (e.data instanceof ArrayBuffer) {
          buffer = e.data;
        } else if (e.data instanceof Blob) {
          buffer = await e.data.arrayBuffer();
        } else if (e.data.buffer) {
          buffer = e.data.buffer;
        } else {
          return;
        }

        fileBufferRef.current.push(buffer);
        receivedSizeRef.current += buffer.byteLength;

        if (fileMetaRef.current) {
          const percent = Math.floor(
            (receivedSizeRef.current / fileMetaRef.current.size) * 100,
          );
          setReceiveProgress(percent);
        }
      }
    };
  };

  // ================= ROOM =================
  const createRoom = () => {
    isCreatorRef.current = true;
    createPeer();
    const channel = peerRef.current!.createDataChannel("chat");
    setupDataChannel(channel);
    socketRef.current.emit("join-room", roomId);
  };

  const joinRoom = () => {
    isCreatorRef.current = false;
    createPeer();
    socketRef.current.emit("join-room", roomId);
  };

  // ================= CHAT =================
  const sendMessage = () => {
    if (!dataChannelRef.current) return;

    dataChannelRef.current.send(
      JSON.stringify({ type: "chat", text: message }),
    );

    setMessages((prev) => [...prev, { text: message, mine: true }]);
    setMessage("");
  };

  // ================= FILE =================
  const sendFile = async (file: File) => {
    const channel = dataChannelRef.current;
    if (!channel) return;

    setSendingFileName(file.name);
    setSendProgress(0);

    channel.bufferedAmountLowThreshold = 64 * 1024;

    channel.send(
      JSON.stringify({
        type: "file-meta",
        name: file.name,
        size: file.size,
      }),
    );

    let offset = 0;

    const readSlice = async () => {
      if (offset >= file.size) {
        channel.send(JSON.stringify({ type: "file-end" }));
        setSendProgress(100);
        return;
      }

      if (channel.bufferedAmount > 8 * 1024 * 1024) return;

      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const buffer = await slice.arrayBuffer();
      channel.send(buffer);

      offset += CHUNK_SIZE;
      setSendProgress(Math.floor((offset / file.size) * 100));

      readSlice();
    };

    channel.onbufferedamountlow = () => readSlice();
    readSlice();
  };

  // ================= UI =================
  return (
    <div className="min-h-screen bg-gray-100 flex flex-col items-center p-4">
      <div className="w-full max-w-md bg-white shadow-xl rounded-2xl p-4 flex flex-col h-[90vh]">
        <div className="flex justify-between items-center mb-2">
          <h1 className="font-bold text-lg">WebRTC LAN Share</h1>
          <span
            className={`text-xs px-2 py-1 rounded-full ${
              connectionState === "Connected"
                ? "bg-green-100 text-green-600"
                : "bg-yellow-100 text-yellow-600"
            }`}
          >
            {connectionState}
          </span>
        </div>

        <div className="flex gap-2 mb-2">
          <input
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            className="border rounded-lg p-2 flex-1 max-w-[40vw]"
          />
          <button
            onClick={createRoom}
            className="bg-blue-500 text-white px-3 rounded-lg"
          >
            Create
          </button>
          <button
            onClick={joinRoom}
            className="bg-green-500 text-white px-3 rounded-lg"
          >
            Join
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-2 p-2 bg-gray-50 rounded-xl">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`max-w-[70%] p-2 rounded-xl text-sm ${
                msg.mine
                  ? "bg-blue-500 text-white ml-auto"
                  : "bg-gray-200 text-black"
              }`}
            >
              {msg.text}
            </div>
          ))}
        </div>

        {sendProgress > 0 && (
          <div className="mt-2 text-xs">
            Sending {sendingFileName} ({sendProgress}%)
            <div className="h-2 bg-gray-200 rounded">
              <div
                className="h-2 bg-green-500 rounded"
                style={{ width: sendProgress + "%" }}
              />
            </div>
          </div>
        )}

        {receiveProgress > 0 && (
          <div className="mt-2 text-xs">
            Receiving {receivingFileName} ({receiveProgress}%)
            <div className="h-2 bg-gray-200 rounded">
              <div
                className="h-2 bg-blue-500 rounded"
                style={{ width: receiveProgress + "%" }}
              />
            </div>
          </div>
        )}

        <div className="flex gap-2 mt-2">
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="border rounded-lg p-2 flex-1"
          />
          <button
            onClick={sendMessage}
            className="bg-black text-white px-4 rounded-lg"
          >
            Send
          </button>
        </div>

        <input
          type="file"
          className="mt-2 text-sm"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) sendFile(file);
          }}
        />
      </div>
    </div>
  );
}
