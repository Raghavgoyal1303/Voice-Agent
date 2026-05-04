require('dotenv').config();
const express = require('express');
const Groq = require('groq-sdk');
const { createClient } = require('@deepgram/sdk');
const WebSocket = require('ws');
const http = require('http');
const axios = require('axios');

const MURF_API_KEY = process.env.MURF_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

const groq = new Groq({ apiKey: GROQ_API_KEY });
const deepgram = createClient(DEEPGRAM_API_KEY);
const AGENT_PROFILES = require('./agents.config');

const app = express();
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Support for Twilio Outbound/Inbound calls
app.post('/inbound', (req, res) => {
  const agent = req.query.agent || 'ken';
  const host = req.get('host');
  const protocol = req.protocol === 'https' ? 'wss' : 'ws';
  
  res.type('text/xml');
  res.send(`
    <Response>
      <Connect>
        <Stream url="${protocol}://${host}/stream?agent=${agent}" />
      </Connect>
    </Response>
  `);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/stream' });

const conversations = new Map();

async function streamMurfAudioToBrowser(text, ws, voiceId) {
  return new Promise(async (resolve, reject) => {
    try {
      const data = {
        voiceId: voiceId || 'en-US-ken', 
        style: 'Conversational',
        text: text,
        format: 'PCM',
        sampleRate: 24000,
        model: 'FALCON',
        channelType: 'MONO'
      };

      console.time('Murf TTFA (' + text.substring(0, 10) + '...)');
      
      const res = await axios.post('https://api.murf.ai/v1/speech/stream', data, {
        headers: {
          'Content-Type': 'application/json',
          'api-key': MURF_API_KEY
        },
        responseType: 'stream'
      });

      let firstChunk = true;
      let leftoverByte = null;

      res.data.on('data', (chunk) => {
        if (firstChunk) {
          console.timeEnd('Murf TTFA (' + text.substring(0, 10) + '...)');
          firstChunk = false;
        }

        if (ws.readyState === WebSocket.OPEN) {
          let bufferToSend = chunk;
          
          // If we had a leftover byte from the previous chunk, prepend it
          if (leftoverByte !== null) {
            bufferToSend = Buffer.concat([Buffer.from([leftoverByte]), chunk]);
            leftoverByte = null;
          }

          // 16-bit PCM must be sent in even-numbered byte chunks.
          // If this chunk is odd, save the last byte for the next message.
          if (bufferToSend.length % 2 !== 0) {
            leftoverByte = bufferToSend[bufferToSend.length - 1];
            bufferToSend = bufferToSend.slice(0, bufferToSend.length - 1);
          }

          if (bufferToSend.length > 0) {
            ws.send(bufferToSend);
          }
        }
      });

      res.data.on('end', () => resolve());
      res.data.on('error', (err) => reject(err));

    } catch (error) {
      console.error('Murf AI error:', error.response ? error.response.status : error.message);
      resolve();
    }
  });
}

wss.on('connection', (ws, req) => {
  // Extract agent name from URL (e.g. /stream?agent=marco)
  const urlParams = new URLSearchParams(req.url.split('?')[1]);
  const agentKey = urlParams.get('agent') || 'ken';
  const profile = AGENT_PROFILES[agentKey] || AGENT_PROFILES.ken;

  console.log(`🎙️ Browser stream connected - Agent: ${profile.name} (${profile.language})`);

  let callSid = 'web_' + Date.now();
  let isProcessing = false;
  let deepgramLive = null;
  let audioQueue = [];
  let silenceTimer = null;
  let nudgeCount = 0;
  conversations.set(callSid, []);

  const resetSilenceTimer = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(async () => {
      if (!isProcessing && ws.readyState === WebSocket.OPEN) {
        nudgeCount++;
        
        if (nudgeCount >= 3) {
          const goodbye = "Since I haven't heard from you, I'll end the call now. Goodbye!";
          console.log('🛑 3 strikes reached. Ending call...');
          await streamMurfAudioToBrowser(goodbye, ws);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'transcript', role: 'agent', text: goodbye }));
            setTimeout(() => ws.close(), 2000);
          }
          return;
        }

        const nudge = profile.language.startsWith('it') ? "Ci sei ancora?" : "Are you still there?";
        console.log(`💤 Silence detected (Nudge ${nudgeCount}/3)...`);
        await streamMurfAudioToBrowser(nudge, ws, profile.voiceId);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'transcript', role: 'agent', text: nudge }));
        }
      }
    }, 20000); // 20 seconds of silence
  };

  const setupDeepgram = () => {
    deepgramLive = deepgram.listen.live({
      model: 'nova-2',
      language: profile.language, 
      punctuate: true,
      interim_results: false,
      endpointing: 1000, 
      smart_format: true
    });

    deepgramLive.on('open', () => {
      console.log('✅ Deepgram ready');
      while (audioQueue.length > 0) {
        deepgramLive.send(audioQueue.shift());
      }
    });

    deepgramLive.on('Results', async (data) => {
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      if (!transcript || transcript.trim().length < 2 || isProcessing) return;

      console.log('🗣️ User said:', transcript);
      nudgeCount = 0; // Reset strikes when user speaks
      if (silenceTimer) clearTimeout(silenceTimer); // Stop timer while AI is thinking/speaking
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'transcript', role: 'user', text: transcript }));
      }
      isProcessing = true;

      try {
        const history = conversations.get(callSid) || [];
        history.push({ role: 'user', content: transcript });

        // Keep history short to prevent AI confusion/hallucination
        const recentHistory = history.slice(-5);

        const stream = await groq.chat.completions.create({
          model: 'llama-3.1-8b-instant', // Fast model
          messages: [
            {
              role: 'system',
              content: profile.systemPrompt
            },
            ...recentHistory
          ],
          max_tokens: 80,
          stream: true
        });

        console.time('Groq TTFT');
        let currentSentence = '';
        let fullReply = '';
        let firstToken = true;

        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || '';
          if (firstToken && content) {
            console.timeEnd('Groq TTFT');
            firstToken = false;
          }
          
          currentSentence += content;
          fullReply += content;

          if (/[।?!,]/.test(content)) {
            const textToSpeak = currentSentence.trim();
            if (textToSpeak.length > 0) {
              await streamMurfAudioToBrowser(textToSpeak, ws, profile.voiceId);
              currentSentence = '';
            }
          }
        }

        const finalChunk = currentSentence.trim();
        if (finalChunk.length > 0) {
          await streamMurfAudioToBrowser(finalChunk, ws, profile.voiceId);
        }
        resetSilenceTimer(); // Reset timer after AI finishes speaking
        console.log(`🤖 ${profile.name}:`, fullReply);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'transcript', role: 'agent', text: fullReply, agentName: profile.name }));
        }
        history.push({ role: 'assistant', content: fullReply });
        conversations.set(callSid, history);

      } catch (err) {
        console.error('❌ Error:', err.message);
      } finally {
        isProcessing = false;
      }
    });

    deepgramLive.on('error', (err) => console.error('Deepgram error:', err));
    deepgramLive.on('close', () => console.log('Deepgram closed'));
  };

  ws.on('message', (message, isBinary) => {
    if (isBinary) {
      if (deepgramLive) {
        if (deepgramLive.getReadyState() === 1) {
          deepgramLive.send(message);
        } else {
          audioQueue.push(message);
        }
      }
    } else {
      try {
        const data = JSON.parse(message.toString());
        if (data.type === 'start') {
          console.log('📞 Stream started');
          setupDeepgram();
          resetSilenceTimer(); // Start timer on call start
          const greeting = profile.language.startsWith('it') 
            ? `Ciao! Sono ${profile.name} di Elite English. Ti piacerebbe imparare l'inglese in modo veloce e divertente?`
            : "Hello, thanks for calling! How can I help you today?";
          streamMurfAudioToBrowser(greeting, ws, profile.voiceId)
            .then(() => resetSilenceTimer()); 
        } else if (data.type === 'stop') {
          deepgramLive?.finish();
        }
      } catch (e) {}
    }
  });

  ws.on('close', () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    deepgramLive?.finish();
    console.log('📵 Browser disconnected');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Web Dialer Agent running on port ${PORT}`);
});