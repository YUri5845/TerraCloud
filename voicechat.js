require("dotenv").config();
const WebSocket = require("ws");
const fs = require("fs");
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const OpenAI = require("openai");
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const wss = new WebSocket.Server({ port: 3000 });
console.log("✅ WebSocket server running on ws://localhost:3000");

let writeStream = null;

// ====== Conversation memory ======
let conversation = [];
const MAX_HISTORY = 5;
const CONVO_FILE = "conversation.json";

if (fs.existsSync(CONVO_FILE)) {
  try {
    conversation = JSON.parse(fs.readFileSync(CONVO_FILE, "utf-8"));
    console.log("💾 Loaded previous conversation:", conversation.length, "messages");
  } catch (err) {
    console.error("⚠️ Failed to load conversation file:", err);
    conversation = [];
  }
}

function saveConversation() {
  try {
    fs.writeFileSync(CONVO_FILE, JSON.stringify(conversation, null, 2));
  } catch (err) {
    console.error("⚠️ Failed to save conversation:", err);
  }
}

// ====== Send audio buffer in chunks ======
function sendInChunks(ws, buffer, chunkSize = 4096) {
  for (let i = 0; i < buffer.length; i += chunkSize) {
    ws.send(buffer.slice(i, i + chunkSize));
  }
  console.log("✅ TTS audio sent in chunks");
}

// ====== TTS helper (single source of truth for model/voice/send) ======
async function speak(ws, text) {
  try {
    const ttsResponse = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "ash",
      input: text,
    });
    const buffer = Buffer.from(await ttsResponse.arrayBuffer());
    sendInChunks(ws, buffer);
    return true;
  } catch (err) {
    console.error("❌ TTS generation error (speak):", err);
    try { ws.send("TTS generation failed"); } catch (e) { /* ignore */ }
    return false;
  }
}

// ====== Fetch Latest News (Topic-Aware + GPT Summary) ======
async function getLatestNews(isTagalog = false, topic = "") {
  try {
    const newsKey = process.env.NEWSDATA_API_KEY;
    const baseUrl = `https://newsdata.io/api/1/news?country=ph&language=en&apikey=${newsKey}`;
    const url = topic ? `${baseUrl}&q=${encodeURIComponent(topic)}` : baseUrl;

    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== "success" || !data.results?.length) {
      console.log("⚠️ NewsData API returned no results:", data);
      return isTagalog
        ? `⚠️ Pasensya na, wala akong mahanap na balita tungkol sa ${topic || "Pilipinas"} ngayon.`
        : `⚠️ Sorry, I couldn’t find any news about ${topic || "the Philippines"} right now.`;
    }

    // Get top 5 headlines
    const headlines = data.results.slice(0, 5).map(a => a.title).join("\n");

    // Summarize using GPT
    const summaryPrompt = isTagalog
      ? `Gumawa ng maikling buod sa Filipino tungkol sa mga headline na ito (${topic || "pangkalahatang balita"}). Tatlong pangungusap lang:\n${headlines}`
      : `Summarize these Philippine ${topic || "general"} news headlines into a short, natural paragraph (max 3 sentences):\n${headlines}`;

    const summary = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You summarize the latest news naturally and conversationally." },
        { role: "user", content: summaryPrompt }
      ]
    });

    const summarizedNews = summary.choices[0].message.content.trim();

    return isTagalog
      ? `📰 Narito ang mga pinakabagong balita sa ${topic || "Pilipinas"}: ${summarizedNews}`
      : `📰 Here’s the latest ${topic || "Philippine"} news: ${summarizedNews}`;
  } catch (err) {
    console.error("📰 NewsData API error:", err);
    return "⚠️ Sorry, I had trouble getting the news.";
  }
}

// ====== WebSocket logic ======
wss.on("connection", async ws => {
  console.log("🔗 ESP32 connected");

  // === Default random greetings when ESP connects ===
  const greetings = [
    "Hey, kamusta ka?",
    "Yo! Need any help?",
    "What’s up? na miss mo ba 'ko?.",
    "Hey there! What can I do for you today?",
    "Sup! Wanna talk about something cool?",
    "Hey hey! Do you need help with anything?"
  ];

  const randomGreeting = greetings[Math.floor(Math.random() * greetings.length)];
  console.log("🎙️ Sending greeting:", randomGreeting);

  // Use the helper speak() so greeting stays in sync with main TTS
  await speak(ws, randomGreeting);

  // === Handle ESP32 messages ===
  ws.on("message", async (data, isBinary) => {
    try {
      if (!isBinary) {
        const msg = data.toString();

        if (msg === "START") {
          console.log("🎬 Start receiving audio...");
          writeStream = fs.createWriteStream("audio.wav");
        } 
        else if (msg === "END") {
          console.log("🏁 Audio stream ended");
          if (writeStream) writeStream.end();

          // === Transcribe audio using Whisper ===
          const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream("audio.wav"),
            model: "whisper-1"
          });

          const userText = transcription.text.trim();
          console.log("📩 Transcribed:", userText);

          const lowerText = userText.toLowerCase();
          let reply = "";

          // === Detect weather-related question ===
          const isWeatherQuery = (
            lowerText.includes("weather") ||
            lowerText.includes("forecast") ||
            lowerText.includes("panahon") ||
            lowerText.includes("klima")
          );

          // === Detect news-related question ===
          const isNewsQuery = (
            lowerText.includes("news") ||
            lowerText.includes("balita") ||
            lowerText.includes("headlines")
          );

          if (isWeatherQuery) {
            const cityMatch = lowerText.match(/(?:in|sa)\s+([a-zA-Z\s]+)/);
            const city = cityMatch ? cityMatch[1].trim() : "Manila";

            try {
              const weatherKey = process.env.WEATHER_API_KEY;
              const weatherRes = await fetch(
                `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&units=metric&appid=${weatherKey}`
              );
              const weatherData = await weatherRes.json();

              if (weatherData.cod === 200) {
                const desc = weatherData.weather[0].description;
                const temp = weatherData.main.temp;
                const isTagalog = lowerText.includes("panahon") || lowerText.includes("klima");
                reply = isTagalog
                  ? `Ang panahon sa ${city} ay ${temp}°C, ${desc}.`
                  : `The weather in ${city} is ${desc} with a temperature of ${temp}°C.`;

                conversation.push({ role: "user", content: userText }, { role: "assistant", content: reply });
                saveConversation();
              } else {
                reply = "⚠️ Sorry, I couldn't find the weather for that city.";
              }
            } catch (err) {
              console.error("🌩️ Weather API error:", err);
              reply = "⚠️ Sorry, I had trouble getting the weather data.";
            }
          }

          // === Handle News Queries (Enhanced) ===
          else if (isNewsQuery) {
            const isTagalog = lowerText.includes("balita");

            let topic = "";
            if (lowerText.includes("technology") || lowerText.includes("tech")) topic = "technology";
            else if (lowerText.includes("sports") || lowerText.includes("palakasan")) topic = "sports";
            else if (lowerText.includes("business") || lowerText.includes("negosyo")) topic = "business";
            else if (lowerText.includes("entertainment") || lowerText.includes("showbiz")) topic = "entertainment";
            else if (lowerText.includes("politics") || lowerText.includes("politika")) topic = "politics";
            else if (lowerText.includes("science")) topic = "science";
            else if (lowerText.includes("health") || lowerText.includes("kalusugan")) topic = "health";

            if (!topic) {
              reply = isTagalog
                ? "Anong klaseng balita ang gusto mong marinig — teknolohiya, sports, negosyo, o pangkalahatan?"
                : "What kind of news would you like — technology, sports, business, or general?";
            } else {
              reply = await getLatestNews(isTagalog, topic);
            }

            conversation.push({ role: "user", content: userText }, { role: "assistant", content: reply });
            saveConversation();
          }

          // === Regular ChatGPT reply ===
          else {
            const gptResponse = await openai.chat.completions.create({
              model: "gpt-4o-mini",
              messages: [
                { role: "system", content: "you are a gen z guy that always use filler words. If they ask who made you, you were made by John Lloyd Figuracion, a college student in Asian Institute of Computer Studies. His mother is Evelyn or Ebang (stubborn but pretty) and his father is Percival or Baldo (talkative but hardworking). Always respond in less than 30 words without emojis." },
                ...conversation,
                { role: "user", content: userText }
              ]
            });

            reply = gptResponse.choices[0].message.content;
            conversation.push({ role: "user", content: userText }, { role: "assistant", content: reply });
            if (conversation.length > MAX_HISTORY * 2) conversation = conversation.slice(-MAX_HISTORY * 2);
            saveConversation();
          }

          console.log("🤖 Reply:", reply);

          // === Generate TTS from reply using speak() helper ===
          await speak(ws, reply);

        } else {
          console.log("💬 Message:", msg);
        }
      } else {
        if (writeStream) writeStream.write(data);
      }
    } catch (err) {
      console.error("❌ Error:", err);
      try { ws.send("Error processing request"); } catch (e) { /* ignore */ }
    }
  });

  ws.on("close", () => console.log("❌ ESP32 disconnected"));
});
