require('dotenv').config();
const Groq = require('groq-sdk');
const { createClient } = require('@deepgram/sdk');
const axios = require('axios');

async function checkKeys() {
    console.log('🔍 Starting API Key Diagnostics...\n');

    // 1. Check Groq
    try {
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        await groq.chat.completions.create({
            messages: [{ role: 'user', content: 'Hi' }],
            model: 'llama-3.1-8b-instant',
        });
        console.log('✅ Groq API Key: WORKING');
    } catch (err) {
        console.error('❌ Groq API Key: FAILED -', err.message);
    }

    // 2. Check Deepgram
    try {
        const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
        const { result, error } = await deepgram.manage.getProjects();
        if (error) throw error;
        console.log('✅ Deepgram API Key: WORKING');
    } catch (err) {
        console.error('❌ Deepgram API Key: FAILED -', err.message);
    }

    // 3. Check Murf
    try {
        const res = await axios.post('https://api.murf.ai/v1/speech/stream', {
            voiceId: 'en-US-ken',
            text: 'Test',
            format: 'PCM',
            sampleRate: 24000
        }, {
            headers: { 'api-key': process.env.MURF_API_KEY }
        });
        console.log('✅ Murf API Key: WORKING');
    } catch (err) {
        console.error('❌ Murf AI Key: FAILED -', err.response?.data || err.message);
    }

    console.log('\n🏁 Diagnostics Complete.');
}

checkKeys();
