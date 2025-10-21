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


// =================================================================
// DEV NOTES for api/queue-request.js (Updated 2025-08-22)
// =================================================================
/*
FIRE-AND-FORGET AUTO-TRIGGER ARCHITECTURE:

PROBLEM SOLVED: 
- Previous version tried to wait for Claude processing (2-10 minutes) with 10-second timeout
- This caused AbortError and defeated the purpose of async processing

NEW APPROACH:
- Store request in database
- Fire auto-trigger request and immediately return
- Don't wait for process-queue response
- Let async processing happen in background
- Graceful fallback to manual trigger if auto-trigger fails

BENEFITS:
- queue-request returns immediately (sub-second response)
- No timeouts or aborts
- True async processing
- Reliable manual fallback always available

FLOW:
1. Store request → instant success
2. Fire trigger → don't wait for response
3. Return success to Pack immediately
4. Processing happens in background
5. Webhook delivers result when ready
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Claude-API-Key');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Extract Claude API key from header (Coda replaced the placeholder)
    const claudeApiKey = req.headers['x-claude-api-key'];
    
    // Validate API key presence
    if (!claudeApiKey) {
      console.error('Missing Claude API key in request headers');
      return res.status(400).json({
        error: 'Missing Claude API key. Please reconnect your Pack authentication and ensure your API key is configured.'
      });
    }

    // Validate API key format (Claude keys start with sk-ant- and are ~108 chars)
    if (!claudeApiKey.startsWith('sk-ant-')) {
      console.error(`Invalid API key format: ${claudeApiKey.substring(0, 10)}...`);
      return res.status(400).json({
        error: 'Invalid Claude API key format. Keys should start with "sk-ant-". Please reconnect with a valid key.'
      });
    }

    if (claudeApiKey.length < 50) {
      console.error(`API key too short: ${claudeApiKey.length} characters`);
      return res.status(400).json({
        error: `API key appears truncated (${claudeApiKey.length} chars). Expected ~108 characters. Please reconnect your Pack authentication.`
      });
    }

    console.log(`✅ Valid API key received (length: ${claudeApiKey.length})`);

    const { requestId, codaWebhookUrl, codaApiToken } = req.body;

    // Validate requestId
    if (!requestId) {
      return res.status(400).json({
        error: 'Missing required field: requestId'
      });
    }

    console.log(`Queueing request ${requestId}${codaWebhookUrl ? ' with webhook' : ' (no webhook)'}`);

    // Store the complete request payload in Supabase
    // Add the Claude API key to the payload for process-queue to use
    const { error } = await supabase
      .from('llm_requests')
      .insert({
        request_id: requestId,
        request_payload: {
          ...req.body,
          userApiKey: claudeApiKey  // ✅ Add the validated key to payload
        },
        coda_webhook_url: codaWebhookUrl || null,
        coda_api_token: codaApiToken || null,
        status: 'queued'
      });

    if (error) {
      console.error('Database error:', error);
      throw error;
    }

    console.log(`✅ Request ${requestId} queued successfully`);

    // Return immediately - processing happens in background via pg_net trigger
    res.status(200).json({
      success: true,
      requestId,
      message: 'Request queued and processing started in background',
      status: 'queued',
      note: codaWebhookUrl 
        ? 'Response will be delivered via webhook when processing completes'
        : 'Use checkRequest(requestId) to poll for results'
    });

  } catch (error) {
    console.error('Queue error:', error);
    res.status(500).json({
      error: 'Failed to queue request',
      details: error.message
    });
  }
}