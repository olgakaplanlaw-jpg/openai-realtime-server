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

// In-memory session store
const sessions = new Map();

// Health check
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Create a session with call context (called by Edge Function before making Twilio call)
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

// TwiML endpoint - Twilio calls this to get instructions
app.post("/twiml", (req, res) => {
  const sessionId = req.query.sessionId;
  const host = req.headers.host;
  const protocol = req.headers["x-forwarded-proto"] || "https";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream">
      <Parameter name="sessionId" value="${sessionId}" />
    </Stream>
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// Create HTTP server
const server = http.createServer(app);

// WebSocket server for Twilio Media Streams
const wss = new WebSocket.Server({ server, path: "/media-stream" });

wss.on("connection", (twilioWs, req) => {
  // Try to get sessionId from URL (fallback), but primarily from Twilio start event
  const url = new URL(req.url, `http://${req.headers.host}`);
  let sessionId = url.searchParams.get("sessionId");
  let session = sessionId ? sessions.get(sessionId) : null;

  console.log(`Twilio WebSocket connected. URL sessionId: ${sessionId || "null"}`);

  let streamSid = null;
  let callSid = null;
  let openaiWs = null;
  let openaiReady = false;

  // Connect to OpenAI Realtime API
  const connectOpenAI = () => {
    const wsUrl =
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

    openaiWs = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    openaiWs.on("open", () => {
      console.log(`OpenAI Realtime connected for session ${sessionId}`);

      const openaiVoice = "coral";

      // Configure session
      openaiWs.send(
        JSON.stringify({
          type: "session.update",
          session: {
            modalities: ["text", "audio"],
            instructions: session.prompt,
            voice: openaiVoice,
            input_audio_format: "g711_ulaw",
            output_audio_format: "g711_ulaw",
            input_audio_transcription: {
              model: "whisper-1",
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 600,
            },
          },
        })
      );

      openaiReady = true;
    });

    openaiWs.on("message", (data) => {
      try {
        const event = JSON.parse(data.toString());
        handleOpenAIEvent(event);
      } catch (e) {
        console.error("Failed to parse OpenAI event:", e);
      }
    });

    openaiWs.on("close", (code, reason) => {
      console.log(
        `OpenAI disconnected for session ${sessionId}: ${code} ${reason}`
      );
      openaiReady = false;
    });

    openaiWs.on("error", (err) => {
      console.error(`OpenAI error for session ${sessionId}:`, err.message);
    });
  };

  const handleOpenAIEvent = (event) => {
    switch (event.type) {
      case "session.created":
        console.log(`OpenAI session created for ${sessionId}`);
        // Send initial greeting - let the AI speak first
        openaiWs.send(
          JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["text", "audio"],
            },
          })
        );
        break;

      case "response.audio.delta":
        // Send audio back to Twilio
        if (streamSid && event.delta) {
          twilioWs.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: {
                payload: event.delta,
              },
            })
          );
        }
        break;

      case "response.audio_transcript.done":
        if (event.transcript) {
          session.transcript.push({
            role: "agent",
            text: event.transcript,
            timestamp: Date.now(),
          });
        }
        break;

      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          session.transcript.push({
            role: "user",
            text: event.transcript,
            timestamp: Date.now(),
          });
        }
        break;

      case "input_audio_buffer.speech_started":
        twilioWs.send(
          JSON.stringify({
            event: "clear",
            streamSid,
          })
        );
        break;

      case "error":
        console.error(`OpenAI error in session ${sessionId}:`, event.error);
        break;
    }
  };

  // Handle Twilio messages
  twilioWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      switch (data.event) {
        case "connected":
          console.log(`Twilio stream connected for session ${sessionId}`);
          break;

        case "start":
          streamSid = data.start.streamSid;
          callSid = data.start.callSid;

          // Get sessionId from Twilio custom parameters (primary method)
          if (!session && data.start.customParameters?.sessionId) {
            sessionId = data.start.customParameters.sessionId;
            session = sessions.get(sessionId);
          }

          if (!session) {
            console.error(`No valid session found. sessionId=${sessionId}, customParams=${JSON.stringify(data.start.customParameters)}`);
            twilioWs.close();
            return;
          }

          console.log(
            `Twilio stream started: sessionId=${sessionId}, streamSid=${streamSid}, callSid=${callSid}`
          );
          // Now connect to OpenAI
          connectOpenAI();
          break;

        case "media":
          if (openaiReady && openaiWs?.readyState === WebSocket.OPEN) {
            openaiWs.send(
              JSON.stringify({
                type: "input_audio_buffer.append",
                audio: data.media.payload,
              })
            );
          }
          break;

        case "stop":
          console.log(`Twilio stream stopped for session ${sessionId}`);
          handleCallEnd(sessionId, callSid);
          break;
      }
    } catch (e) {
      console.error("Failed to parse Twilio message:", e);
    }
  });

  twilioWs.on("close", () => {
    console.log(`Twilio WebSocket closed for session ${sessionId}`);
    if (openaiWs?.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
    handleCallEnd(sessionId, callSid);
  });

  twilioWs.on("error", (err) => {
    console.error(`Twilio WebSocket error for session ${sessionId}:`, err.message);
  });
});

// Handle call end - post results back to Supabase
async function handleCallEnd(sessionId, callSid) {
  const session = sessions.get(sessionId);
  if (!session || session._ended) return;
  session._ended = true;

  const duration = Math.round((Date.now() - session.createdAt) / 1000);

  const transcriptStr = session.transcript
    .map((t) => `${t.role === "user" ? "לקוח" : "סוכן"}: ${t.text}`)
    .join("\n");

  console.log(
    `Call ended for session ${sessionId}. Duration: ${duration}s, Transcript length: ${transcriptStr.length}`
  );

  if (SUPABASE_URL && SUPABASE_ANON_KEY && session.callId) {
    try {
      const resp = await fetch(
        `${SUPABASE_URL}/functions/v1/process-call-result`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify({
            type: "openai-realtime-end",
            callId: session.callId,
            callSid: callSid,
            transcript: transcriptStr,
            duration,
            endedReason: "call_ended",
          }),
        }
      );

      if (resp.ok) {
        console.log(`Results posted to Supabase for call ${session.callId}`);
      } else {
        console.error(
          `Failed to post results: ${resp.status} ${await resp.text()}`
        );
      }
    } catch (err) {
      console.error("Failed to post call results:", err);
    }
  }

  setTimeout(() => sessions.delete(sessionId), 5 * 60 * 1000);
}

// Cleanup old sessions every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > 2 * 60 * 60 * 1000) {
      sessions.delete(id);
    }
  }
}, 30 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`OpenAI Realtime Bridge Server running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
