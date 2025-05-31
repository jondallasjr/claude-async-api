// =================================================================
// DEV NOTES for api/process-queue.js (Updated 2025-05-31)
// =================================================================
/*
ARCHITECTURE UPDATE - NEW ROLE SEPARATION:

PACK RESPONSIBILITIES:
- Model names and pricing data (single source of truth)
- UI/UX and parameter collection
- Sends specific model pricing to Vercel when includeCost=true

VERCEL RESPONSIBILITIES:
- All Claude API calls and response processing
- Cost calculation using pricing data from Pack
- Includes cost automatically in webhook payload when requested

COST CALCULATION FLOW:
1. Pack finds pricing for selected model
2. Pack always sends modelPricing in payload  
3. Vercel calculates cost using Pack's pricing data
4. Cost always included in webhook response

IMPROVEMENTS IMPLEMENTED:
- requestId included in webhook payload for correlation
- Cost calculation happens in Vercel using Pack's pricing
- JSON system message only defined here (no duplication)
- Validation removed (let Claude API handle errors for better messages)
- Temperature only added if provided (handles undefined cleanly)

CRITICAL LESSON: Coda Pack authentication truncates user API keys from 108→24 chars.
- Expected: sk-ant-api03-*****************-TLsQqwp8AktN3qUy_tUAW3Sl-TBw-wVaVDAAA (108 chars)
- Received: BdoveNwSkOfb58rCtsAwgcR2 (24 chars)
- CURRENT SOLUTION: Force system API key usage until Pack auth is resolved

STATUS HANDLING:
- Handles already completed/failed requests gracefully
- Detects stuck processing requests (>5 min) and resets them
- Returns appropriate HTTP status codes for different scenarios

TIMEOUT PROTECTION:
- maxDuration: 300 (5 minutes) for extended thinking and large responses
- Consider Fluid Compute for even longer durations (up to 800s)

TODO: Investigate Pack authentication to restore user API key functionality
*/

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const config = {
  maxDuration: 300, // 5 minutes
};

// JSON mode system message - ONLY defined here
const JSON_SYSTEM_MESSAGE = `You respond only in JSON. Your response must be single, valid JSON object.
Requirements:
- Always start with {
- Use proper JSON syntax and escaping
- Use only straight double quotes (")
- Include only JSON data, no explanations
- Always end with }
- CRITICAL: Always escape newlines as \\n in string values, never include actual line breaks
- CRITICAL: Always escape tabs as \\t, carriage returns as \\r, and other control characters`;

// Fallback JSON sanitization - only used if initial parse fails
function sanitizeJson(jsonString) {
  return jsonString
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

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

    // Handle different status scenarios
    if (request.status === 'completed') {
      return res.status(200).json({
        success: true,
        message: 'Request already completed',
        status: request.status
      });
    }

    if (request.status === 'failed') {
      return res.status(200).json({
        success: false,
        message: 'Request previously failed',
        error: request.error_message
      });
    }

    if (request.status === 'processing') {
      const processingTime = Date.now() - new Date(request.processing_started_at).getTime();
      if (processingTime < 300000) {
        return res.status(409).json({
          error: 'Request currently being processed',
          processingTimeSeconds: Math.round(processingTime / 1000)
        });
      }
      console.log(`Resetting stuck request ${requestId} after ${processingTime}ms`);
    }

    // Mark as processing
    await supabase
      .from('llm_requests')
      .update({
        status: 'processing',
        processing_started_at: new Date().toISOString(),
        error_message: null
      })
      .eq('request_id', requestId);

    // Call Claude API
    console.log(`Calling Claude API for ${requestId}`);
    const claudeResponse = await callClaudeAPI(request.request_payload);
    console.log(`Claude completed for ${requestId}`);

    // Process response for Pack consumption
    const processedResponse = processClaudeResponse(claudeResponse, request.request_payload);

    // Mark as completed - triggers webhook
    await supabase
      .from('llm_requests')
      .update({
        status: 'completed',
        response_payload: processedResponse,
        completed_at: new Date().toISOString()
      })
      .eq('request_id', requestId);

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

async function callClaudeAPI(payload) {
  const {
    prompt,
    model = 'claude-sonnet-4-0',
    maxTokens = 4096,
    temperature,
    systemPrompt = '',
    jsonMode = false,
    extendedThinking = false,
    thinkingBudgetTokens = 4096,
    userApiKey
  } = payload;

  // Use system API key (Pack auth issue workaround)
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error('No system API key configured');
  }

  const API_VERSION = "2023-06-01";
  const API_BASE_URL = "https://api.anthropic.com/v1";

  // Build system prompt
  const finalSystemPrompt = jsonMode ?
    (systemPrompt ? `${JSON_SYSTEM_MESSAGE}\n\nAdditional instructions: ${systemPrompt}` : JSON_SYSTEM_MESSAGE) :
    systemPrompt;

  const messages = [
    {
      role: "user",
      content: jsonMode ? `Generate JSON response for: ${prompt}` : prompt
    }
  ];

  const requestBody = {
    model,
    max_tokens: maxTokens,
    messages,
    system: finalSystemPrompt || undefined,
  };

  // Add temperature if provided
  if (temperature !== undefined) {
    requestBody.temperature = temperature;
  }

  // Extended thinking - let API handle all validation
  if (extendedThinking) {
    requestBody.thinking = {
      type: "enabled",
      budget_tokens: thinkingBudgetTokens
    };
  }

  const response = await fetch(`${API_BASE_URL}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Claude API error (${response.status}): ${errorBody}`);
  }

  return await response.json();
}

function processClaudeResponse(claudeResponse, requestPayload) {
  const { jsonMode = false, extendedThinking = false, modelPricing } = requestPayload;

  // Extract content
  let content;
  let thinking = null;

  if (extendedThinking) {
    // Always include thinking if extended thinking was used
    const thinkingBlock = claudeResponse.content?.find(block => block.type === "thinking");
    if (thinkingBlock) {
      thinking = thinkingBlock.content;
    }

    const textBlock = claudeResponse.content?.find(block => block.type === "text");
    content = textBlock?.text || '';
  } else {
    content = claudeResponse.content?.[0]?.text || '';
  }

  // Handle JSON mode with fallback sanitization
  if (jsonMode) {
    try {
      // Try parsing as-is first (Claude should follow system prompt)
      JSON.parse(content);
    } catch (parseError) {
      console.log('Initial JSON parse failed, applying sanitization fallback');
      try {
        content = sanitizeJson(content);
        JSON.parse(content); // Verify sanitized version parses
      } catch (sanitizeError) {
        throw new Error(`JSON response invalid even after sanitization: ${sanitizeError.message}`);
      }
    }
  }

  // Build response for Pack
  const response = {
    requestId: requestPayload.requestId,
    content,
    model: requestPayload.model || 'claude-sonnet-4-0',
    usage: claudeResponse.usage
  };

  // Include thinking if it was used
  if (thinking) {
    response.thinking = thinking;
  }

  // Always calculate and include cost when pricing is available
  if (modelPricing && claudeResponse.usage) {
    const { input_tokens, output_tokens } = claudeResponse.usage;
    const inputCost = (input_tokens / 1000000) * modelPricing.input;
    const outputCost = (output_tokens / 1000000) * modelPricing.output;

    response.cost = {
      model: requestPayload.model || 'claude-sonnet-4-0',
      inputTokens: input_tokens,
      outputTokens: output_tokens,
      inputCost: parseFloat(inputCost.toFixed(6)),
      outputCost: parseFloat(outputCost.toFixed(6)),
      totalCost: parseFloat((inputCost + outputCost).toFixed(6))
    };
  }

  return response;
}