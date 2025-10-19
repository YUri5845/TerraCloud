require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// === EXPRESS + WEBSOCKET SERVER (Render HTTPS auto-handles SSL) ===
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

// ✅ Health check route for Render
app.get("/", (req, res) => {
  res.send("✅ TerraCloud WebSocket server is live and ready!");
});

// === WEBSOCKET SERVER (handles wss://terracloud.onrender.com) ===
const wss = new WebSocket.Server({ server });
console.log(`✅ WebSocket server initialized (port: ${PORT})`);

let writeStream = null;
let conversation = [];
const MAX_HISTORY = 5;
const CONVO_FILE = "conversation.json";

// === Load previous conversation ===
if (fs.existsSync(CONVO_FILE)) {
  try {
    conversation = JSON.parse(fs.readFileSync(CONVO_FILE, "utf-8"));
    console.log(`💾 Loaded ${conversation.length} previous messages`);
  } catch (err) {
    console.error("⚠️ Failed to load conversation:", err);
  }
}

// === Send TTS audio in chunks ===
function sendInChunks(ws, buffer, chunkSize = 4096) {
  for (let i = 0; i < buffer.length; i += chunkSize) {
    ws.send(buffer.slice(i, i + chunkSize));
  }
  console.log("🔊 Sent TTS audio in chunks");
}

async function speak(ws, text) {
  try {
    const ttsResponse = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: ws.assistantVoice || "alloy",
      input: text,
    });
    const buffer = Buffer.from(await ttsResponse.arrayBuffer());
    sendInChunks(ws, buffer);
  } catch (err) {
    console.error("❌ TTS error:", err);
  }
}

// === Fetch Latest News ===
async function getLatestNews(isTagalog = false, topic = "") {
  try {
    const key = process.env.NEWSDATA_API_KEY;
    const base = `https://newsdata.io/api/1/news?country=ph&language=en&apikey=${key}`;
    const url = topic ? `${base}&q=${encodeURIComponent(topic)}` : base;

    const response = await fetch(url);
    const data = await response.json();
    if (data.status !== "success" || !data.results?.length)
      return isTagalog
        ? `⚠️ Pasensya na, wala akong mahanap na balita tungkol sa ${topic || "Pilipinas"} ngayon.`
        : `⚠️ Sorry, I couldn’t find any news about ${topic || "the Philippines"} right now.`;

    const headlines = data.results.slice(0, 5).map(a => a.title).join("\n");

    const summaryPrompt = isTagalog
      ? `Gumawa ng maikling buod sa Filipino tungkol sa mga headline na ito (${topic || "pangkalahatang balita"}). Tatlong pangungusap lang:\n${headlines}`
      : `Summarize these Philippine ${topic || "general"} news headlines into a short, natural paragraph (max 3 sentences):\n${headlines}`;

    const summary = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You summarize news naturally and conversationally." },
        { role: "user", content: summaryPrompt },
      ],
    });

    return isTagalog
      ? `📰 Narito ang mga pinakabagong balita sa ${topic || "Pilipinas"}: ${summary.choices[0].message.content.trim()}`
      : `📰 Here’s the latest ${topic || "Philippine"} news: ${summary.choices[0].message.content.trim()}`;
  } catch (err) {
    console.error("📰 News API error:", err);
    return "⚠️ Sorry, I had trouble getting the news.";
  }
}

// === WebSocket Handling ===
wss.on("connection", (ws) => {
  console.log("🔗 ESP32 connected");

  ws.assistantVoice = "alloy";
  ws.assistantPrompt = "You are a helpful AI assistant.";

  ws.on("message", async (data, isBinary) => {
    try {
      if (isBinary) {
        if (writeStream) writeStream.write(data);
        return;
      }

      const msg = data.toString();
      if (msg === "START") {
        writeStream = fs.createWriteStream("audio.wav");
        console.log("🎙️ Receiving audio...");
        return;
      }
      if (msg === "END") {
        if (writeStream) writeStream.end();
        console.log("🎧 Audio capture done");

        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream("audio.wav"),
          model: "whisper-1",
        });

        const userText = transcription.text.trim();
        console.log("📥 Transcribed:", userText);
        ws.send(JSON.stringify({ type: "transcript", text: userText }));

        let reply = "";
        const lower = userText.toLowerCase();

        // 🧠 Simple Intent Detection
        if (lower.includes("weather") || lower.includes("panahon")) {
          const cityMatch = lower.match(/(?:in|sa)\s+([a-zA-Z\s]+)/);
          const city = cityMatch ? cityMatch[1].trim() : "Manila";
          const key = process.env.WEATHER_API_KEY;
          try {
            const res = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&units=metric&appid=${key}`);
            const json = await res.json();
            if (json.cod === 200) {
              const desc = json.weather[0].description;
              const temp = json.main.temp;
              reply = lower.includes("panahon")
                ? `Ang panahon sa ${city} ay ${temp}°C, ${desc}.`
                : `The weather in ${city} is ${desc} with a temperature of ${temp}°C.`;
            } else reply = "⚠️ City not found.";
          } catch {
            reply = "⚠️ Error getting weather data.";
          }
        } else if (lower.includes("news") || lower.includes("balita")) {
          const isTagalog = lower.includes("balita");
          const topics = { tech: "technology", sports: "sports", business: "business", entertainment: "entertainment", politics: "politics" };
          const found = Object.entries(topics).find(([key, val]) => lower.includes(key) || lower.includes(val));
          reply = await getLatestNews(isTagalog, found ? found[1] : "");
        } else {
          const now = new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" });
          const gpt = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: `${ws.assistantPrompt}\nCurrent date/time: ${now}` },
              ...conversation,
              { role: "user", content: userText },
            ],
          });
          reply = gpt.choices[0].message.content;
        }

        conversation.push({ role: "user", content: userText });
        conversation.push({ role: "assistant", content: reply });
        if (conversation.length > MAX_HISTORY * 2) conversation = conversation.slice(-MAX_HISTORY * 2);
        fs.writeFileSync(CONVO_FILE, JSON.stringify(conversation, null, 2));

        console.log("🤖 Reply:", reply);
        await speak(ws, reply);
      }
    } catch (err) {
      console.error("❌ Error:", err);
    }
  });

  ws.on("close", () => console.log("❌ ESP32 disconnected"));
});

// === START SERVER ===
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
