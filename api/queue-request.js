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
    const { requestId, codaWebhookUrl, codaApiToken } = req.body;

    if (!requestId || !codaWebhookUrl || !codaApiToken) {
      return res.status(400).json({ 
        error: 'Missing required fields: requestId, codaWebhookUrl, codaApiToken' 
      });
    }

    console.log(`Queueing request ${requestId}`);

    // Store the request in Supabase
    const { error } = await supabase
      .from('llm_requests')
      .insert({
        request_id: requestId,
        request_payload: req.body,
        coda_webhook_url: codaWebhookUrl,
        coda_api_token: codaApiToken,
        status: 'queued'
      });

    if (error) {
      console.error('Database error:', error);
      throw error;
    }

    // FIXED: Use more reliable processing trigger
    try {
      // Use the correct host from headers (this should work reliably)
      const processUrl = `https://${req.headers.host}/api/process-queue`;
      
      console.log(`Triggering processing at: ${processUrl}`);
      
      // Add timeout and better error handling
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      
      const response = await fetch(processUrl, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'User-Agent': 'Vercel-Internal'
        },
        body: JSON.stringify({ requestId }),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`Processing trigger failed: ${response.status} ${response.statusText}`);
      }
      
      console.log(`Processing triggered successfully for ${requestId}`);
      
    } catch (fetchError) {
      // Don't fail the main request if processing trigger fails
      // The request is already queued, user can manually trigger if needed
      console.error('Failed to trigger processing:', fetchError);
      console.log(`Request ${requestId} is queued but processing may need manual trigger`);
    }

    res.status(200).json({ 
      success: true, 
      requestId,
      message: 'Request queued for processing',
      note: 'If processing doesn\'t start automatically, it can be triggered manually'
    });

  } catch (error) {
    console.error('Queue error:', error);
    res.status(500).json({ 
      error: 'Failed to queue request', 
      details: error.message 
    });
  }
}

/* COMMENTING OUT DUE TO TIMEOUT ISSUE

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

    // FIX: Properly construct the process URL with https://
    const processUrl = `https://${req.headers.host}/api/process-queue`;
    console.log(`Triggering processing at: ${processUrl}`);
    
    fetch(processUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId })
    }).catch(error => {
      console.error('Failed to trigger processing:', error);
    });

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
}*/