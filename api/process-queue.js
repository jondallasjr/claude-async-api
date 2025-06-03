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

CITATION CLEANING (NEW):
- Removes massive encrypted_content and encrypted_index fields (90% payload reduction)
- Converts <cite> tags to readable markdown citations
- Maps search result indices to actual URLs and titles
- Preserves all essential data while dramatically reducing size

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

/**
 * Build search result mapping for citation conversion
 */
function buildSearchResultMap(content) {
  const searchResults = new Map();
  let searchIndex = 0;
  
  if (!Array.isArray(content)) return searchResults;
  
  console.log(`Building search result map from ${content.length} content items`);
  
  content.forEach(item => {
    if (item.type === 'web_search_tool_result' && item.content) {
      console.log(`Processing search result #${searchIndex} with ${item.content.length} results`);
      item.content.forEach((result, resultIndex) => {
        const key = `${searchIndex}-${resultIndex}`;
        searchResults.set(key, {
          url: result.url,
          title: result.title,
          page_age: result.page_age
        });
        console.log(`Mapped citation key "${key}" to: ${result.title}`);
      });
      searchIndex++;
    }
  });
  
  console.log(`Built search result map with ${searchResults.size} entries`);
  console.log('Available citation keys:', Array.from(searchResults.keys()));
  return searchResults;
}

/**
 * Convert <cite> tags to markdown inline citations
 */
function convertCitationsToMarkdown(text, searchResults) {
  if (!text || typeof text !== 'string') return text;
  
  // Convert <cite index="X-Y">content</cite> to content (Title1, Title2)
  return text.replace(/<cite index="(.*?)">(.*?)<\/antml:cite>/g, (match, indexStr, citedText) => {
    const indices = indexStr.split(',').map(idx => idx.trim());
    const citations = [];
    
    console.log(`Processing citation with indices: ${indexStr}`);
    
    indices.forEach(index => {
      const source = searchResults.get(index);
      if (source) {
        // Smart title shortening - prefer meaningful truncation
        let displayTitle = source.title;
        
        // For very long titles, try to extract meaningful part
        if (displayTitle.length > 60) {
          // Try to find a good breaking point before common separators
          const breakPoints = [' - ', ' | ', ' — ', ': '];
          let bestTitle = displayTitle;
          
          for (const breakPoint of breakPoints) {
            const parts = displayTitle.split(breakPoint);
            if (parts[0].length >= 20 && parts[0].length <= 50) {
              bestTitle = parts[0];
              break;
            }
          }
          
          // If still too long, truncate at word boundary
          if (bestTitle.length > 50) {
            const words = bestTitle.split(' ');
            let truncated = '';
            for (const word of words) {
              if ((truncated + word).length > 45) break;
              truncated += (truncated ? ' ' : '') + word;
            }
            bestTitle = truncated || bestTitle.substring(0, 45);
          }
          
          displayTitle = bestTitle;
        }
        
        citations.push(`[${displayTitle}](${source.url})`);
        console.log(`Mapped index ${index} to: ${displayTitle}`);
      } else {
        console.warn(`Missing source for citation index: ${index}`);
        citations.push(`[Source ${index}](#)`);
      }
    });
    
    // Return cited text followed by citations in parentheses
    return citations.length > 0 
      ? `${citedText} (${citations.join(', ')})`
      : citedText;
  });
}

/**
 * Clean and optimize Claude response content
 */
function cleanClaudeContent(content) {
  if (!Array.isArray(content)) return content;
  
  const searchResults = buildSearchResultMap(content);
  const processedContent = [];
  
  // First pass: collect and merge text blocks
  let currentTextBlock = '';
  
  content.forEach((item, index) => {
    // Clean web search tool results - remove massive encrypted content
    if (item.type === 'web_search_tool_result') {
      processedContent.push({
        type: item.type,
        content: item.content?.map(result => ({
          type: result.type,
          title: result.title,
          url: result.url,
          page_age: result.page_age
          // Remove encrypted_content (massive field)
        })) || []
      });
      return;
    }
    
    // Keep server tool use as-is but remove tool_use_id
    if (item.type === 'server_tool_use') {
      processedContent.push({
        type: item.type,
        name: item.name,
        input: item.input
        // Remove tool_use_id
      });
      return;
    }
    
    // Handle text blocks with smart merging
    if (item.type === 'text') {
      let processedText = convertCitationsToMarkdown(item.text, searchResults);
      
      // Add direct citations if present (but prefer inline citations)
      if (item.citations && item.citations.length > 0 && !processedText.includes('[')) {
        const directCitations = item.citations.map(citation => {
          // Use same smart title logic for direct citations
          let displayTitle = citation.title;
          
          if (displayTitle.length > 60) {
            const breakPoints = [' - ', ' | ', ' — ', ': '];
            let bestTitle = displayTitle;
            
            for (const breakPoint of breakPoints) {
              const parts = displayTitle.split(breakPoint);
              if (parts[0].length >= 20 && parts[0].length <= 50) {
                bestTitle = parts[0];
                break;
              }
            }
            
            if (bestTitle.length > 50) {
              const words = bestTitle.split(' ');
              let truncated = '';
              for (const word of words) {
                if ((truncated + word).length > 45) break;
                truncated += (truncated ? ' ' : '') + word;
              }
              bestTitle = truncated || bestTitle.substring(0, 45);
            }
            
            displayTitle = bestTitle;
          }
          
          return `[${displayTitle}](${citation.url})`;
        });
        processedText += ` (${directCitations.join(', ')})`;
      }
      
      currentTextBlock += processedText;
      
      // Check if next item is also text - if not, finalize current block
      const nextItem = content[index + 1];
      if (!nextItem || nextItem.type !== 'text') {
        processedContent.push({
          type: 'text',
          text: currentTextBlock.trim()
        });
        currentTextBlock = '';
      }
      
      return;
    }
    
    // Keep other content types as-is (like thinking)
    processedContent.push(item);
  });
  
  // Handle any remaining text block
  if (currentTextBlock.trim()) {
    processedContent.push({
      type: 'text',
      text: currentTextBlock.trim()
    });
  }
  
  return processedContent;
}

function processClaudeResponse(claudeResponse, requestPayload) {
  const { modelPricing } = requestPayload;

  // Start with essential fields only (remove bloat)
  const response = {
    id: claudeResponse.id,
    model: claudeResponse.model,
    content: cleanClaudeContent(claudeResponse.content),
    usage: claudeResponse.usage,
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

  // Log size reduction
  const originalSize = JSON.stringify(claudeResponse).length;
  const cleanedSize = JSON.stringify(response).length;
  const reduction = ((originalSize - cleanedSize) / originalSize * 100).toFixed(1);
  console.log(`Payload size reduced by ${reduction}% (${originalSize} → ${cleanedSize} bytes)`);

  return response;
}