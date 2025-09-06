// =================================================================
// DEV NOTES for api/process-queue.js (Updated 2025-06-04)
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
  maxDuration: 800, // 13+ minutes (Pro plan limit)
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
    const { error: updateError } = await supabase
      .from('llm_requests')
      .update({
        status: 'completed',
        response_payload: processedResponse,
        completed_at: new Date().toISOString()
      })
      .eq('request_id', requestId);

    if (updateError) {
      console.error(`Failed to update request ${requestId}:`, updateError);
      throw new Error(`Database update failed: ${updateError.message}`);
    }

    // Direct webhook delivery (bypass pg_net issues)
    try {
      console.log(`Sending direct webhook for ${requestId}`);

      const webhookResponse = await fetch(request.coda_webhook_url, {
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

      if (webhookResponse.ok) {
        console.log(`Direct webhook delivered: ${webhookResponse.status}`);
      } else {
        console.log(`Direct webhook failed: ${webhookResponse.status}`);
      }
    } catch (webhookError) {
      console.log(`Direct webhook error: ${webhookError.message}`);
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

function removeSignaturesFromResponse(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => removeSignaturesFromResponse(item));
  }

  const cleaned = {};

  for (const [key, value] of Object.entries(obj)) {
    // Remove signature fields (they're just bloat for Coda)
    if (key === 'signature') {
      continue;
    }

    // Recursively clean nested objects
    cleaned[key] = removeSignaturesFromResponse(value);
  }

  return cleaned;
}

async function callClaudeAPI(payload) {
  const startTime = Date.now();

  try {
    // =================== INPUT VALIDATION ===================

    // Extract the pre-built Claude request and metadata
    const { claudeRequest, userApiKey, requestId } = payload;

    if (!claudeRequest) {
      throw new Error('No claudeRequest found in payload - ensure Pack is sending complete request');
    }

    // Validate claudeRequest structure
    if (!claudeRequest.model) {
      throw new Error('Invalid claudeRequest: missing model field');
    }

    if (!claudeRequest.messages || !Array.isArray(claudeRequest.messages)) {
      throw new Error('Invalid claudeRequest: messages must be an array');
    }

    if (claudeRequest.messages.length === 0) {
      throw new Error('Invalid claudeRequest: messages array is empty');
    }

    // =================== API KEY VALIDATION ===================

    // Use system API key (until Pack auth is fixed)
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new Error('No system API key configured in environment variables');
    }

    // Validate API key format and length
    if (apiKey.length < 50) {
      throw new Error(`Invalid API key: length=${apiKey.length}, expected >50 chars (current key may be truncated)`);
    }

    if (!apiKey.startsWith('sk-ant-')) {
      console.warn(`⚠️ API key doesn't start with expected prefix 'sk-ant-' - this may indicate a configuration issue`);
    }

    console.log(`✅ API Key validation passed - Length: ${apiKey.length}, Prefix: ${apiKey.substring(0, 10)}...`);

    // =================== REQUEST LOGGING ===================

    const requestSummary = {
      requestId: requestId || 'unknown',
      model: claudeRequest.model,
      messageCount: claudeRequest.messages.length,
      hasSystem: !!claudeRequest.system,
      hasTools: !!claudeRequest.tools,
      hasThinking: !!claudeRequest.thinking,
      maxTokens: claudeRequest.max_tokens,
      temperature: claudeRequest.temperature
    };

    console.log(`📤 Sending request to Claude API:`, JSON.stringify(requestSummary, null, 2));

    // Log full request in development (but truncate for production to avoid log spam)
    if (process.env.NODE_ENV === 'development') {
      console.log('Full request payload:', JSON.stringify(claudeRequest, null, 2));
    }

    // =================== API REQUEST WITH RETRY LOGIC ===================

    let lastError;
    const maxRetries = 2; // Total of 3 attempts (1 initial + 2 retries)

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // Exponential backoff: 1s, 2s, 5s max
          console.log(`⏳ Retry attempt ${attempt}/${maxRetries} after ${backoffMs}ms delay...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }

        // Create AbortController for timeout
        const controller = new AbortController();
        const timeoutMs = 720000; // 12 minutes
        const timeoutId = setTimeout(() => {
          controller.abort();
          console.error(`⏰ Request timeout after ${timeoutMs}ms`);
        }, timeoutMs);

        console.log(`🚀 Attempt ${attempt + 1}: Sending request to Claude API...`);

        // Send the request exactly as built by the Pack
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'User-Agent': 'Vercel-Function/1.0'
          },
          body: JSON.stringify(claudeRequest),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        const responseTime = Date.now() - startTime;
        console.log(`📡 Response received in ${responseTime}ms with status: ${response.status}`);

        // =================== RESPONSE STATUS HANDLING ===================

        if (response.ok) {
          // Success case
          const responseData = await response.json();

          // Validate response structure
          if (!responseData.content) {
            throw new Error('Invalid Claude response: missing content field');
          }

          console.log(`✅ Claude API success:`, {
            model: responseData.model,
            usage: responseData.usage,
            contentLength: responseData.content?.[0]?.text?.length || 0,
            hasThinking: responseData.content?.some(item => item.type === 'thinking'),
            responseTimeMs: responseTime
          });

          return responseData;

        } else {
          // Handle different error status codes
          const errorText = await response.text();
          let errorDetails;

          try {
            errorDetails = JSON.parse(errorText);
          } catch {
            errorDetails = { message: errorText };
          }

          const error = new Error(`Claude API error (${response.status}): ${errorDetails.error?.message || errorDetails.message || errorText}`);
          error.status = response.status;
          error.details = errorDetails;

          // Determine if this error is retryable
          const retryableStatuses = [429, 500, 502, 503, 504]; // Rate limit, server errors
          const isRetryable = retryableStatuses.includes(response.status);

          console.error(`❌ Claude API error (attempt ${attempt + 1}):`, {
            status: response.status,
            error: errorDetails.error?.message || errorDetails.message,
            type: errorDetails.error?.type,
            isRetryable,
            willRetry: isRetryable && attempt < maxRetries
          });

          // Rate limiting specific handling
          if (response.status === 429) {
            const retryAfter = response.headers.get('retry-after');
            if (retryAfter) {
              console.log(`⏱️ Rate limited. Retry after: ${retryAfter} seconds`);
            }
          }

          // Don't retry on client errors (except rate limiting)
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            throw error;
          }

          lastError = error;

          // If this was the last attempt, throw the error
          if (attempt >= maxRetries) {
            throw error;
          }

          // Otherwise continue to retry
        }

      } catch (fetchError) {
        // Handle fetch/network errors
        lastError = fetchError;

        const isTimeoutError = fetchError.name === 'AbortError';
        const isNetworkError = fetchError.name === 'TypeError' && fetchError.message.includes('fetch');
        const isRetryableError = isTimeoutError || isNetworkError;

        console.error(`💥 Network/fetch error (attempt ${attempt + 1}):`, {
          name: fetchError.name,
          message: fetchError.message,
          isTimeout: isTimeoutError,
          isNetwork: isNetworkError,
          willRetry: isRetryableError && attempt < maxRetries
        });

        // Don't retry on non-retryable fetch errors
        if (!isRetryableError || attempt >= maxRetries) {
          if (isTimeoutError) {
            throw new Error(`Request timeout after 12 minutes - Claude API may be experiencing delays`);
          }

          if (isNetworkError) {
            throw new Error(`Network error connecting to Claude API: ${fetchError.message}`);
          }

          throw fetchError;
        }

        // Continue to retry for retryable errors
      }
    }

    // If we somehow get here, throw the last error
    throw lastError || new Error('Unknown error in Claude API call');

  } catch (error) {
    // =================== FINAL ERROR HANDLING ===================

    const totalTime = Date.now() - startTime;

    console.error('❌ Claude API call failed:', {
      requestId: payload.requestId || 'unknown',
      error: error.message,
      errorType: error.constructor.name,
      status: error.status,
      totalTimeMs: totalTime,
      stack: error.stack?.substring(0, 500)
    });

    // Enhance error message with context
    if (error.message.includes('fetch failed')) {
      throw new Error(`Claude API connection failed (${totalTime}ms): This usually indicates network issues or API key problems. Original error: ${error.message}`);
    }

    if (error.message.includes('timeout')) {
      throw new Error(`Claude API timeout (${totalTime}ms): Request took longer than 12 minutes. This may indicate a very complex request or API performance issues.`);
    }

    // Re-throw with enhanced context
    throw new Error(`Claude API error after ${totalTime}ms: ${error.message}`);
  }
}

// =================== HELPER FUNCTIONS ===================

// Optional: Add a health check function
async function checkClaudeAPIHealth() {
  try {
    const testPayload = {
      claudeRequest: {
        model: "claude-sonnet-4-20250514",
        max_tokens: 10,
        messages: [{ role: "user", content: "Hi" }]
      },
      requestId: "health_check"
    };

    const result = await callClaudeAPI(testPayload);
    return { healthy: true, response: result.content?.[0]?.text };
  } catch (error) {
    return { healthy: false, error: error.message };
  }
}

function processClaudeResponseWithSizeControl(claudeResponse, requestPayload) {
  const { modelPricing, responseOptions } = requestPayload;

  // ALWAYS remove signatures (they're just bloat)
  let finalResponse = removeSignaturesFromResponse(claudeResponse);
  const processingLog = [];

  // Calculate original size AFTER signature removal
  const originalSize = JSON.stringify(finalResponse).length;
  processingLog.push(`Original response size: ${originalSize} characters`);

  // Only apply citation cleaning if web search was enabled
  if (responseOptions?.webSearch) {
    processingLog.push('Web search detected, applying citation cleaning...');
    console.log('Web search detected, applying citation cleaning...');

    let cleanedResponse;
    try {
      cleanedResponse = deepCleanResponseWithCitations(claudeResponse);
    } catch (cleaningError) {
      console.error('Cleaning failed, using original response:', cleaningError);
      processingLog.push(`Cleaning failed: ${cleaningError.message}, using original response`);
    }

    if (cleanedResponse) {
      const responseSize = JSON.stringify(cleanedResponse).length;
      processingLog.push(`Response size after cleaning: ${responseSize} characters`);

      if (responseSize > 45000) {
        processingLog.push('Response still too large, applying aggressive cleaning...');
        try {
          cleanedResponse = aggressiveCleanResponseWithCitations(claudeResponse);
          const newSize = JSON.stringify(cleanedResponse).length;
          processingLog.push(`Final size after aggressive cleaning: ${newSize} characters`);
        } catch (aggressiveError) {
          console.error('Aggressive cleaning failed:', aggressiveError);
        }
      }

      finalResponse = cleanedResponse;
    }
  } else {
    processingLog.push('No web search used, skipping response cleaning');
  }

  // Add cost calculation (always included)
  if (modelPricing && claudeResponse.usage) {
    const { input_tokens, output_tokens } = claudeResponse.usage;
    const inputCost = (input_tokens / 1000000) * modelPricing.input;
    const outputCost = (output_tokens / 1000000) * modelPricing.output;

    finalResponse.cost = {
      model: requestPayload.claudeRequest?.model || 'claude-sonnet-4-20250514',
      inputTokens: input_tokens,
      outputTokens: output_tokens,
      inputCost: parseFloat(inputCost.toFixed(6)),
      outputCost: parseFloat(outputCost.toFixed(6)),
      totalCost: parseFloat((inputCost + outputCost).toFixed(6)),
      currency: 'USD'
    };
  }

  // Add metadata
  finalResponse.requestId = requestPayload.requestId;
  finalResponse.completedAt = new Date().toISOString();

  // NEW: Handle response format based on includeWrapper parameter
  if (responseOptions?.includeWrapper) {
    // Return full Claude response with metadata
    finalResponse._processingInfo = {
      webSearchEnabled: !!responseOptions?.webSearch,
      cleaningApplied: !!responseOptions?.webSearch,
      originalSizeChars: originalSize,
      finalSizeChars: JSON.stringify(finalResponse).length,
      processingLog: processingLog,
      jsonContentMode: !!responseOptions?.jsonContent,
      includeWrapperMode: true
    };

    return finalResponse;
  } else {
    // Return simplified format with just content
    return {
      content: finalResponse.content?.[0]?.text || '',
      requestId: requestPayload.requestId,
      completedAt: new Date().toISOString(),
      ...(finalResponse.cost && { cost: finalResponse.cost }),
      _processingInfo: {
        webSearchEnabled: !!responseOptions?.webSearch,
        cleaningApplied: !!responseOptions?.webSearch,
        jsonContentMode: !!responseOptions?.jsonContent,
        includeWrapperMode: false,
        processingLog: processingLog
      }
    };
  }
}

// Consolidate content array into object by type
function consolidateContentByType(contentArray) {
  const consolidated = {};

  for (const item of contentArray) {
    if (!item.type) continue;

    const type = item.type;

    // Initialize the type if it doesn't exist
    if (!consolidated[type]) {
      consolidated[type] = '';
    }

    // Handle different content types
    switch (type) {
      case 'text':
        // Join text content with newlines
        if (item.text) {
          consolidated[type] += (consolidated[type] ? '\n\n' : '') + item.text;
        }
        break;

      case 'thinking':
        // Join thinking content with newlines
        if (item.thinking) {
          consolidated[type] += (consolidated[type] ? '\n\n' : '') + item.thinking;
        }
        break;

      case 'web_search_tool_result':
        // For web search results, preserve the structure but consolidate
        if (!consolidated[type]) {
          consolidated[type] = {
            type: 'web_search_tool_result',
            content: []
          };
        }
        if (item.content && Array.isArray(item.content)) {
          consolidated[type].content.push(...item.content);
        }
        break;

      default:
        // For other types, try to extract meaningful content
        if (item.text) {
          consolidated[type] += (consolidated[type] ? '\n\n' : '') + item.text;
        } else if (typeof item === 'object') {
          // For complex objects, store as JSON string (you might want to handle this differently)
          consolidated[type] += (consolidated[type] ? '\n\n' : '') + JSON.stringify(item, null, 2);
        }
        break;
    }
  }

  // Clean up empty entries
  Object.keys(consolidated).forEach(key => {
    if (consolidated[key] === '' || (typeof consolidated[key] === 'object' && !consolidated[key].content?.length)) {
      delete consolidated[key];
    }
  });

  return consolidated;
}

function deepCleanResponseWithCitations(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => deepCleanResponseWithCitations(item));
  }

  const cleaned = {};

  for (const [key, value] of Object.entries(obj)) {
    // Remove encrypted fields that consume massive space
    if (key === 'encrypted_content' || key === 'encrypted_index') {
      continue;
    }

    // Special handling for content arrays (rebuild citations)
    if (key === 'content' && Array.isArray(value)) {
      cleaned[key] = rebuildContentWithCitations(value);
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
    cleaned[key] = deepCleanResponseWithCitations(value);
  }

  return cleaned;
}

function rebuildContentWithCitations(contentArray) {
  const citationRegistry = new Map();
  let citationCounter = 1;
  const processedContent = [];

  // First pass: collect all citations and assign numbers
  for (const item of contentArray) {
    // Handle web search citations (separate citation objects)
    if (item.type === 'text' && item.citations && Array.isArray(item.citations)) {
      for (const citation of item.citations) {
        if (citation.url && !citationRegistry.has(citation.url)) {
          citationRegistry.set(citation.url, {
            number: citationCounter++,
            title: citation.title || 'Unknown Source',
            url: citation.url,
            cited_text: citation.cited_text || '',
            type: 'web_search'
          });
        }
      }
    }

    // Handle embedded cite tags in text
    if (item.type === 'text' && item.text) {
      // Handle escaped cite tags: <cite index=\"...\">content</cite>
      const escapedCiteRegex = /<cite index=\\"([^\\]+)\\">([^<]+)<\/cite>/g;
      // Handle normal cite tags: <cite index="...">content</cite>  
      const normalCiteRegex = /<cite index="([^"]+)">([^<]+)<\/cite>/g;

      let match;
      // Check for escaped citations first
      while ((match = escapedCiteRegex.exec(item.text)) !== null) {
        const [fullMatch, indexInfo, citedText] = match;
        const citationKey = `doc_${indexInfo}`;

        if (!citationRegistry.has(citationKey)) {
          citationRegistry.set(citationKey, {
            number: citationCounter++,
            title: `Source ${indexInfo}`,
            url: null,
            cited_text: citedText,
            index: indexInfo,
            type: 'document'
          });
        }
      }

      // Then check for normal citations
      while ((match = normalCiteRegex.exec(item.text)) !== null) {
        const [fullMatch, indexInfo, citedText] = match;
        const citationKey = `doc_${indexInfo}`;

        if (!citationRegistry.has(citationKey)) {
          citationRegistry.set(citationKey, {
            number: citationCounter++,
            title: `Source ${indexInfo}`,
            url: null,
            cited_text: citedText,
            index: indexInfo,
            type: 'document'
          });
        }
      }
    }
  }

  // Second pass: rebuild content with citation markers
  for (const item of contentArray) {
    if (item.type === 'text') {
      let processedText = item.text || '';

      // Handle embedded cite tags - replace with footnote markers
      if (processedText.includes('<cite')) {
        // Handle escaped cite tags first: <cite index=\"...\">
        const escapedCiteRegex = /<cite index=\\"([^\\]+)\\">([^<]+)<\/cite>/g;
        processedText = processedText.replace(escapedCiteRegex, (match, indexInfo, citedText) => {
          const citationKey = `doc_${indexInfo}`;
          const citation = citationRegistry.get(citationKey);
          return citation ? `${citedText}[^${citation.number}]` : citedText;
        });

        // Then handle normal cite tags: <cite index="...">
        const normalCiteRegex = /<cite index="([^"]+)">([^<]+)<\/cite>/g;
        processedText = processedText.replace(normalCiteRegex, (match, indexInfo, citedText) => {
          const citationKey = `doc_${indexInfo}`;
          const citation = citationRegistry.get(citationKey);
          return citation ? `${citedText}[^${citation.number}]` : citedText;
        });
      }

      // Handle web search citations (separate citation objects)
      if (item.citations && Array.isArray(item.citations) && item.citations.length > 0) {
        const citationMarkers = item.citations
          .filter(c => c.url && citationRegistry.has(c.url))
          .map(c => `[^${citationRegistry.get(c.url).number}]`)
          .join('');

        processedText += citationMarkers;
      }

      processedContent.push({
        type: 'text',
        text: processedText
      });
    }
    // Skip all other content types - we only need the final consolidated text
  }

  // Add footnotes section if we have citations
  if (citationRegistry.size > 0) {
    const webSearchCitations = Array.from(citationRegistry.values()).filter(c => c.type === 'web_search');
    const documentCitations = Array.from(citationRegistry.values()).filter(c => c.type === 'document');

    let footnotesText = '\n\n---\n\n**Sources:**\n\n';

    // Add web search citations with URLs
    webSearchCitations
      .sort((a, b) => a.number - b.number)
      .forEach(citation => {
        footnotesText += `[^${citation.number}]: [${citation.title}](${citation.url})\n`;
      });

    // Add document citations without URLs
    documentCitations
      .sort((a, b) => a.number - b.number)
      .forEach(citation => {
        footnotesText += `[^${citation.number}]: ${citation.cited_text} (Index: ${citation.index})\n`;
      });

    processedContent.push({
      type: 'text',
      text: footnotesText
    });
  }

  // CONSOLIDATE ALL TEXT OBJECTS INTO ONE MARKDOWN DOCUMENT
  const allTextContent = processedContent
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('');

  // Keep non-text content (like web search results) but simplified
  const nonTextContent = processedContent.filter(item => item.type !== 'text');

  // Return consolidated structure
  return [
    {
      type: 'text',
      text: allTextContent
    },
    ...nonTextContent
  ];
}

function aggressiveCleanResponseWithCitations(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => aggressiveCleanResponseWithCitations(item));
  }

  const cleaned = {};

  for (const [key, value] of Object.entries(obj)) {
    // Remove all encrypted fields
    if (key === 'encrypted_content' || key === 'encrypted_index') {
      continue;
    }

    // Special handling for content arrays (rebuild citations with limits)
    if (key === 'content' && Array.isArray(value)) {
      cleaned[key] = rebuildContentWithCitationsAggressive(value);
      continue;
    }

    // For web_search_tool_result content, keep only essential results
    if (key === 'content' && obj.type === 'web_search_tool_result') {
      // Limit to first 5 search results to control size
      if (Array.isArray(value)) {
        cleaned[key] = value.slice(0, 5).map(item => aggressiveCleanResponseWithCitations(item));
      } else {
        cleaned[key] = aggressiveCleanResponseWithCitations(value);
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
      if (['type', 'url', 'title'].includes(key)) {  // Remove cited_text to save space
        cleaned[key] = value;
      }
      continue;
    }

    // Recursively clean other objects
    cleaned[key] = aggressiveCleanResponseWithCitations(value);
  }

  return cleaned;
}

function rebuildContentWithCitationsAggressive(contentArray) {
  const citationRegistry = new Map();
  let citationCounter = 1;
  const processedContent = [];

  // First pass: collect citations (limit to 20 unique sources)
  for (const item of contentArray) {
    // Handle web search citations
    if (item.type === 'text' && item.citations && Array.isArray(item.citations)) {
      for (const citation of item.citations) {
        if (citation.url && !citationRegistry.has(citation.url) && citationRegistry.size < 20) {
          citationRegistry.set(citation.url, {
            number: citationCounter++,
            title: (citation.title || 'Source').substring(0, 100), // Truncate titles
            url: citation.url,
            type: 'web_search'
          });
        }
      }
    }

    // Handle embedded cite tags
    if (item.type === 'text' && item.text && citationRegistry.size < 20) {
      // Handle both escaped and unescaped cite tags
      const escapedCiteRegex = /<cite index=\\"([^\\]+)\\">([^<]+)<\/cite>/g;
      const normalCiteRegex = /<cite index="([^"]+)">([^<]+)<\/cite>/g;

      let match;
      // Check escaped citations first
      while ((match = escapedCiteRegex.exec(item.text)) !== null && citationRegistry.size < 20) {
        const [fullMatch, indexInfo, citedText] = match;
        const citationKey = `doc_${indexInfo}`;

        if (!citationRegistry.has(citationKey)) {
          citationRegistry.set(citationKey, {
            number: citationCounter++,
            title: `Source ${indexInfo}`,
            url: null,
            cited_text: citedText.substring(0, 200), // Truncate cited text
            index: indexInfo,
            type: 'document'
          });
        }
      }

      // Then check normal citations
      while ((match = normalCiteRegex.exec(item.text)) !== null && citationRegistry.size < 20) {
        const [fullMatch, indexInfo, citedText] = match;
        const citationKey = `doc_${indexInfo}`;

        if (!citationRegistry.has(citationKey)) {
          citationRegistry.set(citationKey, {
            number: citationCounter++,
            title: `Source ${indexInfo}`,
            url: null,
            cited_text: citedText.substring(0, 200), // Truncate cited text
            index: indexInfo,
            type: 'document'
          });
        }
      }
    }
  }

  // Second pass: rebuild content with citation markers
  for (const item of contentArray) {
    if (item.type === 'text') {
      let processedText = item.text || '';

      // Handle embedded cite tags
      if (processedText.includes('<cite')) {
        // Handle escaped cite tags first
        const escapedCiteRegex = /<cite index=\\"([^\\]+)\\">([^<]+)<\/cite>/g;
        processedText = processedText.replace(escapedCiteRegex, (match, indexInfo, citedText) => {
          const citationKey = `doc_${indexInfo}`;
          const citation = citationRegistry.get(citationKey);
          return citation ? `${citedText}[^${citation.number}]` : citedText;
        });

        // Then handle normal cite tags
        const normalCiteRegex = /<cite index="([^"]+)">([^<]+)<\/cite>/g;
        processedText = processedText.replace(normalCiteRegex, (match, indexInfo, citedText) => {
          const citationKey = `doc_${indexInfo}`;
          const citation = citationRegistry.get(citationKey);
          return citation ? `${citedText}[^${citation.number}]` : citedText;
        });
      }

      // Handle web search citations
      if (item.citations && Array.isArray(item.citations) && item.citations.length > 0) {
        const citationMarkers = item.citations
          .filter(c => c.url && citationRegistry.has(c.url))
          .map(c => `[^${citationRegistry.get(c.url).number}]`)
          .join('');

        processedText += citationMarkers;
      }

      processedContent.push({
        type: 'text',
        text: processedText
      });
    }
    // Skip all other content types - we only need the final consolidated text
  }

  // Add compact footnotes section
  if (citationRegistry.size > 0) {
    const webSearchCitations = Array.from(citationRegistry.values()).filter(c => c.type === 'web_search');
    const documentCitations = Array.from(citationRegistry.values()).filter(c => c.type === 'document');

    let footnotesText = '\n\n**Sources:** ';

    const allCitations = [...webSearchCitations, ...documentCitations]
      .sort((a, b) => a.number - b.number);

    footnotesText += allCitations.map(citation => {
      if (citation.type === 'web_search') {
        return `[^${citation.number}]: [${citation.title}](${citation.url})`;
      } else {
        return `[^${citation.number}]: ${citation.cited_text}`;
      }
    }).join(' • ');

    processedContent.push({
      type: 'text',
      text: footnotesText
    });
  }

  // CONSOLIDATE ALL TEXT OBJECTS INTO ONE MARKDOWN DOCUMENT
  const allTextContent = processedContent
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('');

  // Return just the consolidated markdown text for Coda
  // All citation information is now embedded in the text
  return [
    {
      type: 'text',
      text: allTextContent
    }
  ];
}