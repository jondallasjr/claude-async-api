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

WEBHOOK RELIABILITY SYSTEM:
- Rate limiting: Max 1 webhook per 10 seconds to prevent Coda queue overload
- In-memory tracking: Cleans webhook history every 60 seconds
- Monitoring: webhook-monitor.js retries unfetched webhooks after 2+ minutes
- Fetch tracking: request-status.js records when users retrieve responses
- Combined approach prevents bursts + recovers from any dropped webhooks
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

// Simple in-memory tracking of recent webhook sends
let recentWebhooks = [];

// ENHANCED VERSION - keeps rate limiting + adds retries
async function sendWebhookWithRateLimitAndRetry(webhookUrl, payload, token, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // KEEP EXISTING RATE LIMITING LOGIC
      const now = Date.now();
      recentWebhooks = recentWebhooks.filter(time => now - time < 60000);

      const webhooksInLast10Seconds = recentWebhooks.filter(time => now - time < 10000);
      if (webhooksInLast10Seconds.length >= 1) {
        const lastWebhook = Math.max(...recentWebhooks);
        const waitTime = 10000 - (now - lastWebhook);
        if (waitTime > 0) {
          console.log(`Rate limiting: waiting ${waitTime}ms before attempt ${attempt}`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }

      recentWebhooks.push(Date.now());

      // ATTEMPT WEBHOOK WITH LONGER TIMEOUT
      await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'Claude-Async/1.0'
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000) // INCREASED FROM 5000
      });

      console.log(`Webhook delivered successfully on attempt ${attempt}`);
      return; // Success

    } catch (error) {
      console.log(`Webhook attempt ${attempt} failed: ${error.message}`);

      if (attempt === maxRetries) {
        throw error; // Final attempt failed
      }

      // Exponential backoff for retries (but not for rate limiting)
      const backoffMs = Math.pow(2, attempt) * 1000;
      console.log(`Retrying in ${backoffMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
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

    // Rate-limited webhook delivery
    try {
      await sendWebhookWithRateLimitAndRetry(
        request.coda_webhook_url,
        {
          requestId: requestId,
          status: 'completed'
        },
        request.coda_api_token
      );
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

// Extract and format citations from Claude's response
function extractAndFormatCitations(claudeResponse) {
  const citationRegistry = new Map();
  let citationCounter = 1;

  // Walk through content blocks and extract citations
  function collectCitations(obj) {
    if (obj === null || typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
      obj.forEach(collectCitations);
      return;
    }

    // Handle text blocks with citations array
    if (obj.type === 'text' && obj.citations && Array.isArray(obj.citations)) {
      obj.citations.forEach(citation => {
        if (citation.url && !citationRegistry.has(citation.url)) {
          citationRegistry.set(citation.url, {
            number: citationCounter++,
            url: citation.url,
            title: citation.title || 'Unknown Source',
            cited_text: citation.cited_text || ''
          });
        }
      });
    }

    // Recursively process nested objects
    Object.values(obj).forEach(collectCitations);
  }

  // Collect all citations
  collectCitations(claudeResponse);

  return citationRegistry;
}

function addCitationFootnotes(content, citationRegistry) {
  if (citationRegistry.size === 0) return content;

  // Build footnotes section
  const citations = Array.from(citationRegistry.values())
    .sort((a, b) => a.number - b.number);

  let footnotes = '\n\n---\n**Sources:**\n\n';
  citations.forEach(citation => {
    footnotes += `[${citation.number}] [${citation.title}](${citation.url})\n`;
  });

  return content + footnotes;
}

function processContentWithCitations(contentArray, citationRegistry) {
  return contentArray.map(block => {
    if (block.type === 'text' && block.citations && Array.isArray(block.citations)) {
      // Add citation markers to text
      let text = block.text || '';

      const citationNumbers = block.citations
        .filter(c => c.url && citationRegistry.has(c.url))
        .map(c => citationRegistry.get(c.url).number)
        .sort((a, b) => a - b);

      if (citationNumbers.length > 0) {
        const markers = citationNumbers.map(n => `[${n}]`).join('');
        text += ` ${markers}`;
      }

      return {
        type: 'text',
        text: text
      };
    }

    // Return other blocks unchanged
    return block;
  });
}

// Enhanced minimal response processing with optional citation handling
function processResponseMinimal(claudeResponse, requestPayload) {
  // Clean the response (remove signatures, encrypted content)
  let cleaned = cleanResponse(claudeResponse);

  // Check if web search was used (citations present)
  const hasWebSearch = requestPayload.claudeRequest?.tools?.some(tool =>
    tool.type === 'web_search_20250305' || tool.name === 'web_search'
  );

  // Process citations if web search was used
  if (hasWebSearch && cleaned.content) {
    console.log('Web search detected, processing citations...');

    // Extract citation registry
    const citationRegistry = extractAndFormatCitations(cleaned);

    if (citationRegistry.size > 0) {
      console.log(`Found ${citationRegistry.size} unique citations`);

      // Process content blocks to add citation markers
      cleaned.content = processContentWithCitations(cleaned.content, citationRegistry);

      // Add footnotes as a SEPARATE final text block instead of modifying existing blocks
      const footnotes = buildFootnotesBlock(citationRegistry);
      cleaned.content.push(footnotes);

      // Store citation metadata
      cleaned._citationInfo = {
        totalCitations: citationRegistry.size,
        citationUrls: Array.from(citationRegistry.values()).map(c => c.url)
      };
    } else {
      console.log('No citations found in web search response');
    }
  }

  // Handle JSON content extraction if requested
  if (requestPayload.responseOptions?.jsonContent) {
    const textContent = cleaned.content?.find(item => item.type === 'text');
    if (textContent?.text) {
      const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          JSON.parse(jsonMatch[0]);
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

function buildFootnotesBlock(citationRegistry) {
  if (citationRegistry.size === 0) return null;
  
  const citations = Array.from(citationRegistry.values())
    .sort((a, b) => a.number - b.number);
  
  let footnotes = '\n\n---\n**Sources:**\n\n';
  citations.forEach(citation => {
    footnotes += `[${citation.number}] [${citation.title}](${citation.url})\n`;
  });
  
  return {
    type: 'text',
    text: footnotes
  };
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