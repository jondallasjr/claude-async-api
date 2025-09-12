// =================================================================
// SIMPLIFIED process-queue.js (Updated 2025-09-12)
// =================================================================
/*
MINIMAL PROCESSING APPROACH:
- Store Claude's raw response with minimal changes
- Remove only signatures and encrypted content (size bloat)
- Truncate any string field to 45k characters (Coda limits)
- Add cost calculation and basic metadata
- Let Coda formulas handle parsing
*/

import { createClient } from '@supabase/supabase-js';
import { setGlobalDispatcher, Agent } from 'undici';

// Extend timeout for all fetch requests
setGlobalDispatcher(new Agent({
  connect: { timeout: 720_000 },    // 12 minutes
  headersTimeout: 720_000,          // 12 minutes  
  bodyTimeout: 720_000              // 12 minutes
}));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const config = {
  maxDuration: 800, // 13+ minutes
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { requestId } = req.body;

  try {
    console.log(`Processing request ${requestId}`);

    // Get the request
    const { data: request, error: fetchError } = await supabase
      .from('llm_requests')
      .select('*')
      .eq('request_id', requestId)
      .single();

    if (fetchError || !request) {
      throw new Error(`Request not found: ${requestId}`);
    }

    // Handle already completed/failed requests
    if (request.status === 'completed') {
      return res.status(200).json({ success: true, message: 'Already completed' });
    }
    if (request.status === 'failed') {
      return res.status(200).json({ success: false, message: 'Previously failed' });
    }

    // Check for stuck processing (reset after 20 minutes)
    if (request.status === 'processing') {
      const processingTime = Date.now() - new Date(request.processing_started_at).getTime();
      if (processingTime < 1200000) {
        return res.status(409).json({ error: 'Currently processing' });
      }
      console.log(`Resetting stuck request ${requestId}`);
    }

    // Mark as processing
    await supabase
      .from('llm_requests')
      .update({
        status: 'processing',
        processing_started_at: new Date().toISOString()
      })
      .eq('request_id', requestId);

    // Call Claude API
    console.log(`Calling Claude API for ${requestId}`);
    const claudeResponse = await callClaudeAPI(request.request_payload);
    console.log(`Claude completed for ${requestId}`);

    // Minimal processing
    const processedResponse = processResponseMinimal(claudeResponse, request.request_payload);

    // Store completed response
    const { error: updateError } = await supabase
      .from('llm_requests')
      .update({
        status: 'completed',
        response_payload: processedResponse,
        completed_at: new Date().toISOString()
      })
      .eq('request_id', requestId);

    if (updateError) {
      throw new Error(`Database update failed: ${updateError.message}`);
    }

    // Direct webhook delivery
    try {
      await fetch(request.coda_webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${request.coda_api_token}`,
          'User-Agent': 'Claude-Async/1.0'
        },
        body: JSON.stringify({
          requestId: requestId,
          status: 'completed'
        }),
        signal: AbortSignal.timeout(5000)
      });
      console.log(`Webhook delivered for ${requestId}`);
    } catch (webhookError) {
      console.log(`Webhook error: ${webhookError.message}`);
    }

    res.status(200).json({ success: true });

  } catch (error) {
    console.error(`Processing error for ${requestId}:`, error);

    await supabase
      .from('llm_requests')
      .update({
        status: 'failed',
        error_message: error.message,
        completed_at: new Date().toISOString()
      })
      .eq('request_id', requestId);

    res.status(500).json({ error: error.message });
  }
}

// Simple recursive function to clean response
function cleanResponse(obj) {
  if (obj === null || typeof obj !== 'object') {
    // Truncate strings to 45k characters
    if (typeof obj === 'string' && obj.length > 45000) {
      return obj.substring(0, 45000) + '... [TRUNCATED]';
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => cleanResponse(item));
  }

  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    // Remove signature and encrypted content fields
    if (key === 'signature' || key === 'encrypted_content' || key === 'encrypted_index') {
      continue;
    }
    cleaned[key] = cleanResponse(value);
  }
  
  return cleaned;
}

// Minimal response processing
function processResponseMinimal(claudeResponse, requestPayload) {
  // Clean the response (remove signatures, truncate strings)
  const cleaned = cleanResponse(claudeResponse);

  // Add cost calculation
  if (requestPayload.modelPricing && claudeResponse.usage) {
    const { input_tokens, output_tokens } = claudeResponse.usage;
    const inputCost = (input_tokens / 1000000) * requestPayload.modelPricing.input;
    const outputCost = (output_tokens / 1000000) * requestPayload.modelPricing.output;

    cleaned.cost = {
      model: requestPayload.claudeRequest?.model || 'unknown',
      inputTokens: input_tokens,
      outputTokens: output_tokens,
      inputCost: parseFloat(inputCost.toFixed(6)),
      outputCost: parseFloat(outputCost.toFixed(6)),
      totalCost: parseFloat((inputCost + outputCost).toFixed(6)),
      currency: 'USD'
    };
  }

  // Add minimal metadata
  cleaned.requestId = requestPayload.requestId;
  cleaned.completedAt = new Date().toISOString();

  return cleaned;
}

async function callClaudeAPI(payload) {
  const { claudeRequest } = payload;
  
  if (!claudeRequest) {
    throw new Error('No claudeRequest found in payload');
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('No API key configured');
  }

  console.log(`Calling Claude with model: ${claudeRequest.model}`);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(claudeRequest),
    signal: AbortSignal.timeout(660000) // 11 minutes
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Claude API error (${response.status}): ${errorText}`);
  }

  const responseData = await response.json();
  
  if (!responseData.content) {
    throw new Error('Invalid Claude response: missing content field');
  }

  return responseData;
}