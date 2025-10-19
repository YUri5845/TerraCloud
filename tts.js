const WebSocket = require("ws");
const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const wss = new WebSocket.Server({ port: 3000 });
console.log("✅ TTS WebSocket server running on ws://localhost:3000");

function sendInChunks(ws, buffer, chunkSize = 4096) {
  for (let i = 0; i < buffer.length; i += chunkSize) {
    ws.send(buffer.slice(i, i + chunkSize));
  }
  console.log("✅ Audio sent in chunks");
}

wss.on("connection", async ws => {
  console.log("🔗 ESP32 connected");

  try {
    // Generate TTS once client connects
    const ttsResponse = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "ash",   // try "verse" or "nova" too
      input: "If you want, I can suggest a wiring setup for ESP32 with a clone PowerBoost 100 safely, so you avoid brownouts. Do you want me to do that?"
    });

    const buffer = Buffer.from(await ttsResponse.arrayBuffer());
    console.log("🔊 Generated TTS (" + buffer.length + " bytes)");

    // Send audio in safe chunks
    sendInChunks(ws, buffer);

  } catch (err) {
    console.error("❌ TTS Error:", err);
    ws.send("TTS generation failed");
  }

  ws.on("close", () => console.log("❌ ESP32 disconnected"));
});
