// =================================================================
// DEV NOTES for api/process-queue.js (Updated 2025-09-12)
// =================================================================
/*

SIMPLIFIED AND ROBUST PROCESSING:
- Returns Claude's standard response wrapper with minimal changes  
- Extracts citations into separate parsable section with proper structure
- Limits individual text fields to 45k characters
- Keeps selective cleaning of sensitive fields only
- Ensures thinking, citations, and main response are easily parsable

ROLE SEPARATION:
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

TIMEOUT RESOLUTION (2025-09-09):
=====================================

PROBLEM SOLVED: Complex requests with thinking failing after exactly 5 minutes
- Root cause: Node.js/undici default HTTP timeout of 300 seconds (5 minutes)
- Symptom: "fetch failed" errors for hasThinking requests at 300s mark
- Investigation: Multiple timeout layers identified and systematically eliminated

SOLUTION IMPLEMENTED: undici Agent with extended timeouts
- Added undici@6.0.0 dependency to package.json
- Global dispatcher configuration extends all fetch timeouts to 15 minutes
- Covers: connection timeout, headers timeout, body timeout
*/

import { createClient } from '@supabase/supabase-js';
 
import { setGlobalDispatcher, Agent } from 'undici';

// This extends the timeout globally for all fetch requests in this function
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
  maxDuration: 800, // 13+ minutes (Pro plan limit)
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { requestId } = req.body;

  try {
    console.log(`Processing request ${requestId}`);
    console.log(`🎯 Triggered by: ${req.headers['user-agent'] || 'Unknown'}`);
    console.log(`📊 Trigger source details:`, {
      userAgent: req.headers['user-agent'],
      contentLength: req.headers['content-length'],
      requestSource: req.headers['user-agent']?.includes('Supabase') ? 'pg_net' : 'other'
    });

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
      if (processingTime < 1200000) { // 20 minutes
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

// Remove only specific sensitive fields that cause major bloat
function removeSpecificSensitiveFields(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => removeSpecificSensitiveFields(item));
  }

  const cleaned = {};

  for (const [key, value] of Object.entries(obj)) {
    // Remove only the most problematic fields
    if (key === 'signature' || key === 'encrypted_content' || key === 'encrypted_index') {
      continue;
    }

    // Recursively process nested objects
    cleaned[key] = removeSpecificSensitiveFields(value);
  }

  return cleaned;
}

// Limit individual text fields to 45k characters
function limitTextFieldSizes(obj, processingLog = []) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => limitTextFieldSizes(item, processingLog));
  }

  const processed = {};
  const MAX_TEXT_LENGTH = 45000;

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && value.length > MAX_TEXT_LENGTH) {
      processed[key] = value.substring(0, MAX_TEXT_LENGTH) + '... [TRUNCATED]';
      processingLog.push(`Truncated field '${key}' from ${value.length} to ${MAX_TEXT_LENGTH} characters`);
    } else {
      processed[key] = limitTextFieldSizes(value, processingLog);
    }
  }

  return processed;
}

// Extract citations into a separate parsable section
function extractAndFormatCitations(response) {
  const citations = [];
  const citationMap = new Map();
  let citationId = 1;

  function processContent(content) {
    if (!content || !Array.isArray(content)) return;

    for (const item of content) {
      // Handle standard Claude API citations format
      if (item.citations && Array.isArray(item.citations)) {
        for (const citation of item.citations) {
          const key = citation.document_title + citation.cited_text + citation.document_index;
          if (!citationMap.has(key)) {
            citationMap.set(key, {
              id: citationId++,
              type: 'citation',
              document_title: citation.document_title,
              document_index: citation.document_index,
              cited_text: citation.cited_text,
              location_type: citation.type,
              ...(citation.start_char_index !== undefined && {
                start_char_index: citation.start_char_index,
                end_char_index: citation.end_char_index
              }),
              ...(citation.start_page_number !== undefined && {
                start_page_number: citation.start_page_number,
                end_page_number: citation.end_page_number
              }),
              ...(citation.start_block_index !== undefined && {
                start_block_index: citation.start_block_index,
                end_block_index: citation.end_block_index
              })
            });
          }
        }
      }

      // Handle web search citations (legacy format from your current system)
      if (item.type === 'text' && item.text) {
        // Extract <cite> tags from text
        const citeRegex = /<cite[^>]*index="([^"]+)"[^>]*>([^<]+)<\/cite>/g;
        let match;
        while ((match = citeRegex.exec(item.text)) !== null) {
          const [, index, citedText] = match;
          const key = `legacy_${index}_${citedText}`;
          if (!citationMap.has(key)) {
            citationMap.set(key, {
              id: citationId++,
              type: 'citation',
              source_type: 'legacy_cite_tag',
              index: index,
              cited_text: citedText
            });
          }
        }
      }

      // Handle tool results with search data
      if (item.type === 'web_search_tool_result' && item.content) {
        for (const searchItem of item.content) {
          if (searchItem.type === 'web_search_result' && searchItem.url && searchItem.title) {
            const key = `web_${searchItem.url}`;
            if (!citationMap.has(key)) {
              citationMap.set(key, {
                id: citationId++,
                type: 'citation',
                source_type: 'web_search_result',
                title: searchItem.title,
                url: searchItem.url,
                ...(searchItem.page_age && { page_age: searchItem.page_age })
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

// Ensure thinking, citations, and main response are easily parsable
function ensureParsableStructure(response, processingLog) {
  const structured = { ...response };
  
  // Create consistent parsed sections for easy access
  structured.parsed_content = {
    main_text: '',
    thinking: '',
    citations: structured.citations || []
  };
  
  // Extract main content and thinking from content array
  if (structured.content && Array.isArray(structured.content)) {
    for (const item of structured.content) {
      if (item.type === 'text' && item.text) {
        structured.parsed_content.main_text += (structured.parsed_content.main_text ? '\n\n' : '') + item.text;
      } else if (item.type === 'thinking' && item.thinking) {
        structured.parsed_content.thinking += (structured.parsed_content.thinking ? '\n\n' : '') + item.thinking;
      }
    }
    
    processingLog.push('Created parsed_content structure for easy access');
  }
  
  // Ensure fields don't exceed 45k limit
  const MAX_LENGTH = 45000;
  if (structured.parsed_content.main_text.length > MAX_LENGTH) {
    structured.parsed_content.main_text = structured.parsed_content.main_text.substring(0, MAX_LENGTH) + '... [TRUNCATED]';
    processingLog.push('Truncated main_text in parsed_content');
  }
  
  if (structured.parsed_content.thinking.length > MAX_LENGTH) {
    structured.parsed_content.thinking = structured.parsed_content.thinking.substring(0, MAX_LENGTH) + '... [TRUNCATED]';
    processingLog.push('Truncated thinking in parsed_content');
  }
  
  return structured;
}

async function callClaudeAPI(payload) {
  const startTime = Date.now();

  try {
    // =================== INPUT VALIDATION ===================

    // Extract the pre-built Claude request and metadata
    const { claudeRequest } = payload;

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
      requestId: payload.requestId || 'unknown',
      model: claudeRequest.model,
      messageCount: claudeRequest.messages.length,
      hasSystem: !!claudeRequest.system,
      hasTools: !!claudeRequest.tools,
      hasThinking: !!claudeRequest.thinking,
      thinkingBudget: claudeRequest.thinking?.budget_tokens,
      maxTokens: claudeRequest.max_tokens,
      temperature: claudeRequest.temperature
    };

    console.log(`📤 Sending request to Claude API:`, JSON.stringify(requestSummary, null, 2));
    console.log(`⏱️ Timeout layers: undici=12min, abort=11min, vercel=13.3min`);

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
        const timeoutMs = 660000; // 11 minutes
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

function processClaudeResponseWithSizeControl(claudeResponse, requestPayload) {
  const { modelPricing } = requestPayload;
  const processingLog = [];

  // Start with Claude's standard response wrapper - minimal changes
  let processedResponse = { ...claudeResponse };
  
  // Remove only the most problematic fields (encrypted content, signatures)
  processedResponse = removeSpecificSensitiveFields(processedResponse);
  
  // Apply 45k character limit to individual text fields
  processedResponse = limitTextFieldSizes(processedResponse, processingLog);
  
  // Extract and format citations as separate parsable section
  const citations = extractAndFormatCitations(processedResponse);
  if (citations.length > 0) {
    processedResponse.citations = citations;
    processingLog.push(`Extracted ${citations.length} citations`);
  }
  
  // Ensure consistent parsable structure for main components
  processedResponse = ensureParsableStructure(processedResponse, processingLog);

  // Add cost calculation (always included)
  if (modelPricing && claudeResponse.usage) {
    const { input_tokens, output_tokens } = claudeResponse.usage;
    const inputCost = (input_tokens / 1000000) * modelPricing.input;
    const outputCost = (output_tokens / 1000000) * modelPricing.output;

    processedResponse.cost = {
      model: requestPayload.claudeRequest?.model || 'claude-sonnet-4-20250514',
      inputTokens: input_tokens,
      outputTokens: output_tokens,
      inputCost: parseFloat(inputCost.toFixed(6)),
      outputCost: parseFloat(outputCost.toFixed(6)),
      totalCost: parseFloat((inputCost + outputCost).toFixed(6)),
      currency: 'USD'
    };
  }

  // Add minimal metadata
  processedResponse.requestId = requestPayload.requestId;
  processedResponse.completedAt = new Date().toISOString();
  
  // Add processing info
  processedResponse._processingInfo = {
    originalSizeChars: JSON.stringify(claudeResponse).length,
    finalSizeChars: JSON.stringify(processedResponse).length,
    citationsExtracted: citations.length,
    processingLog: processingLog
  };

  return processedResponse;
}