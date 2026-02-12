const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 5050;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const sessions = new Map();

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.post("/session", (req, res) => {
  const sessionId = uuidv4();
  const { prompt, callId, contactName, voiceId, language } = req.body;
  sessions.set(sessionId, {
    prompt: prompt || "You are a helpful assistant.",
    callId: callId || null,
    contactName: contactName || "",
    voiceId: voiceId || "alloy",
    language: language || "he",
    transcript: [],
    createdAt: Date.now(),
  });
  console.log(`Session created: ${sessionId} for call ${callId}`);
  res.json({ sessionId });
});

app.post("/twiml", (req, res) => {
  const sessionId = req.query.sessionId;
  const host = req.headers.host;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream?sessionId=${sessionId}" />
  </Connect>
</Response>`;
  res.type("text/xml").send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/media-stream" });

wss.on("connection", (twilioWs, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId || !sessions.has(sessionId)) {
    console.error(`Invalid session: ${sessionId}`);
    twilioWs.close();
    return;
  }
  const session = sessions.get(sessionId);
  console.log(`Twilio connected for session ${sessionId}, call ${session.callId}`);
  let streamSid = null;
  let callSid = null;
  let openaiWs = null;
  let openaiReady = false;

  const connectOpenAI = () => {
    const wsUrl = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";
    openaiWs = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });
    openaiWs.on("open", () => {
      console.log(`OpenAI Realtime connected for session ${sessionId}`);
      openaiWs.send(JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          instructions: session.prompt,
          voice: "coral",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: { model: "whisper-1" },
          turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 600 },
        },
      }));
      openaiReady = true;
    });
    openaiWs.on("message", (data) => {
      try {
        const event = JSON.parse(data.toString());
        handleOpenAIEvent(event);
      } catch (e) { console.error("Failed to parse OpenAI event:", e); }
    });
    openaiWs.on("close", () => { openaiReady = false; });
    openaiWs.on("error", (err) => { console.error(`OpenAI error:`, err.message); });
  };

  const handleOpenAIEvent = (event) => {
    switch (event.type) {
      case "session.created":
        openaiWs.send(JSON.stringify({ type: "response.create", response: { modalities: ["text", "audio"] } }));
        break;
      case "response.audio.delta":
        if (streamSid && event.delta) {
          twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: event.delta } }));
        }
        break;
      case "response.audio_transcript.done":
        if (event.transcript) session.transcript.push({ role: "agent", text: event.transcript, timestamp: Date.now() });
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) session.transcript.push({ role: "user", text: event.transcript, timestamp: Date.now() });
        break;
      case "input_audio_buffer.speech_started":
        twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
        break;
      case "error":
        console.error(`OpenAI error:`, event.error);
        break;
    }
  };

  twilioWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      switch (data.event) {
        case "start":
          streamSid = data.start.streamSid;
          callSid = data.start.callSid;
          connectOpenAI();
          break;
        case "media":
          if (openaiReady && openaiWs?.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: data.media.payload }));
          }
          break;
        case "stop":
          handleCallEnd(sessionId, callSid);
          break;
      }
    } catch (e) { console.error("Failed to parse Twilio message:", e); }
  });

  twilioWs.on("close", () => {
    if (openaiWs?.readyState === WebSocket.OPEN) openaiWs.close();
    handleCallEnd(sessionId, callSid);
  });
});

async function handleCallEnd(sessionId, callSid) {
  const session = sessions.get(sessionId);
  if (!session || session._ended) return;
  session._ended = true;
  const duration = Math.round((Date.now() - session.createdAt) / 1000);
  const transcriptStr = session.transcript.map((t) => `${t.role === "user" ? "לקוח" : "סוכן"}: ${t.text}`).join("\n");
  console.log(`Call ended. Duration: ${duration}s`);
  if (SUPABASE_URL && SUPABASE_ANON_KEY && session.callId) {
    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/process-call-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify({ type: "openai-realtime-end", callId: session.callId, callSid, transcript: transcriptStr, duration, endedReason: "call_ended" }),
      });
      if (resp.ok) console.log(`Results posted for call ${session.callId}`);
      else console.error(`Failed: ${resp.status}`);
    } catch (err) { console.error("Failed to post results:", err); }
  }
  setTimeout(() => sessions.delete(sessionId), 5 * 60 * 1000);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > 2 * 60 * 60 * 1000) sessions.delete(id);
  }
}, 30 * 60 * 1000);

server.listen(PORT, () => { console.log(`Bridge Server running on port ${PORT}`); });
