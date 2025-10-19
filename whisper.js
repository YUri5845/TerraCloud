// server.js
const WebSocket = require("ws");
const fs = require("fs");
const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY // Make sure this is set in your environment
});

const wss = new WebSocket.Server({ port: 3000 });
console.log("✅ WebSocket server running on ws://localhost:3000");

let writeStream = null;

// ====== Conversation memory setup ======
let conversation = [];
const MAX_HISTORY = 5;
const CONVO_FILE = "conversation.json";

// Load conversation if exists
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

// ====== WebSocket logic ======
wss.on("connection", ws => {
  console.log("🔗 Client connected");

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

          // === Transcribe audio ===
          const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream("audio.wav"),
            model: "whisper-1"
          });

          const userText = transcription.text.trim();
          console.log("📩 Transcribed:", userText);
          ws.send(userText);

          const lowerText = userText.toLowerCase();

          // === Detect weather-related question (Tagalog + English) ===
          const isWeatherQuery = (
            lowerText.includes("weather") ||
            lowerText.includes("forecast") ||
            lowerText.includes("panahon") ||
            lowerText.includes("klima")
          );

          if (isWeatherQuery) {
            // Extract city (for both English “in” and Tagalog “sa”)
            const cityMatch = lowerText.match(/(?:in|sa)\s+([a-zA-Z\s]+)/);
            const city = cityMatch ? cityMatch[1].trim() : "Manila"; // Default city

            try {
              const weatherKey = process.env.WEATHER_API_KEY;
              const weatherRes = await fetch(
                `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&units=metric&appid=${weatherKey}`
              );

              const weatherData = await weatherRes.json();
              if (weatherData.cod === 200) {
                const desc = weatherData.weather[0].description;
                const temp = weatherData.main.temp;

                // Detect Tagalog or English
                const isTagalog = lowerText.includes("panahon") || lowerText.includes("klima");

                const reply = isTagalog
                  ? `🌤️ Ang panahon sa ${city} ay ${temp}°C, ${desc}.`
                  : `🌤️ The weather in ${city} is ${desc} with a temperature of ${temp}°C.`;

                console.log("🌦️ Weather reply:", reply);
                ws.send(reply);

                // Save to conversation
                conversation.push(
                  { role: "user", content: userText },
                  { role: "assistant", content: reply }
                );
                saveConversation();
                return; // Stop here (skip GPT)
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

          // === Otherwise, use GPT for general replies ===
          const gptResponse = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: "You are a helpful assistant. Respond in less than 30 words." },
              ...conversation,
              { role: "user", content: userText }
            ]
          });

          const reply = gptResponse.choices[0].message.content;
          console.log("🤖 GPT reply:", reply);
          ws.send(reply);

          // === Update conversation memory ===
          conversation.push(
            { role: "user", content: userText },
            { role: "assistant", content: reply }
          );

          // Keep only recent exchanges
          if (conversation.length > MAX_HISTORY * 2)
            conversation = conversation.slice(-MAX_HISTORY * 2);

          saveConversation();
        }
      } else {
        // Binary data = audio chunk
        if (writeStream) writeStream.write(data);
      }
    } catch (err) {
      console.error("❌ Error:", err);
      ws.send("Error processing audio or GPT request");
    }
  });

  ws.on("close", () => {
    console.log("❌ Client disconnected");
  });
});
