// =================================================================
// DEV NOTES for api/process-queue.js  
// =================================================================
/*
CRITICAL LESSON: Coda Pack authentication truncates user API keys from 108→24 chars.

PROBLEM SOLVED:
- User Claude API keys were getting truncated in Coda Pack authentication (108→24 chars)  
- Root cause: Coda's security design prevents direct access to user credentials
- Solution: Use parameter-based authentication instead of Coda's auth system

CURRENT SOLUTION:
- Users pass Claude API key directly as formula parameter (claudeApiKey)
- Pack sends real API key in request payload as userApiKey
- No more truncation - full sk-ant-api03-... keys work perfectly

IMPROVED STATUS HANDLING:
- Handles already completed/failed requests gracefully
- Detects stuck processing requests (>5 min) and resets them
- Returns appropriate HTTP status codes for different scenarios

TIMEOUT PROTECTION:
- maxDuration: 300 (5 minutes) for long Claude API calls
- Supports extended thinking and large responses without timeout
- Consider enabling Fluid Compute for even longer durations (up to 800s)

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

    // IMPROVED: Handle different status scenarios
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
      // Check if it's been processing too long (over 5 minutes)
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
        error_message: null // Clear any previous errors
      })
      .eq('request_id', requestId);

    // Extract the original request payload
    const payload = request.request_payload;
    
    console.log(`Calling Claude API for ${requestId}`);

    // Call Claude API - use the EXACT same logic as your existing pack
    const claudeResponse = await callClaudeAPI(payload);

    console.log(`Claude completed for ${requestId}`);

    // Mark as completed - this triggers the webhook
    await supabase
      .from('llm_requests')
      .update({
        status: 'completed',
        response_payload: claudeResponse,  // Store full response as JSON
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

// This function contains your EXACT existing Claude API logic
async function callClaudeAPI(payload) {
  const { 
    prompt, 
    model = 'claude-sonnet-4-0',
    maxTokens = 4096,
    temperature = 1.0,
    systemPrompt = '',
    jsonMode = false,
    extendedThinking = false,
    thinkingBudgetTokens = 4096,
    userApiKey // This should match what the Pack sends (claudeApiKey → userApiKey)
  } = payload;

  // Use the user's Claude API key directly
  const apiKey = userApiKey; // Direct from Pack parameter (claudeApiKey)
  
  if (!apiKey) {
    throw new Error('No Claude API key provided in request payload');
  }

  // Validate Claude API key format with helpful error message
  if (!apiKey.startsWith('sk-ant-api') || apiKey.length < 100) {
    throw new Error(`Invalid Claude API key format: expected sk-ant-api... with 100+ characters (get at console.anthropic.com), got ${apiKey.length} characters`);
  }

  console.log(`Using Claude API key: ${apiKey.substring(0, 20)}... (length: ${apiKey.length})`);

  const API_VERSION = "2023-06-01";
  const API_BASE_URL = "https://api.anthropic.com/v1";
  
  const JSON_SYSTEM_MESSAGE = `You are a JSON Generation AI. Your responses must be single, valid JSON object. 
Requirements:
- Always start with {
- Use proper JSON syntax and escaping
- Use only straight double quotes (")
- Include only JSON data, no explanations
- Always end with }`;

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

  if (!extendedThinking && !jsonMode) {
    requestBody.temperature = temperature;
  } else if (jsonMode && !extendedThinking) {
    requestBody.temperature = 0.2;
  }

  if (extendedThinking) {
    if (!model.includes("claude-opus-4") && !model.includes("claude-sonnet-4") && !model.includes("claude-3-7-sonnet")) {
      throw new Error("Extended thinking only available with Claude Opus 4, Sonnet 4, and 3.7 Sonnet");
    }
    if (thinkingBudgetTokens >= maxTokens) {
      throw new Error("Thinking budget must be less than max_tokens");
    }
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

  const responseData = await response.json();

  // Validate response
  if (extendedThinking) {
    const hasTextBlock = responseData.content?.some(block => block.type === "text" && block.text);
    if (!hasTextBlock) {
      throw new Error("Invalid response format from Claude API");
    }
  } else {
    if (!responseData.content?.[0]?.text) {
      throw new Error("Invalid response format from Claude API");
    }
  }

  return responseData;
}