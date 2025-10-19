require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// === EXPRESS SERVER ===
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Simple homepage (optional but useful for Render health check)
app.get("/", (req, res) => {
  res.send("✅ TerraCloud WebSocket server is running.");
});

// === WEBSOCKET SERVER ===
const wss = new WebSocket.Server({ server });
console.log(`✅ WebSocket server initialized (port: ${PORT})`);

let writeStream = null;
let conversation = [];
const MAX_HISTORY = 5;
const CONVO_FILE = "conversation.json";

// Load saved conversation if exists
if (fs.existsSync(CONVO_FILE)) {
  try {
    conversation = JSON.parse(fs.readFileSync(CONVO_FILE, "utf-8"));
    console.log("💾 Loaded previous conversation:", conversation.length, "messages");
  } catch (err) {
    console.error("⚠️ Failed to load conversation file:", err);
  }
}

function sendInChunks(ws, buffer, chunkSize = 4096) {
  for (let i = 0; i < buffer.length; i += chunkSize) {
    ws.send(buffer.slice(i, i + chunkSize));
  }
  console.log("✅ TTS audio sent in chunks");
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

// ====== NEWS FUNCTION ======
async function getLatestNews(isTagalog = false, topic = "") {
  try {
    const newsKey = process.env.NEWSDATA_API_KEY;
    const baseUrl = `https://newsdata.io/api/1/news?country=ph&language=en&apikey=${newsKey}`;
    const url = topic ? `${baseUrl}&q=${encodeURIComponent(topic)}` : baseUrl;

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
        { role: "system", content: "You summarize the latest news naturally and conversationally." },
        { role: "user", content: summaryPrompt },
      ],
    });

    const summarizedNews = summary.choices[0].message.content.trim();

    return isTagalog
      ? `📰 Narito ang mga pinakabagong balita sa ${topic || "Pilipinas"}: ${summarizedNews}`
      : `📰 Here’s the latest ${topic || "Philippine"} news: ${summarizedNews}`;
  } catch (err) {
    console.error("📰 News API error:", err);
    return "⚠️ Sorry, I had trouble getting the news.";
  }
}

// ====== WEBSOCKET CONNECTIONS ======
wss.on("connection", ws => {
  console.log("🔗 ESP32 connected");

  ws.assistantVoice = "alloy";
  ws.assistantPrompt = "You are a helpful AI assistant.";

  const waitForConfig = new Promise(resolve => {
    const timeout = setTimeout(resolve, 2000);
    ws.once("message", msg => {
      try {
        const parsed = JSON.parse(msg.toString());
        if (parsed.cmd === "SET_CONFIG") {
          ws.assistantVoice = parsed.voice || "alloy";
          ws.assistantPrompt = parsed.prompt || "You are a helpful AI assistant.";
          console.log(`⚙️ Config received: voice=${ws.assistantVoice}`);
        }
      } catch (_) {}
      clearTimeout(timeout);
      resolve();
    });
  });

  waitForConfig.then(async () => {
    const greetings = [
      "Hey, kamusta ka?",
      "Yo! Need any help?",
      "What’s up? na miss mo ba 'ko?",
      "Hey there! What can I do for you today?",
    ];
    const randomGreeting = greetings[Math.floor(Math.random() * greetings.length)];
    console.log(`💬 Greeting with voice=${ws.assistantVoice}`);
    await speak(ws, randomGreeting);
  });

  ws.on("message", async (data, isBinary) => {
    try {
      if (isBinary) {
        if (writeStream) writeStream.write(data);
        return;
      }

      const msg = data.toString();
      if (msg.startsWith("{") && msg.includes("SET_CONFIG")) return;

      if (msg === "START") {
        console.log("🎬 Start receiving audio...");
        writeStream = fs.createWriteStream("audio.wav");
        return;
      } else if (msg === "END") {
        console.log("🏁 Audio stream ended");
        if (writeStream) writeStream.end();

        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream("audio.wav"),
          model: "whisper-1",
        });

        const userText = transcription.text.trim();
        console.log("📩 Transcribed:", userText);
        ws.send(JSON.stringify({ type: "transcript", text: userText }));

        const lowerText = userText.toLowerCase();
        let reply = "";

        // Weather
        if (lowerText.includes("weather") || lowerText.includes("panahon")) {
          const cityMatch = lowerText.match(/(?:in|sa)\s+([a-zA-Z\s]+)/);
          const city = cityMatch ? cityMatch[1].trim() : "Manila";
          const weatherKey = process.env.WEATHER_API_KEY;

          try {
            const weatherRes = await fetch(
              `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&units=metric&appid=${weatherKey}`
            );
            const weatherData = await weatherRes.json();

            if (weatherData.cod === 200) {
              const desc = weatherData.weather[0].description;
              const temp = weatherData.main.temp;
              const isTagalog = lowerText.includes("panahon");
              reply = isTagalog
                ? `Ang panahon sa ${city} ay ${temp}°C, ${desc}.`
                : `The weather in ${city} is ${desc} with a temperature of ${temp}°C.`;
            } else reply = "⚠️ City not found.";
          } catch {
            reply = "⚠️ Error getting weather data.";
          }
        }

        // News
        else if (lowerText.includes("news") || lowerText.includes("balita")) {
          const isTagalog = lowerText.includes("balita");
          let topic = "";

          if (lowerText.includes("tech")) topic = "technology";
          else if (lowerText.includes("sports")) topic = "sports";
          else if (lowerText.includes("business")) topic = "business";
          else if (lowerText.includes("entertainment")) topic = "entertainment";
          else if (lowerText.includes("politics")) topic = "politics";
          else if (lowerText.includes("teknolohiya")) topic = "technology";
          else if (lowerText.includes("isports") || lowerText.includes("palakasan")) topic = "sports";
          else if (lowerText.includes("negosyo")) topic = "business";
          else if (lowerText.includes("aliwan") || lowerText.includes("libangan")) topic = "entertainment";
          else if (lowerText.includes("politika")) topic = "politics";
          else if (lowerText.includes("pangkalahatan") || lowerText.includes("lahat")) topic = "";

          reply = topic
            ? await getLatestNews(isTagalog, topic)
            : isTagalog
              ? "Anong klaseng balita ang gusto mong marinig — teknolohiya, isports, negosyo, politika, aliwan, o pangkalahatan?"
              : "What kind of news would you like — technology, sports, business, politics, entertainment, or general?";
        }

        // Time awareness
        else if (
          lowerText.includes("time") ||
          lowerText.includes("oras") ||
          lowerText.includes("date") ||
          lowerText.includes("araw")
        ) {
          const now = new Date();
          const phTime = now.toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit" });
          const phDate = now.toLocaleDateString("en-PH", {
            timeZone: "Asia/Manila",
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          });

          const isTagalog = lowerText.includes("oras") || lowerText.includes("araw");
          reply = isTagalog
            ? `Ngayon ay ${phDate}, at ang oras ay ${phTime}.`
            : `It's ${phDate}, and the time is ${phTime}.`;
        }

        // Chat
        else {
          const now = new Date();
          const timeString = now.toLocaleString("en-PH", { timeZone: "Asia/Manila" });
          const gptResponse = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content: `${ws.assistantPrompt}\n\nCurrent date and time: ${timeString} (Philippine local time).`,
              },
              ...conversation,
              { role: "user", content: userText },
            ],
          });
          reply = gptResponse.choices[0].message.content;
        }

        // Maintain conversation history
        conversation.push({ role: "user", content: userText });
        conversation.push({ role: "assistant", content: reply });
        if (conversation.length > MAX_HISTORY * 2)
          conversation = conversation.slice(-MAX_HISTORY * 2);

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
