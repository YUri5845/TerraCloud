require("dotenv").config();
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

// ====== Deepgram STT helper ======
async function transcribeWithDeepgram(filePath) {
  try {
    const audioBuffer = fs.readFileSync(filePath);

    const response = await fetch("https://api.deepgram.com/v1/listen", {
      method: "POST",
      headers: {
        "Authorization": `Token ${process.env.DEEPGRAM_API_KEY}`,
        "Content-Type": "audio/wav"
      },
      body: audioBuffer
    });

    const result = await response.json();
    return result.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || "";
  } catch (err) {
    console.error("❌ Deepgram STT error:", err);
    return "";
  }
}

// ====== TTS helper ======
async function speak(ws, text) {
  try {
    const ttsResponse = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "ash",
      input: text,
    });

    const buffer = Buffer.from(await ttsResponse.arrayBuffer());
    const filePath = path.join(__dirname, "tts.mp3");
    fs.writeFileSync(filePath, buffer);

    sendAudioInChunks(ws, filePath);
    return true;
  } catch (err) {
    console.error("❌ TTS generation error:", err.response?.data || err);
    try { ws.send("TTS generation failed"); } catch (e) {}
    return false;
  }
}

// ====== Send audio chunks ======
function sendAudioInChunks(ws, filePath, chunkSize = 4096) {
  const audioBuffer = fs.readFileSync(filePath);
  for (let i = 0; i < audioBuffer.length; i += chunkSize) {
    ws.send(audioBuffer.slice(i, i + chunkSize));
  }
  console.log(`✅ Audio sent to ESP32 in chunks (${audioBuffer.length} bytes)`);
}

// ====== WebSocket logic ======
wss.on("connection", ws => {
  console.log("🔗 ESP32 connected");

  ws.on("message", async (data, isBinary) => {
    try {
      if (!isBinary) {
        const msg = data.toString();

        if (msg === "START") {
          console.log("🎬 Start receiving audio...");
          writeStream = fs.createWriteStream("audio.wav");
        } else if (msg === "END") {
          console.log("🏁 Audio stream ended");
          if (writeStream) writeStream.end();

          // --- Deepgram transcription ---
          const userText = await transcribeWithDeepgram("audio.wav");
          console.log("📩 Transcribed:", userText);
          ws.send(userText);

          const lowerText = userText.toLowerCase();

          // --- Weather detection ---
          const isWeatherQuery = (
            lowerText.includes("weather") ||
            lowerText.includes("forecast") ||
            lowerText.includes("panahon") ||
            lowerText.includes("klima")
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

                const reply = isTagalog
                  ? `🌤️ Ang panahon sa ${city} ay ${temp}°C, ${desc}.`
                  : `🌤️ The weather in ${city} is ${desc} with a temperature of ${temp}°C.`;

                console.log("🌦️ Weather reply:", reply);
                ws.send(reply);
                await speak(ws, reply);

                conversation.push(
                  { role: "user", content: userText },
                  { role: "assistant", content: reply }
                );
                saveConversation();
                return;
              } else {
                ws.send("⚠️ Sorry, I couldn't find the weather for that city.");
                return;
              }
            } catch (err) {
              console.error("🌩️ Weather API error:", err);
              ws.send("⚠️ Sorry, I had trouble getting the weather data.");
              return;
            }
          }

          // --- General GPT reply ---
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


          const reply = gptResponse.choices[0].message.content;
          console.log("🤖 GPT reply:", reply);
          ws.send(reply);
          await speak(ws, reply);

          // --- Update conversation memory ---
          conversation.push(
            { role: "user", content: userText },
            { role: "assistant", content: reply }
          );

          if (conversation.length > MAX_HISTORY * 2)
            conversation = conversation.slice(-MAX_HISTORY * 2);

          saveConversation();
        }
      } else if (writeStream) {
        writeStream.write(data);
      }
    } catch (err) {
      console.error("❌ Error:", err);
      ws.send("Error processing audio or GPT request");
    }
  });

  ws.on("close", () => console.log("❌ ESP32 disconnected"));
});
