// =================================================================
// SIMPLIFIED process-queue.js (Updated 2025-09-12)
// =================================================================
/*
MINIMAL PROCESSING APPROACH:
- Store Claude's raw response with minimal changes
- Remove only signatures and encrypted content (size bloat)
- NO truncation - return full response content
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

// Extract citations into a separate parsable section - simplified
function extractAndFormatCitations(response) {
  const citations = [];
  const citationMap = new Map();
  let citationId = 1;

  function processContent(content) {
    if (!content || !Array.isArray(content)) return;

    for (const item of content) {
      // Handle standard Claude API citations format - simplified
      if (item.citations && Array.isArray(item.citations)) {
        for (const citation of item.citations) {
          const key = citation.document_title + citation.document_index;
          if (!citationMap.has(key)) {
            citationMap.set(key, {
              id: citationId++,
              title: citation.document_title,
              text: citation.cited_text?.substring(0, 200) || ''  // Limit text length
            });
          }
        }
      }

      // Handle web search citations - essential fields only
      if (item.type === 'web_search_tool_result' && item.content) {
        for (const searchItem of item.content) {
          if (searchItem.type === 'web_search_result' && searchItem.url && searchItem.title) {
            const key = searchItem.url;
            if (!citationMap.has(key)) {
              citationMap.set(key, {
                id: citationId++,
                title: searchItem.title.substring(0, 100),  // Limit title length
                url: searchItem.url
              });
            }
          }
        }
      }
    }
  }

  // Process response content
  if (response.content) {
    processContent(response.content);
  }

  return Array.from(citationMap.values());
}

// Minimal response processing
function processResponseMinimal(claudeResponse, requestPayload) {
  // Clean the response (remove signatures and encrypted content only)
  const cleaned = cleanResponse(claudeResponse);

  // Extract and format citations as separate parsable section
  const citations = extractAndFormatCitations(cleaned);
  if (citations.length > 0) {
    cleaned.citations = citations;
  }

  // Handle JSON content extraction if requested
  if (requestPayload.responseOptions?.jsonContent) {
    // Find the main text content
    const textContent = cleaned.content?.find(item => item.type === 'text');
    if (textContent?.text) {
      // Extract just the JSON portion using regex
      const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          // Validate it's actually JSON and clean it
          JSON.parse(jsonMatch[0]);
          // Replace the mixed text with clean JSON
          textContent.text = jsonMatch[0];
          console.log('✅ Extracted clean JSON from mixed content');
        } catch (e) {
          console.warn('⚠️ JSON extraction failed, keeping original text:', e.message);
        }
      }
    }
  }

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