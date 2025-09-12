// =================================================================
// DEV NOTES for api/process-queue.js (Updated 2025-09-09)
// =================================================================
/*

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

CODE CHANGES:
import { setGlobalDispatcher, Agent } from 'undici';

setGlobalDispatcher(new Agent({
  connect: { timeout: 900_000 }, // 15 minutes (900 seconds)
  headersTimeout: 900_000,       // 15 minutes for headers
  bodyTimeout: 900_000           // 15 minutes for response body
}));

INVESTIGATION TIMELINE:
1. Eliminated pg_net trigger conflicts (proved not the issue)
2. Extended pg_net timeout to 15 minutes (necessary but insufficient)
3. Added comprehensive logging (revealed exact 5-minute timing)
4. Identified infrastructure-level HTTP timeout as root cause
5. Implemented undici Agent solution (resolved issue)

CURRENT STATUS:
- ✅ Simple requests: <5 minutes, work perfectly (unchanged)
- ✅ Complex requests: 5-15 minutes, now complete successfully
- ✅ pg_net trigger: 15-minute timeout, reliable auto-processing
- ✅ Webhook delivery: Reliable completion notifications
- ✅ System stability: No regressions, enhanced error handling

TIMEOUT HIERARCHY (all components now aligned):
1. undici Agent: 15 minutes (extended via solution)
2. Vercel function: 13+ minutes (maxDuration: 800)
3. Claude API application: 12 minutes (AbortController in retry logic)
4. pg_net trigger: 15 minutes (extended in Step 4 of investigation)

ROLLBACK PLAN:
- Comment out undici import and setGlobalDispatcher lines
- Remove undici from package.json dependencies
- System reverts to 5-minute timeout behavior

PERFORMANCE IMPACT:
- Simple requests: No change in performance
- Complex requests: Now complete instead of failing
- System overhead: Minimal, only affects timeout limits
- Error handling: Enhanced with timeout-specific diagnostics

ALTERNATIVE SOLUTIONS CONSIDERED:
- Streaming implementation: Rejected (too complex, high risk)
- Request splitting: Rejected (architectural complexity)
- AbortSignal.timeout(): Rejected (less comprehensive than undici)
- Per-request agents: Rejected (global policy simpler)

LESSONS LEARNED:
- Infrastructure timeouts can override application timeouts
- Systematic layer-by-layer investigation essential for complex issues
- Conservative timeout values better than aggressive optimization
- Global timeout policies simpler than per-request configuration
- Always maintain rollback capability for timeout changes

FILES MODIFIED IN TIMEOUT RESOLUTION:
- process-queue.js: Added undici import and global dispatcher
- package.json: Added undici@6.0.0 dependency
- trigger_processing(): Extended pg_net timeout to 15 minutes + logging
- send_completion_webhook(): Enhanced logging for monitoring
- webhook_logs table: Tracks pg_net request lifecycle

TODO: Investigate Pack authentication to restore user API key functionality
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
            'User-Agent': 'Vercel-Function/1.0',
            // 'Connection': 'keep-alive', // DO NOT USE. Will break. Use streaming instead.
            // 'Keep-Alive': 'timeout=720' 
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

function processClaudeResponseWithSizeControl(claudeResponse, requestPayload) {
  const { modelPricing, responseOptions } = requestPayload;
  const logs = [];

  // 1) drop signatures (lightweight)
  let finalResponse = removeSignaturesFromResponse(claudeResponse);
  const originalSize = JSON.stringify(finalResponse).length;
  logs.push(`Original response size: ${originalSize} characters`);

  // 2) format citations (only when web search used)
  if (responseOptions?.webSearch) {
    logs.push("Web search detected, formatting citations…");
    try { finalResponse = formatCitationsInPlace(finalResponse); }
    catch (e) { logs.push(`Citation formatting failed: ${e.message}`); }
  } else {
    logs.push("No web search used, skipping citation formatting");
  }

  // 3) cap every text string at 45k (skip content[0].text if jsonContent=true)
  try {
    finalResponse = capResponseTextFields(finalResponse, {
      jsonContent: !!responseOptions?.jsonContent,
      limit: 45000,
    });
  } catch (e) {
    logs.push(`Cap step failed: ${e.message}`);
  }

  // 4) cost (unchanged)
  if (modelPricing && finalResponse.usage) {
    const { input_tokens, output_tokens } = finalResponse.usage;
    const inputCost = (input_tokens / 1_000_000) * modelPricing.input;
    const outputCost = (output_tokens / 1_000_000) * modelPricing.output;
    finalResponse.cost = {
      model: requestPayload.claudeRequest?.model || "claude-sonnet-4-20250514",
      inputTokens: input_tokens,
      outputTokens: output_tokens,
      inputCost: +inputCost.toFixed(6),
      outputCost: +outputCost.toFixed(6),
      totalCost: +(inputCost + outputCost).toFixed(6),
      currency: "USD",
    };
  }

  // 5) metadata (unchanged)
  finalResponse.requestId = requestPayload.requestId;
  finalResponse.completedAt = new Date().toISOString();

  // 6) return wrapper or simplified (your existing logic)
  if (responseOptions?.includeWrapper) {
    finalResponse._processingInfo = {
      webSearchEnabled: !!responseOptions?.webSearch,
      cleaningApplied: false,
      originalSizeChars: originalSize,
      finalSizeChars: JSON.stringify(finalResponse).length,
      processingLog: logs,
      jsonContentMode: !!responseOptions?.jsonContent,
      includeWrapperMode: true,
      citationsFormatted: !!responseOptions?.webSearch,
      textCapLimit: 45000,
    };
    return finalResponse;
  } else {
    return {
      content: finalResponse.content?.[0]?.text || "",
      requestId: requestPayload.requestId,
      completedAt: new Date().toISOString(),
      ...(finalResponse.cost && { cost: finalResponse.cost }),
      _processingInfo: {
        webSearchEnabled: !!responseOptions?.webSearch,
        cleaningApplied: false,
        jsonContentMode: !!responseOptions?.jsonContent,
        includeWrapperMode: false,
        citationsFormatted: !!responseOptions?.webSearch,
        processingLog: logs,
        textCapLimit: 45000,
      },
    };
  }
}

function capStr(s, limit = 45000) {
  return (typeof s === "string" && s.length > limit) ? s.slice(0, limit) : s;
}

// Cap ONLY text-bearing fields; keep structure intact.
// - Caps: content[].text, content[].thinking, web_search_result_location.cited_text
// - Recurses elsewhere but only caps strings
// - If jsonContent=true, DO NOT cap content[0].text (it may be JSON-in-a-string)
function capResponseTextFields(resp, { jsonContent = false, limit = 45000 } = {}) {
  if (resp == null || typeof resp !== "object") return resp;

  if (Array.isArray(resp)) {
    return resp.map((v, i) => capResponseTextFields(v, { jsonContent, limit }));
  }

  const out = {};
  for (const [k, v] of Object.entries(resp)) {
    if (k === "content" && Array.isArray(v)) {
      out[k] = v.map((item, idx) => {
        if (!item || typeof item !== "object") return item;
        const it = { ...item };

        if (it.type === "text" && typeof it.text === "string") {
          if (!(jsonContent && idx === 0)) it.text = capStr(it.text, limit);
        }
        if (it.type === "thinking" && typeof it.thinking === "string") {
          it.thinking = capStr(it.thinking, limit);
        }
        // citations array stays; its inner strings are short
        return it;
      });
      continue;
    }

    if (resp.type === "web_search_result_location" && k === "cited_text" && typeof v === "string") {
      out[k] = capStr(v, limit);
      continue;
    }

    out[k] = capResponseTextFields(v, { jsonContent, limit });
  }
  return out;
}

// Format citations: insert [^n] markers and append a Sources block.
// Preserves wrapper; modifies only content[].text.
function formatCitationsInPlace(resp) {
  if (!resp?.content || !Array.isArray(resp.content)) return resp;
  const out = { ...resp, content: resp.content.map(x => ({ ...x })) };

  const regEsc = /<cite index=\\"([^\\]+)\\">([^<]+)<\/cite>/g;
  const regNorm = /<cite index="([^"]+)">([^<]+)<\/cite>/g;

  const map = new Map(); // key → { n, title, url, text, kind }
  let n = 1;

  // Collect
  for (const item of out.content) {
    if (item.type !== "text" || typeof item.text !== "string") continue;

    let m;
    while ((m = regEsc.exec(item.text)) !== null) {
      const [, idx, cited] = m;
      const key = `doc:${idx}`;
      if (!map.has(key)) map.set(key, { n: n++, title: `Source ${idx}`, url: null, text: cited, kind: "doc" });
    }
    while ((m = regNorm.exec(item.text)) !== null) {
      const [, idx, cited] = m;
      const key = `doc:${idx}`;
      if (!map.has(key)) map.set(key, { n: n++, title: `Source ${idx}`, url: null, text: cited, kind: "doc" });
    }

    if (Array.isArray(item.citations)) {
      for (const c of item.citations) {
        if (!c?.url) continue;
        if (!map.has(c.url)) map.set(c.url, { n: n++, title: c.title || "Source", url: c.url, text: c.cited_text || "", kind: "web" });
      }
    }
  }
  if (map.size === 0) return out;

  // Insert markers
  out.content = out.content.map(item => {
    if (item.type !== "text" || typeof item.text !== "string") return item;
    let t = item.text;

    t = t.replace(regEsc, (_full, idx, cited) => {
      const c = map.get(`doc:${idx}`); return c ? `${cited}[^${c.n}]` : cited;
    });
    t = t.replace(regNorm, (_full, idx, cited) => {
      const c = map.get(`doc:${idx}`); return c ? `${cited}[^${c.n}]` : cited;
    });

    if (Array.isArray(item.citations) && item.citations.length) {
      const markers = item.citations.map(c => map.get(c.url)).filter(Boolean).map(c => `[^${c.n}]`).join("");
      t += markers;
    }
    return { ...item, text: t };
  });

  // Append Sources block
  const sources = [...map.values()]
    .sort((a, b) => a.n - b.n)
    .map(c => (c.kind === "web" ? `[^${c.n}]: [${c.title}](${c.url})` : `[^${c.n}]: ${c.text}`))
    .join("\n");

  if (sources) {
    out.content.push({ type: "text", text: `\n\n---\n\n**Sources:**\n\n${sources}` });
  }
  return out;
}