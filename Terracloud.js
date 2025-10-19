require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// === EXPRESS + WEBSOCKET SERVER ===
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.send("✅ TerraCloud WebSocket server is live!");
});

const wss = new WebSocket.Server({ server });
console.log(`✅ WebSocket server initialized (port: ${PORT})`);

let conversation = [];
const MAX_HISTORY = 5;
const CONVO_FILE = "conversation.json";

if (fs.existsSync(CONVO_FILE)) {
  try {
    conversation = JSON.parse(fs.readFileSync(CONVO_FILE, "utf-8"));
    console.log(`💾 Loaded ${conversation.length} previous messages`);
  } catch (err) {
    console.error("⚠️ Failed to load conversation:", err);
  }
}

// === Send audio in chunks with pacing ===
async function sendInChunks(ws, buffer, chunkSize = 4096, delayMs = 10) {
  console.log("🔊 Sending audio in chunks...");
  for (let i = 0; i < buffer.length; i += chunkSize) {
    const chunk = buffer.slice(i, i + chunkSize);
    ws.send(chunk, { binary: true });
    await new Promise((r) => setTimeout(r, delayMs)); // give ESP32 time to flush
  }
  ws.send("DONE"); // signal ESP that playback is complete
  console.log("✅ Finished sending MP3 data");
}

// === Text-to-Speech (TTS) ===
async function speak(ws, text) {
  try {
    const ttsResponse = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: ws.assistantVoice || "alloy",
      input: text,
    });
    const buffer = Buffer.from(await ttsResponse.arrayBuffer());
    ws.send("PROCESSING");
    await sendInChunks(ws, buffer);
  } catch (err) {
    console.error("❌ TTS error:", err);
  }
}

// === News Fetcher ===
async function getLatestNews(isTagalog = false, topic = "") {
  try {
    const key = process.env.NEWSDATA_API_KEY;
    if (!key) return "⚠️ Missing News API key in environment.";
    const base = `https://newsdata.io/api/1/news?country=ph&language=en&apikey=${key}`;
    const url = topic ? `${base}&q=${encodeURIComponent(topic)}` : base;

    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== "success" || !data.results?.length)
      return isTagalog
        ? `⚠️ Walang balita tungkol sa ${topic || "Pilipinas"} ngayon.`
        : `⚠️ No news found about ${topic || "the Philippines"}.`;

    const headlines = data.results.slice(0, 5).map(a => a.title).join("\n");
    const summaryPrompt = isTagalog
      ? `Gumawa ng buod sa Filipino ng mga headline na ito (${topic || "pangkalahatang balita"}). Tatlong pangungusap lang:\n${headlines}`
      : `Summarize these ${topic || "general"} Philippine news headlines into 3 short sentences:\n${headlines}`;

    const summary = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Summarize news naturally and conversationally." },
        { role: "user", content: summaryPrompt },
      ],
    });

    const text = summary.choices[0].message.content.trim();
    return isTagalog
      ? `📰 Narito ang mga pinakabagong balita: ${text}`
      : `📰 Latest news: ${text}`;
  } catch (err) {
    console.error("📰 News error:", err);
    return "⚠️ Could not fetch news.";
  }
}

// === WebSocket Handling ===
wss.on("connection", (ws) => {
  console.log("🔗 ESP32 connected");

  ws.assistantVoice = "ash";
  ws.assistantPrompt = "You are a helpful AI assistant.";
  let writeStream = null;

  ws.on("message", async (data, isBinary) => {
    try {
      // === Binary (Audio) ===
      if (isBinary) {
        if (writeStream) writeStream.write(data);
        return;
      }

      // === Text Messages ===
      const msg = data.toString();

      // --- Config ---
      if (msg.startsWith("{\"cmd\":\"SET_CONFIG\"")) {
        const config = JSON.parse(msg);
        ws.assistantVoice = config.voice;
        ws.assistantPrompt = config.prompt;
        ws.send("CONFIG_OK");
        console.log("⚙️ Assistant config updated:", ws.assistantVoice);
        return;
      }

      if (msg === "START") {
        writeStream = fs.createWriteStream("audio.wav");
        console.log("🎙️ Receiving audio...");
        return;
      }

      if (msg === "END") {
        if (writeStream) writeStream.end();
        console.log("🎧 Audio upload complete");

        // 🔊 Tell ESP we’re processing
        ws.send("PROCESSING");

        // === Whisper Transcription ===
        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream("audio.wav"),
          model: "whisper-1",
        });
        const userText = transcription.text.trim();
        console.log("📥 User said:", userText);

        let reply = "";
        const lower = userText.toLowerCase();

        // --- Intent: Weather ---
        if (lower.includes("weather") || lower.includes("panahon")) {
          const match = lower.match(/(?:in|sa)\s+([a-zA-Z\s]+)/);
          const city = match ? match[1].trim() : "Manila";
          const key = process.env.WEATHER_API_KEY;

          if (!key) reply = "⚠️ Missing weather API key.";
          else {
            const r = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&units=metric&appid=${key}`);
            const json = await r.json();
            if (json.cod === 200) {
              const desc = json.weather[0].description;
              const temp = json.main.temp;
              reply = lower.includes("panahon")
                ? `Ang panahon sa ${city} ay ${temp}°C at ${desc}.`
                : `The weather in ${city} is ${desc} with ${temp}°C.`;
            } else reply = "⚠️ City not found.";
          }
        }

        // --- Intent: News ---
        else if (lower.includes("news") || lower.includes("balita")) {
          const isTagalog = lower.includes("balita");
          const topics = { tech: "technology", sports: "sports", business: "business", entertainment: "entertainment", politics: "politics" };
          const found = Object.entries(topics).find(([key, val]) => lower.includes(key) || lower.includes(val));
          reply = await getLatestNews(isTagalog, found ? found[1] : "");
        }

        // --- Default: ChatGPT ---
        else {
          const now = new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" });
          const gpt = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: `${ws.assistantPrompt}\nCurrent date/time: ${now}` },
              ...conversation,
              { role: "user", content: userText },
            ],
          });
          reply = gpt.choices[0].message.content.trim();
        }

        // Save convo
        conversation.push({ role: "user", content: userText });
        conversation.push({ role: "assistant", content: reply });
        if (conversation.length > MAX_HISTORY * 2)
          conversation = conversation.slice(-MAX_HISTORY * 2);
        fs.writeFileSync(CONVO_FILE, JSON.stringify(conversation, null, 2));

        console.log("🤖 Reply:", reply);

        // Send TTS response
        await speak(ws, reply);

        ws.send("DONE"); // ✅ signal ESP that everything finished
      }
    } catch (err) {
      console.error("❌ Error:", err);
      ws.send("ERROR");
    }
  });

  ws.on("close", () => console.log("❌ ESP32 disconnected"));
});

// === START SERVER ===
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
