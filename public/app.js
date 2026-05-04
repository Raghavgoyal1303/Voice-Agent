const btnCall = document.getElementById('btn-call');
const btnEnd = document.getElementById('btn-end');
const statusDiv = document.getElementById('status');
const appContainer = document.getElementById('app-container');
const transcriptDiv = document.getElementById('transcript');

let ws;
let mediaRecorder;
let audioContext;
let nextPlayTime = 0;
let ringtoneAudio;

// Prepare Ringtone
function playRingtone() {
    ringtoneAudio = new Audio('https://www.soundjay.com/phone/phone-calling-1.mp3');
    ringtoneAudio.loop = true;
    ringtoneAudio.play();
}

function stopRingtone() {
    if (ringtoneAudio) {
        ringtoneAudio.pause();
        ringtoneAudio = null;
    }
}

// Dynamic Agent Selection
const urlParams = new URLSearchParams(window.location.search);
const currentAgent = urlParams.get('agent') || 'ken';

// Update UI Title
document.querySelector('h1').innerText = currentAgent.charAt(0).toUpperCase() + currentAgent.slice(1);

btnCall.onclick = async () => {
    try {
        statusDiv.innerText = 'Requesting microphone...';
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            } 
        });

        if (currentAgent === 'giulia') {
            statusDiv.innerText = 'Calling...';
            playRingtone();
            await new Promise(resolve => setTimeout(resolve, 4000)); // Ring for 4 seconds
            stopRingtone();
        }

        statusDiv.innerText = 'Connecting...';

        // Initialize Audio Context for PCM playback (24000Hz to match Murf output)
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
        nextPlayTime = audioContext.currentTime;

        // Connect directly to our Node.js WebSocket server with the agent parameter
        const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
        ws = new WebSocket(protocol + window.location.host + `/stream?agent=${currentAgent}`);
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
            statusDiv.innerText = 'Call Active (Ultra-HD)';
            appContainer.classList.add('active-call');
            btnCall.style.display = 'none';
            btnEnd.style.display = 'inline-block';
            transcriptDiv.innerHTML = ''; // Clear previous transcript

            ws.send(JSON.stringify({ type: 'start' }));

            // Start recording and sending mic audio chunks every 100ms for snappier STT
            mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
                    ws.send(event.data); 
                }
            };
            mediaRecorder.start(100);
        };

        ws.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
                // We received raw 16-bit PCM audio from Murf AI via agent.js
                const int16Data = new Int16Array(event.data);
                const float32Data = new Float32Array(int16Data.length);
                
                // Convert Int16 to Float32 for the Web Audio API
                for (let i = 0; i < int16Data.length; i++) {
                    float32Data[i] = int16Data[i] / 32768.0;
                }

                // Create audio buffer and schedule seamless playback
                const audioBuffer = audioContext.createBuffer(1, float32Data.length, 24000);
                audioBuffer.getChannelData(0).set(float32Data);

                const source = audioContext.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(audioContext.destination);

                // Ensure smooth continuous playback without overlapping chunks
                const currentTime = audioContext.currentTime;
                if (nextPlayTime < currentTime) {
                    // Add a tiny 100ms buffer to the very first chunk to prevent clipping the first word
                    nextPlayTime = currentTime + 0.1;
                }
                
                source.start(nextPlayTime);
                nextPlayTime += audioBuffer.duration;
            } else {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'transcript') {
                        addTranscript(data.role, data.text, data.agentName);
                    }
                } catch (e) {
                    console.error('Error parsing transcript:', e);
                }
            }
        };

        ws.onclose = () => {
            endCall();
        };

        ws.onerror = (error) => {
            console.error('WebSocket Error:', error);
            endCall();
        };

    } catch (err) {
        console.error('Call failed:', err);
        statusDiv.innerText = 'Microphone access denied or connection failed.';
        btnCall.disabled = false;
    }
};

btnEnd.onclick = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stop' }));
        ws.close();
    }
    endCall();
};

function endCall() {
    stopRingtone();
    statusDiv.innerText = 'Call Ended';
    appContainer.classList.remove('active-call');
    btnCall.style.display = 'inline-block';
    btnEnd.style.display = 'none';
    btnCall.disabled = false;
    
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        mediaRecorder.stream.getTracks().forEach(track => track.stop());
    }
    
    setTimeout(() => {
        statusDiv.innerText = 'Ready to call';
    }, 2000);
}

function addTranscript(role, text, agentName) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `msg msg-${role}`;
    msgDiv.innerHTML = `
        <div class="msg-role">${role === 'user' ? 'You' : (agentName || 'Agent')}</div>
        <div class="msg-content">${text}</div>
    `;
    transcriptDiv.appendChild(msgDiv);
    transcriptDiv.scrollTop = transcriptDiv.scrollHeight;
}

// Enable button immediately since we don't need to fetch secure tokens anymore
statusDiv.innerText = 'Ready to call';
btnCall.innerText = 'Call Agent';
btnCall.disabled = false;
