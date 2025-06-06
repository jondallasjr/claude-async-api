// =================================================================
// DEV NOTES for api/request-status.js
// =================================================================
/*
DEBUGGING UTILITY: Essential for troubleshooting async request flow.

KEY FEATURES:
- Shows complete request lifecycle: queued → processing → completed/failed
- Includes processing time calculations for performance monitoring
- Returns webhook delivery logs for end-to-end verification
- Returns full Claude response payload for debugging
- Used extensively during development to trace issues

USAGE EXAMPLES:
- GET /api/request-status?requestId=req_1234567890_abcdef
- Check if request is stuck in processing
- Verify webhook delivery success/failure
- Calculate actual processing durations
- Inspect full Claude response for debugging

PERFORMANCE INSIGHTS GAINED:
- Manual processing: ~3 seconds for simple requests
- Webhook delivery: <1 second after completion
- End-to-end latency: ~5 seconds total (queue → process → deliver)

DEBUGGING VALUE:
- Helped identify when requests were stuck in "queued" due to auto-trigger failures
- Confirmed webhook delivery success after fixing pg_net parameter bug
- Essential for monitoring production system health
- Full response inspection for citation processing verification
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { requestId } = req.query;

  if (!requestId) {
    return res.status(400).json({ error: 'requestId parameter required' });
  }

  try {
    console.log(`Checking status for request: ${requestId}`);
    
    // Get request status including response payload
    const { data: request, error } = await supabase
      .from('llm_requests')
      .select('request_id, status, created_at, processing_started_at, completed_at, error_message, response_payload')
      .eq('request_id', requestId)
      .single();

    if (error || !request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    // Get webhook logs for this request
    const { data: webhookLogs } = await supabase
      .from('webhook_logs')
      .select('status, response_status, created_at')
      .eq('request_id', requestId)
      .order('created_at', { ascending: false });

    // Calculate processing time if completed
    let processingTimeSeconds = null;
    if (request.completed_at && request.created_at) {
      processingTimeSeconds = Math.round(
        (new Date(request.completed_at) - new Date(request.created_at)) / 1000
      );
    }

    const response = {
      requestId: request.request_id,
      status: request.status,
      createdAt: request.created_at,
      processingStartedAt: request.processing_started_at,
      completedAt: request.completed_at,
      processingTimeSeconds,
      errorMessage: request.error_message,
      webhookLogs: webhookLogs || []
    };

    // Include the full Claude response if available
    if (request.response_payload) {
      response.response = request.response_payload;
    }

    return res.json(response);

  } catch (error) {
    console.error('Status check error:', error);
    return res.status(500).json({ error: error.message });
  }
}