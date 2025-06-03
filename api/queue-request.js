// =================================================================
// DEV NOTES for api/queue-request.js (Updated 2025-06-03)
// =================================================================
/*

Simplify Vercel response processing - return raw Claude response (2025-06-03)
- Removed complex response processing: No more content extraction, thinking handling, or custom formatting
- Raw Claude response: Return complete Claude API response as-is with only cost calculation added
- Fixes web search: Empty content issue resolved - all tool results, citations, and search data now preserved
- Future-proof: Any new Claude API response formats automatically supported
- Simpler code: Vercel becomes pure proxy + cost calculator, no response manipulation

ROLE IN NEW ARCHITECTURE:
- Receives request payload from Pack
- Stores complete payload in Supabase for processing
- Auto-triggers processing via internal function call
- No business logic - pure queueing and triggering

CRITICAL LESSON: Vercel function-to-function calls are unreliable due to network timeouts.

SOLUTION IMPLEMENTED:
1. Better URL construction: req.headers.host instead of process.env.VERCEL_URL
2. 10-second timeout with AbortController to prevent hanging
3. Graceful failure: Don't fail main request if auto-trigger fails
4. Manual processing fallback available via direct API call

KEY INSIGHT: Always have fallback mechanisms for inter-service communication.
Even if auto-processing fails, requests remain queued for manual triggering.

NEW ARCHITECTURE BENEFIT:
- Pack sends modelPricing field automatically for every request
- Cost calculation always happens downstream in process-queue.js
- Every webhook includes cost information

DEBUGGING TIP: Check Vercel function logs for "Failed to trigger processing" errors.
Manual trigger works 100% reliably: curl -X POST /api/process-queue -d '{"requestId":"..."}'
*/

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-claude-api-key, x-coda-api-token');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { requestId, codaWebhookUrl } = req.body;

    // Extract API keys from headers (new approach)
    const claudeApiKeyFromHeader = req.headers['x-claude-api-key'];
    const codaApiTokenFromHeader = req.headers['x-coda-api-token'];
    
    // Also check payload for backward compatibility
    const { userApiKey: claudeApiKeyFromPayload, codaApiToken: codaApiTokenFromPayload } = req.body;

    // Use headers first, fall back to payload
    const claudeApiKey = claudeApiKeyFromHeader || claudeApiKeyFromPayload;
    const codaApiToken = codaApiTokenFromHeader || codaApiTokenFromPayload || req.body.codaApiToken;

    // Debug logging (remove in production)
    console.log('=== API Key Debug Info ===');
    console.log(`Claude key from header: ${claudeApiKeyFromHeader ? `${claudeApiKeyFromHeader.length} chars, starts with ${claudeApiKeyFromHeader.substring(0, 12)}...` : 'not found'}`);
    console.log(`Claude key from payload: ${claudeApiKeyFromPayload ? `${claudeApiKeyFromPayload.length} chars` : 'not found'}`);
    console.log(`Coda token from header: ${codaApiTokenFromHeader ? `${codaApiTokenFromHeader.length} chars` : 'not found'}`);
    console.log(`Coda token from payload: ${codaApiTokenFromPayload ? `${codaApiTokenFromPayload.length} chars` : 'not found'}`);
    console.log(`Final Claude key: ${claudeApiKey ? `${claudeApiKey.length} chars` : 'not found'}`);
    console.log(`Final Coda token: ${codaApiToken ? `${codaApiToken.length} chars` : 'not found'}`);

    if (!requestId || !codaWebhookUrl) {
      return res.status(400).json({ 
        error: 'Missing required fields: requestId and codaWebhookUrl are required' 
      });
    }

    if (!claudeApiKey) {
      return res.status(400).json({
        error: 'Missing Claude API key. Check Pack authentication setup.'
      });
    }

    if (!codaApiToken) {
      return res.status(400).json({
        error: 'Missing Coda API token. Check Pack authentication setup.'
      });
    }

    console.log(`Queueing request ${requestId} with multi-header auth`);

    // Store the complete request payload in Supabase
    // Update the payload to include the extracted keys
    const updatedPayload = {
      ...req.body,
      userApiKey: claudeApiKey,      // Ensure we store the key we're actually using
      codaApiToken: codaApiToken     // Ensure we store the token we're actually using
    };

    const { error } = await supabase
      .from('llm_requests')
      .insert({
        request_id: requestId,
        request_payload: updatedPayload,
        coda_webhook_url: codaWebhookUrl,
        coda_api_token: codaApiToken,
        status: 'queued'
      });

    if (error) {
      console.error('Database error:', error);
      throw error;
    }

    // Auto-trigger processing (existing logic unchanged)
    try {
      const processUrl = `https://${req.headers.host}/api/process-queue`;
      
      console.log(`Triggering processing at: ${processUrl}`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      
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
      console.error('Failed to trigger processing:', fetchError);
      console.log(`Request ${requestId} is queued but processing may need manual trigger`);
    }

    res.status(200).json({ 
      success: true, 
      requestId,
      message: 'Request queued for processing',
      authMethod: claudeApiKeyFromHeader ? 'multi-header' : 'payload-fallback'
    });

  } catch (error) {
    console.error('Queue error:', error);
    res.status(500).json({ 
      error: 'Failed to queue request', 
      details: error.message 
    });
  }
}
