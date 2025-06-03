// =================================================================
// DEV NOTES for api/process-queue.js (Updated 2025-06-03)
// =================================================================
/*
Added cleanClaudeResponse() function to strip unnecessary data from Claude API responses:
- Remove massive encrypted_content and encrypted_index fields from web search results/citations
- Strip tool_use_id, role, type, stop_reason, stop_sequence metadata
- Preserve essential data: URLs, titles, citations, content, usage, cost
- Reduce webhook payload size from ~50KB to ~5KB (90% reduction)
- Improve webhook delivery performance and reduce bandwidth usage

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
    const processedResponse = processClaudeResponse(claudeResponse, request.request_payload);

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


function cleanClaudeResponse(claudeResponse) {
  // Deep clone to avoid mutating original
  const cleaned = JSON.parse(JSON.stringify(claudeResponse));

  // Build a citation map from search results for later reference
  const citationMap = buildCitationMap(cleaned.content);

  // Clean up content array
  if (cleaned.content && Array.isArray(cleaned.content)) {
    cleaned.content = cleaned.content.map(item => {
      if (item.type === 'server_tool_use') {
        // Keep only essential tool use info
        return {
          name: item.name,
          input: item.input
        };
      }

      if (item.type === 'web_search_tool_result' && item.content) {
        // Remove tool_use_id if present, keep search results for citation mapping
        const cleaned = { ...item };
        delete cleaned.tool_use_id;
        return {
          ...cleaned,
          content: item.content.map((result, index) => ({
            url: result.url,
            title: result.title,
            page_age: result.page_age,
            // Add index for citation mapping
            _citation_index: index
          }))
        };
      }

      if (item.type === 'text') {
        // Process citations and convert <cite> tags to readable format
        let processedText = item.text;

        if (processedText && processedText.includes('<cite')) {
          processedText = replaceCiteTags(processedText, citationMap);
        }

        return {
          ...item,
          text: processedText,
          // Keep minimal citation data if it exists
          citations: item.citations ? item.citations.map(citation => ({
            url: citation.url,
            title: citation.title,
            cited_text: citation.cited_text
            // Remove: encrypted_index, type, encrypted_content
          })) : undefined
        };
      }

      return item;
    });
  }

  // Remove unnecessary top-level fields
  delete cleaned.role;
  delete cleaned.type;
  delete cleaned.stop_sequence;
  delete cleaned.stop_reason;

  return cleaned;
}

function buildCitationMap(content) {
  const citationMap = new Map();
  let searchResultIndex = 0;

  if (!content || !Array.isArray(content)) return citationMap;

  content.forEach(item => {
    if (item.type === 'web_search_tool_result' && item.content) {
      item.content.forEach((result, resultIndex) => {
        // Map search result index to citation info
        const key = `${searchResultIndex}-${resultIndex}`;
        citationMap.set(key, {
          url: result.url,
          title: result.title,
          page_age: result.page_age
        });
      });
      searchResultIndex++;
    }
  });

  return citationMap;
}

function replaceCiteTags(text, citationMap) {
  // Pattern to match <cite index="...">...</cite> tags
  const citePattern = /<cite index="([^"]+)">(.*?)<\/cite>/g;

  return text.replace(citePattern, (match, indexStr, citedText) => {
    // Parse index string (could be "1-2" or "1-2,3-4" for multiple sources)
    const indices = indexStr.split(',').map(idx => idx.trim());

    // Build citation references
    const citations = indices.map(index => {
      const citation = citationMap.get(index);
      if (citation) {
        return `[${citation.title}](${citation.url})`;
      }
      return `[Source ${index}]`; // Fallback if citation not found
    });

    // Return the cited text with inline citation(s)
    if (citations.length === 1) {
      return `${citedText} ${citations[0]}`;
    } else {
      return `${citedText} (Sources: ${citations.join(', ')})`;
    }
  });
}

// Alternative: Convert to footnote style instead of inline
function replaceCiteTagsWithFootnotes(text, citationMap) {
  const citePattern = /<cite index="([^"]+)">(.*?)<\/cite>/g;
  const footnotes = [];
  let footnoteCounter = 1;

  const processedText = text.replace(citePattern, (match, indexStr, citedText) => {
    const indices = indexStr.split(',').map(idx => idx.trim());

    const footnoteRefs = indices.map(index => {
      const citation = citationMap.get(index);
      if (citation) {
        footnotes.push(`[${footnoteCounter}] ${citation.title} - ${citation.url}`);
        return `[${footnoteCounter++}]`;
      }
      footnotes.push(`[${footnoteCounter}] Source ${index}`);
      return `[${footnoteCounter++}]`;
    });

    return `${citedText}${footnoteRefs.join('')}`;
  });

  // Append footnotes at the end if any were found
  if (footnotes.length > 0) {
    return `${processedText}\n\n## References\n${footnotes.join('\n')}`;
  }

  return processedText;
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
  const { modelPricing, responseOptions } = requestPayload;

  // Clean the response first (now handles citations properly)
  const cleanedResponse = cleanClaudeResponse(claudeResponse);

  // Start with cleaned Claude response
  const response = {
    ...cleanedResponse,
    requestId: requestPayload.requestId,
    completedAt: new Date().toISOString()
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