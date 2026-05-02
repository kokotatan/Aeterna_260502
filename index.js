require('dotenv').config();
const express = require('express');
const path = require('path');
const line = require('@line/bot-sdk');

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

// Only initialize the client if we have the tokens
const client = (lineConfig.channelAccessToken && lineConfig.channelSecret) 
    ? new line.messagingApi.MessagingApiClient({ channelAccessToken: lineConfig.channelAccessToken })
    : null;

const app = express();

// LINE Webhook needs to be registered BEFORE express.json()
app.post('/api/line-webhook', line.middleware(lineConfig), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// World ID Verify Endpoint
app.post('/api/verify', async (req, res) => {
    const proof = req.body;
    
    // We get the APP_ID from env, this corresponds to the "app_id" in Developer Portal
    const app_id = process.env.WORLD_ID_APP_ID;
    
    if (!app_id) {
        return res.status(500).json({ success: false, detail: "Server misconfiguration: missing WORLD_ID_APP_ID" });
    }

    try {
        // Forward the proof exactly as-is to the World ID verify endpoint
        const verifyRes = await fetch(`https://developer.world.org/api/v4/verify/${app_id}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(proof) // Pass exactly what IDKit returned
        });

        const verifyResJson = await verifyRes.json();

        if (verifyRes.ok) {
            // Proof is valid
            // Check the nullifier uniqueness in your database here to prevent double-spending
            const nullifier = proof.nullifier_hash;
            // Example: const isUnique = await checkNullifierInDb(proof.action, nullifier);
            
            res.json({ success: true, detail: "Proof successfully verified." });
        } else {
            // Proof invalid
            res.status(400).json({ success: false, detail: verifyResJson.detail || "Verification failed." });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, detail: "Server error during verification." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

// Basic Event Handler for LINE messages
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    // Ignore non-text messages
    return Promise.resolve(null);
  }

  // Pass control to Claude Code / OpenClaw logic
  // For now, we mock the interaction and send a World ID Auth link if requested
  const text = event.message.text;
  let replyText = `【Aeterna エージェント】\n${text} とのことですね。承知いたしました。`;

  if (text.includes('認証') || text.includes('本人確認') || text.includes('World ID')) {
      const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
      replyText = `本人確認を行います。以下のリンクを開いて World ID で認証を完了させてください。\n${baseUrl}`;
  }

  if (client) {
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: 'text',
            text: replyText
          }
        ]
      });
  } else {
      console.log('LINE Message Received but no LINE credentials set:', replyText);
      return Promise.resolve(null);
  }
}
