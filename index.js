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
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// In-memory session store
const sessions = new Map();

// Health check
app.get("/health", (req, res) => res.json({
  status: "ok",
  version: "3.0.0",
  model: "gpt-4o-realtime-preview",
  transfer_enabled: true,
  uptime_seconds: Math.floor(process.uptime()),
}));

// Create a session with call context
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
    twilioWs: null,
    openaiWs: null,
    streamSid: null,
    callSid: null,
    transferring: false,
  });

  console.log(`Session created: ${sessionId} for call ${callId}`);
  res.json({ sessionId });
});

// === WARM TRANSFER ===
app.post("/transfer", async (req, res) => {
  const { sessionId, ownerPhone, contactContext } = req.body;
  if (!sessionId || !ownerPhone) {
    return res.status(400).json({ error: "sessionId and ownerPhone required" });
  }
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.transferring) return res.status(409).json({ error: "Transfer already in progress" });
  if (!session.callSid || !session.streamSid) {
    return res.status(400).json({ error: "No active Twilio call for this session" });
  }
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    return res.status(500).json({ error: "Twilio not configured" });
  }

  session.transferring = true;
  const conferenceName = `warm-transfer-${sessionId.slice(0, 8)}`;
  console.log(`🔄 Initiating warm transfer for session ${sessionId}, conference: ${conferenceName}`);

  try {
    if (session.openaiWs?.readyState === WebSocket.OPEN) {
      session.openaiWs.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["text", "audio"],
          instructions: "אמור ללקוח: 'אני מעבירה אותך עכשיו לנציג אנושי, רגע אחד בבקשה.' ואז תפסיק לדבר.",
        },
      }));
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));

    if (session.openaiWs?.readyState === WebSocket.OPEN) {
      session.openaiWs.close();
    }

    const host = req.headers.host;
    const protocol = req.headers["x-forwarded-proto"] || "https";
    const conferenceUrl = `${protocol}://${host}/conference-twiml?conference=${encodeURIComponent(conferenceName)}`;
    const twilioAuth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

    const redirectResp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${session.callSid}.json`,
      {
        method: "POST",
        headers: { Authorization: `Basic ${twilioAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ Url: conferenceUrl, Method: "POST" }).toString(),
      }
    );

    if (!redirectResp.ok) throw new Error("Failed to redirect customer to conference");
    console.log(`✅ Customer call ${session.callSid} redirected to conference ${conferenceName}`);

    const contextSummary = contactContext || `שיחה עם ${session.contactName || "לקוח"}`;
    const ownerTwimlUrl = `${protocol}://${host}/owner-twiml?conference=${encodeURIComponent(conferenceName)}&context=${encodeURIComponent(contextSummary)}`;

    let normalizedOwnerPhone = ownerPhone.replace(/[\s\-()]/g, "");
    if (normalizedOwnerPhone.startsWith("0")) {
      normalizedOwnerPhone = "+972" + normalizedOwnerPhone.slice(1);
    } else if (!normalizedOwnerPhone.startsWith("+")) {
      normalizedOwnerPhone = "+" + normalizedOwnerPhone;
    }

    const dialResp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`,
      {
        method: "POST",
        headers: { Authorization: `Basic ${twilioAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          To: normalizedOwnerPhone, From: TWILIO_PHONE_NUMBER, Url: ownerTwimlUrl, TimeLimit: "1800",
        }).toString(),
      }
    );

    if (!dialResp.ok) throw new Error("Failed to dial owner");
    const dialResult = await dialResp.json();
    console.log(`✅ Owner dial initiated: ${dialResult.sid} to ${normalizedOwnerPhone}`);

    res.json({ success: true, conferenceName, ownerCallSid: dialResult.sid });
  } catch (err) {
    console.error("❌ Warm transfer error:", err);
    session.transferring = false;
    res.status(500).json({ error: err.message || "Transfer failed" });
  }
});

// Conference TwiML
app.post("/conference-twiml", (req, res) => {
  const conferenceName = req.query.conference || "default-conference";
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="he-IL" voice="Google.he-IL-Standard-A">אנחנו מחברים אותך לנציג, רגע אחד.</Say>
  <Dial>
    <Conference waitUrl="http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical" startConferenceOnEnter="true" endConferenceOnExit="true">${conferenceName}</Conference>
  </Dial>
</Response>`;
  res.type("text/xml").send(twiml);
});

// Owner TwiML
app.post("/owner-twiml", (req, res) => {
  const conferenceName = req.query.conference || "default-conference";
  const context = req.query.context || "שיחה עם לקוח";
  const safeContext = String(context).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="he-IL" voice="Google.he-IL-Standard-A">שלום, יש לקוח על הקו. ${safeContext}. לחץ כל מקש כדי להתחבר.</Say>
  <Gather numDigits="1" action="/join-conference?conference=${encodeURIComponent(conferenceName)}" method="POST">
    <Say language="he-IL" voice="Google.he-IL-Standard-A">לחץ כל מקש כדי להתחבר.</Say>
  </Gather>
  <Say language="he-IL" voice="Google.he-IL-Standard-A">לא התקבלה תגובה. מנתקת.</Say>
</Response>`;
  res.type("text/xml").send(twiml);
});

// Join conference
app.post("/join-conference", (req, res) => {
  const conferenceName = req.query.conference || "default-conference";
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="he-IL" voice="Google.he-IL-Standard-A">מתחבר לשיחה.</Say>
  <Dial>
    <Conference startConferenceOnEnter="true" endConferenceOnExit="true">${conferenceName}</Conference>
  </Dial>
</Response>`;
  res.type("text/xml").send(twiml);
});

// TwiML endpoint
app.post("/twiml", (req, res) => {
  const sessionId = req.query.sessionId;
  const host = req.headers.host;
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
const wss = new WebSocket.Server({ server, path: "/media-stream" });

wss.on("connection", (twilioWs, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let sessionId = url.searchParams.get("sessionId");
  let session = sessionId ? sessions.get(sessionId) : null;

  console.log(`Twilio WebSocket connected. URL sessionId: ${sessionId || "null"}`);

  let streamSid = null;
  let callSid = null;
  let openaiWs = null;
  let openaiReady = false;
  let greetingSent = false;
  let fallbackTimer = null;
  let firstAudioReceived = false;
  let audioWatchdogTimer = null;

  const connectOpenAI = () => {
    const wsUrl = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";
    console.log(`[${sessionId}] Connecting to OpenAI: ${wsUrl}`);

    openaiWs = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    if (session) {
      session.openaiWs = openaiWs;
      session.twilioWs = twilioWs;
    }

    openaiWs.on("open", () => {
      console.log(`✅ [${sessionId}] OpenAI Realtime connected`);

      openaiWs.send(JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          instructions: session.prompt,
          voice: "coral",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: {
            model: "whisper-1",
            language: session.language || "he",
          },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
          },
        },
      }));

      openaiReady = true;

      // Fallback: if session.updated doesn't fire in 4s, send greeting anyway
      fallbackTimer = setTimeout(() => {
        if (!greetingSent && openaiWs?.readyState === WebSocket.OPEN) {
          console.log(`⚠️ [${sessionId}] Fallback: session.updated not received, sending greeting`);
          sendGreeting();
        }
      }, 4000);
    });

    openaiWs.on("message", (data) => {
      try {
        handleOpenAIEvent(JSON.parse(data.toString()));
      } catch (e) {
        console.error("Failed to parse OpenAI event:", e);
      }
    });

    openaiWs.on("close", (code, reason) => {
      console.log(`❌ [${sessionId}] OpenAI disconnected: ${code} ${reason}`);
      openaiReady = false;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (audioWatchdogTimer) clearTimeout(audioWatchdogTimer);
    });

    openaiWs.on("error", (err) => {
      console.error(`❌ [${sessionId}] OpenAI error:`, err.message);
    });
  };

  const sendGreeting = () => {
    if (greetingSent) return;
    greetingSent = true;
    if (fallbackTimer) clearTimeout(fallbackTimer);
    console.log(`🎤 [${sessionId}] Sending initial greeting`);

    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["text", "audio"],
      },
    }));

    // Watchdog: if no audio comes back in 3.5s, force a spoken line
    audioWatchdogTimer = setTimeout(() => {
      if (!firstAudioReceived && openaiWs?.readyState === WebSocket.OPEN) {
        console.log(`⚠️ [${sessionId}] No audio after greeting, forcing explicit speech`);
        openaiWs.send(JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["text", "audio"],
            instructions: "אמרי בדיוק: שלום, כאן הסוכנת האוטומטית. איך אפשר לעזור?",
          },
        }));
      }
    }, 3500);
  };

  // Auto-detect transfer request
  const checkForTransferRequest = (text) => {
    if (!text || session?.transferring) return;
    const transferPhrases = [
      "מעבירה את הבקשה שלך ונציג אנושי יחזור",
      "אני מעבירה אותך לנציג",
      "מחברת אותך לנציג אנושי",
    ];
    if (transferPhrases.some((p) => text.includes(p))) {
      console.log(`🔄 Auto-detected transfer request in session ${sessionId}`);
      autoTriggerTransfer(sessionId, session);
    }
  };

  const autoTriggerTransfer = async (sid, sess) => {
    const ownerPhone = process.env.OWNER_PHONE_NUMBER;
    if (!ownerPhone || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return;

    try {
      const recentTranscript = sess.transcript.slice(-4)
        .map((t) => `${t.role === "user" ? "לקוח" : "סוכן"}: ${t.text}`).join(" | ");
      const context = `${sess.contactName || "לקוח"} ביקש נציג אנושי. ${recentTranscript}`;
      const host = process.env.RAILWAY_PUBLIC_DOMAIN || `localhost:${PORT}`;
      const protocol = process.env.RAILWAY_PUBLIC_DOMAIN ? "https" : "http";

      const resp = await fetch(`${protocol}://${host}/transfer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sid, ownerPhone, contactContext: context }),
      });
      if (resp.ok) console.log(`✅ Auto-transfer initiated for session ${sid}`);
      else console.error(`❌ Auto-transfer failed: ${await resp.text()}`);
    } catch (err) {
      console.error("❌ Auto-transfer error:", err);
    }
  };

  const handleOpenAIEvent = (event) => {
    switch (event.type) {
      case "session.created":
        console.log(`✅ [${sessionId}] OpenAI session created`);
        break;

      case "session.updated":
        console.log(`✅ [${sessionId}] OpenAI session configured, sending greeting`);
        sendGreeting();
        break;

      case "response.audio.delta":
        if (!firstAudioReceived) {
          firstAudioReceived = true;
          if (audioWatchdogTimer) clearTimeout(audioWatchdogTimer);
          console.log(`🔊 [${sessionId}] First audio delta received`);
        }
        if (streamSid && event.delta && !session?.transferring) {
          twilioWs.send(JSON.stringify({
            event: "media", streamSid, media: { payload: event.delta },
          }));
        }
        break;

      case "response.audio_transcript.done":
        if (event.transcript) {
          session.transcript.push({ role: "agent", text: event.transcript, timestamp: Date.now() });
          checkForTransferRequest(event.transcript);
        }
        break;

      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          console.log(`[${sessionId}] Customer said: ${event.transcript.slice(0, 100)}`);
          session.transcript.push({ role: "user", text: event.transcript, timestamp: Date.now() });
        }
        break;

      case "conversation.item.input_audio_transcription.failed":
        console.error(`[${sessionId}] Input transcription failed:`, JSON.stringify(event.error || event));
        break;

      case "input_audio_buffer.speech_started":
        if (!session?.transferring) {
          twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
        }
        break;

      case "error":
        console.error(`❌ OpenAI error in session ${sessionId}:`, event.error);
        break;
    }
  };

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
          if (!session && data.start.customParameters?.sessionId) {
            sessionId = data.start.customParameters.sessionId;
            session = sessions.get(sessionId);
          }
          if (!session) {
            console.error(`No valid session found. sessionId=${sessionId}`);
            twilioWs.close();
            return;
          }
          session.callSid = callSid;
          session.streamSid = streamSid;
          console.log(`Twilio stream started: sessionId=${sessionId}, streamSid=${streamSid}, callSid=${callSid}`);
          connectOpenAI();
          break;
        case "media":
          if (openaiReady && openaiWs?.readyState === WebSocket.OPEN && !session?.transferring) {
            openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: data.media.payload }));
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
    if (openaiWs?.readyState === WebSocket.OPEN) openaiWs.close();
    handleCallEnd(sessionId, callSid);
  });

  twilioWs.on("error", (err) => {
    console.error(`Twilio WebSocket error for session ${sessionId}:`, err.message);
  });
});

async function handleCallEnd(sessionId, callSid) {
  const session = sessions.get(sessionId);
  if (!session || session._ended) return;
  session._ended = true;

  const duration = Math.round((Date.now() - session.createdAt) / 1000);
  const transcriptStr = session.transcript
    .map((t) => `${t.role === "user" ? "לקוח" : "סוכן"}: ${t.text}`).join("\n");

  console.log(`Call ended for session ${sessionId}. Duration: ${duration}s, Transcript length: ${transcriptStr.length}, Transferred: ${session.transferring}`);

  if (SUPABASE_URL && SUPABASE_ANON_KEY && session.callId) {
    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/process-call-result`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          type: "openai-realtime-end",
          callId: session.callId,
          callSid,
          transcript: transcriptStr,
          duration,
          endedReason: session.transferring ? "warm_transfer" : "call_ended",
          warmTransfer: session.transferring || false,
        }),
      });
      if (resp.ok) console.log(`✅ Results posted to Supabase for call ${session.callId}`);
      else console.error(`❌ Failed to post results: ${resp.status} ${await resp.text()}`);
    } catch (err) {
      console.error("❌ Failed to post call results:", err);
    }
  }

  setTimeout(() => sessions.delete(sessionId), 5 * 60 * 1000);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > 2 * 60 * 60 * 1000) sessions.delete(id);
  }
}, 30 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`OpenAI Realtime Bridge Server v3.0.0 running on port ${PORT}`);
  console.log(`Model: gpt-4o-realtime-preview | Health: http://localhost:${PORT}/health`);
});
