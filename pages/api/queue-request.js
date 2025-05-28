import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Just validate the bare minimum and store everything as JSON
    const { requestId, codaWebhookUrl, codaApiToken } = req.body;

    if (!requestId || !codaWebhookUrl || !codaApiToken) {
      return res.status(400).json({ 
        error: 'Missing required fields: requestId, codaWebhookUrl, codaApiToken' 
      });
    }

    console.log(`Queueing request ${requestId}`);

    // Store the entire request payload as JSON - let Supabase handle the details
    const { error } = await supabase
      .from('llm_requests')
      .insert({
        request_id: requestId,
        request_payload: req.body,  // Store everything as JSON
        coda_webhook_url: codaWebhookUrl,
        coda_api_token: codaApiToken,
        status: 'queued'
      });

    if (error) {
      console.error('Database error:', error);
      throw error;
    }

    // Trigger processing
    const processUrl = `${req.headers.origin || process.env.VERCEL_URL}/api/process-queue`;
    fetch(processUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId })
    }).catch(console.error);

    res.status(200).json({ 
      success: true, 
      requestId,
      message: 'Request queued for processing'
    });

  } catch (error) {
    console.error('Queue error:', error);
    res.status(500).json({ 
      error: 'Failed to queue request', 
      details: error.message 
    });
  }
}