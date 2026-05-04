require('dotenv').config();
const twilio = require('twilio');
const http = require('http');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Fetch the active ngrok tunnel from ngrok's local API
http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      const httpsTunnel = parsed.tunnels.find(t => t.public_url.startsWith('https://'));
      
      if (!httpsTunnel) {
        console.error('❌ Could not find an active ngrok HTTPS tunnel. Is ngrok running?');
        return;
      }

      const ngrokUrl = httpsTunnel.public_url;
      console.log(`🔗 Using Ngrok URL: ${ngrokUrl}`);

      client.calls.create({
        url: `${ngrokUrl}/inbound`,
        to: '+916284911102',
        from: process.env.TWILIO_PHONE_NUMBER,
      })
      .then(call => console.log('✅ Calling you now! SID:', call.sid))
      .catch(err => console.error('❌ Error:', err.message));

    } catch (e) {
      console.error('❌ Failed to parse ngrok URL. Is ngrok running?', e.message);
    }
  });
}).on('error', (err) => {
  console.error('❌ Failed to connect to ngrok local API. Make sure ngrok is running!', err.message);
});