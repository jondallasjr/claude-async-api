// =================================================================
// DEV NOTES for api/process-queue.js (Updated 2025-06-03)
// =================================================================
/*
ARCHITECTURE UPDATE - PACK-ONLY REQUEST BUILDING:

NEW ROLE SEPARATION:
- PACK: Builds complete Claude API request (claudeRequest field)
- VERCEL: Forwards claudeRequest as-is to Claude API, adds cost calculation

PACK PAYLOAD STRUCTURE:
- claudeRequest: Complete API request ready for Claude
- responseOptions: Format preferences (jsonMode, includeThinking, includeCost)
- modelPricing: Cost calculation data (input/output rates per 1M tokens)
- userApiKey, codaWebhookUrl, codaApiToken: Processing metadata

VERCEL RESPONSIBILITIES:
- Receive claudeRequest from Pack and forward unchanged to Claude
- Calculate cost using Pack's modelPricing data
- Format response for webhook delivery
- NEVER modify or rebuild the Claude API request

BENEFITS:
- Zero coupling: Pack updates never require Vercel changes
- Pack controls all Claude API logic and parameters
- Vercel becomes stable proxy infrastructure

CRITICAL LESSON: Coda Pack authentication truncates user API keys from 108→24 chars.
- CURRENT SOLUTION: Force system API key usage until Pack auth is resolved

STATUS HANDLING:
- Handles already completed/failed requests gracefully
- Detects stuck processing requests (>5 min) and resets them

TIMEOUT PROTECTION:
- maxDuration: 300 (5 minutes) for extended thinking and large responses

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

    // Call Claude API using Pack's pre-built request
    console.log(`Calling Claude API for ${requestId}`);
    const claudeResponse = await callClaudeAPI(request.request_payload);
    console.log(`Claude completed for ${requestId}`);

    // Process response for Pack consumption
    const processedResponse = processClaudeResponseWithSizeControl(claudeResponse, request.request_payload);

    console.log('Processed response:', JSON.stringify(processedResponse, null, 2));

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
  // Extract the pre-built Claude request and metadata
  const { 
    claudeRequest,     // Complete Claude API request from Pack
    userApiKey
  } = payload;

  if (!claudeRequest) {
    throw new Error('No claudeRequest found in payload - ensure Pack is sending complete request');
  }

  // Use system API key (until Pack auth is fixed)
  const apiKey = process.env.ANTHROPIC_API_KEY;
  
  if (!apiKey) {
    throw new Error('No system API key configured');
  }
  
  console.log('Sending request to Claude API:', JSON.stringify(claudeRequest, null, 2));
  
  // Send the request exactly as built by the Pack
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(claudeRequest)  // Send as-is from Pack!
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Claude API error (${response.status}): ${errorBody}`);
  }

  return await response.json();
}

function processClaudeResponse(claudeResponse, requestPayload) {
  const { modelPricing } = requestPayload;

  // Start with Claude's raw response (no cleaning by default)
  const response = {
    ...claudeResponse,
    requestId: requestPayload.requestId,
    completedAt: new Date().toISOString()
  };

  // Only add cost calculation
  if (modelPricing && claudeResponse.usage) {
    const { input_tokens, output_tokens } = claudeResponse.usage;
    const inputCost = (input_tokens / 1000000) * modelPricing.input;
    const outputCost = (output_tokens / 1000000) * modelPricing.output;

    response.cost = {
      model: requestPayload.claudeRequest?.model || 'claude-sonnet-4-0',
      inputTokens: input_tokens,
      outputTokens: output_tokens,
      inputCost: parseFloat(inputCost.toFixed(6)),
      outputCost: parseFloat(outputCost.toFixed(6)),
      totalCost: parseFloat((inputCost + outputCost).toFixed(6)),
      currency: 'USD'
    };
  }

  return response;
}

function deepCleanResponse(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => deepCleanResponse(item));
  }

  const cleaned = {};
  
  for (const [key, value] of Object.entries(obj)) {
    // Remove encrypted fields that consume massive space
    if (key === 'encrypted_content' || key === 'encrypted_index') {
      continue;
    }
    
    // For web_search_result objects, keep only essential metadata
    if (obj.type === 'web_search_result') {
      // Keep only: type, title, url, page_age (remove encrypted_content)
      if (['type', 'title', 'url', 'page_age'].includes(key)) {
        cleaned[key] = value;
      }
      continue;
    }
    
    // For citation objects, preserve all fields except encrypted_index
    if (obj.type === 'web_search_result_location') {
      // Keep: type, cited_text, url, title (remove encrypted_index)
      if (['type', 'cited_text', 'url', 'title'].includes(key)) {
        cleaned[key] = value;
      }
      continue;
    }
    
    // For all other objects, recursively clean and preserve structure
    cleaned[key] = deepCleanResponse(value);
  }
  
  return cleaned;
}

// Alternative more aggressive cleaning function if 50k limit is still exceeded
function aggressiveCleanResponse(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => aggressiveCleanResponse(item));
  }

  const cleaned = {};
  
  for (const [key, value] of Object.entries(obj)) {
    // Remove all encrypted fields
    if (key === 'encrypted_content' || key === 'encrypted_index') {
      continue;
    }
    
    // For web_search_tool_result content, keep only essential results
    if (key === 'content' && obj.type === 'web_search_tool_result') {
      // Limit to first 10 search results to control size
      if (Array.isArray(value)) {
        cleaned[key] = value.slice(0, 10).map(item => aggressiveCleanResponse(item));
      } else {
        cleaned[key] = aggressiveCleanResponse(value);
      }
      continue;
    }
    
    // For web_search_result, keep minimal data
    if (obj.type === 'web_search_result') {
      if (['type', 'title', 'url'].includes(key)) {
        cleaned[key] = value;
      }
      continue;
    }
    
    // For citations, keep essential data only
    if (obj.type === 'web_search_result_location') {
      if (['type', 'cited_text', 'url', 'title'].includes(key)) {
        cleaned[key] = value;
      }
      continue;
    }
    
    // Recursively clean other objects
    cleaned[key] = aggressiveCleanResponse(value);
  }
  
  return cleaned;
}

// Usage in process-queue.js - replace the existing processClaudeResponse function with above
// You can also add a size check and use aggressiveCleanResponse if needed:

function processClaudeResponseWithSizeControl(claudeResponse, requestPayload) {
  const { modelPricing, responseOptions } = requestPayload;

  let finalResponse = claudeResponse;
  const processingLog = [];

  // Calculate original size
  const originalSize = JSON.stringify(claudeResponse).length;
  processingLog.push(`Original response size: ${originalSize} characters`);

  // Only apply cleaning if web search was enabled
  if (responseOptions?.webSearch) {
    processingLog.push('Web search detected, applying response cleaning...');
    console.log('Web search detected, applying response cleaning...');
    
    // Try normal cleaning first
    let cleanedResponse = deepCleanResponse(claudeResponse);
    
    // Check size - if still too large, use aggressive cleaning
    const responseSize = JSON.stringify(cleanedResponse).length;
    processingLog.push(`Response size after standard cleaning: ${responseSize} characters (${Math.round((originalSize - responseSize) / originalSize * 100)}% reduction)`);
    console.log(`Response size after cleaning: ${responseSize} characters`);
    
    if (responseSize > 45000) { // Leave some buffer under 50k limit
      processingLog.push('Response still too large, applying aggressive cleaning...');
      console.log('Response still too large, applying aggressive cleaning...');
      cleanedResponse = aggressiveCleanResponse(claudeResponse);
      const newSize = JSON.stringify(cleanedResponse).length;
      processingLog.push(`Response size after aggressive cleaning: ${newSize} characters (${Math.round((originalSize - newSize) / originalSize * 100)}% total reduction)`);
      console.log(`Response size after aggressive cleaning: ${newSize} characters`);
    }
    
    finalResponse = cleanedResponse;
  } else {
    processingLog.push('No web search used, skipping response cleaning');
    console.log('No web search used, skipping response cleaning');
  }

  // Calculate final size
  const finalSize = JSON.stringify(finalResponse).length;
  processingLog.push(`Final response size: ${finalSize} characters`);

  // Build final response
  const response = {
    ...finalResponse,
    requestId: requestPayload.requestId,
    completedAt: new Date().toISOString(),
    _processingInfo: {
      webSearchEnabled: !!responseOptions?.webSearch,
      cleaningApplied: !!responseOptions?.webSearch,
      originalSizeChars: originalSize,
      finalSizeChars: finalSize,
      sizeReductionPercent: responseOptions?.webSearch ? Math.round((originalSize - finalSize) / originalSize * 100) : 0,
      processingLog: processingLog,
      timestamp: new Date().toISOString()
    }
  };

  // Add cost calculation
  if (modelPricing && claudeResponse.usage) {
    const { input_tokens, output_tokens } = claudeResponse.usage;
    const inputCost = (input_tokens / 1000000) * modelPricing.input;
    const outputCost = (output_tokens / 1000000) * modelPricing.output;

    response.cost = {
      model: requestPayload.claudeRequest?.model || 'claude-sonnet-4-0',
      inputTokens: input_tokens,
      outputTokens: output_tokens,
      inputCost: parseFloat(inputCost.toFixed(6)),
      outputCost: parseFloat(outputCost.toFixed(6)),
      totalCost: parseFloat((inputCost + outputCost).toFixed(6)),
      currency: 'USD'
    };
  }

  return response;
}