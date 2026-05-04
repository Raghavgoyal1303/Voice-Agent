/**
 * Sarah AI - Multilingual Real Estate Concierge
 * Powered by Gemini Multimodal (Audio-to-Text)
 */

const micBtn = document.getElementById('btn-mic');
const micStatus = document.getElementById('mic-status');
const statusText = document.getElementById('status-text');
const chatHistory = document.getElementById('chat-history');
const bars = document.querySelectorAll('.bar');

let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let synthesis = window.speechSynthesis;

// Initialize Media Recorder
async function initRecorder() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);

        mediaRecorder.ondataavailable = (event) => {
            audioChunks.push(event.data);
        };

        mediaRecorder.onstop = async () => {
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            audioChunks = [];
            await sendAudioToServer(audioBlob);
        };
    } catch (err) {
        console.error("Mic access denied:", err);
        alert("Please allow microphone access to talk to Sarah.");
    }
}

async function sendAudioToServer(blob) {
    statusText.innerText = 'Analyzing...';
    const formData = new FormData();
    formData.append('audio', blob, 'recording.webm');

    try {
        const response = await fetch('/chat-audio', {
            method: 'POST',
            body: formData
        });
        const data = await response.json();
        if (data.text) {
            appendMessage('agent', data.text);
            speak(data.text);
        }
    } catch (err) {
        console.error('Upload error:', err);
    } finally {
        statusText.innerText = 'Online';
    }
}

function speak(text) {
    synthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    
    // Auto-detect language
    if (/[\u0900-\u097F]/.test(text)) utterance.lang = 'hi-IN';
    else if (/[áéíóúñ¿¡]/i.test(text)) utterance.lang = 'es-ES';
    else utterance.lang = 'en-US';

    const voices = synthesis.getVoices();
    const preferredVoice = voices.find(v => v.lang.startsWith(utterance.lang) && (v.name.includes('Google') || v.name.includes('Natural')));
    if (preferredVoice) utterance.voice = preferredVoice;

    utterance.onstart = () => animateVisualizer();
    utterance.onend = () => resetVisualizer();
    synthesis.speak(utterance);
}

// UI Helpers
function appendMessage(sender, text) {
    const msg = document.createElement('div');
    msg.className = `message ${sender}`;
    msg.innerText = text;
    chatHistory.appendChild(msg);
    chatHistory.scrollTop = chatHistory.scrollHeight;
}

function animateVisualizer() {
    bars.forEach(bar => {
        const height = Math.random() * 40 + 10;
        bar.style.height = `${height}px`;
    });
}

function resetVisualizer() {
    bars.forEach(bar => {
        bar.style.height = `10px`;
    });
}

micBtn.onclick = async () => {
    if (isRecording) {
        mediaRecorder.stop();
        isRecording = false;
        micBtn.classList.remove('active');
        micStatus.innerText = 'Processing...';
        resetVisualizer();
    } else {
        if (!mediaRecorder) await initRecorder();
        if (mediaRecorder) {
            mediaRecorder.start();
            isRecording = true;
            micBtn.classList.add('active');
            micStatus.innerText = 'Release to send';
            animateVisualizer();
        }
    }
};

// Warm up voices
synthesis.getVoices();
if (synthesis.onvoiceschanged !== undefined) {
    synthesis.onvoiceschanged = synthesis.getVoices;
}
