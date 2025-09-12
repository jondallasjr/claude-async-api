// Updated 12 September 2025
// This is not run through the local Coda CLI copy/pasted into the Coda web browser CLI. 

/*
2025.08.25
Claude Async Pack - Complete Version with Citation Cleaning & Clear JSON Handling

FEATURES:
- Multiple images via URLs (up to 100 images)
- Web search with citation cleaning
- Extended thinking support
- Cost calculation
- Clear JSON content vs wrapper separation
- No timeout limits
*/

import * as coda from "@codahq/packs-sdk";

export const pack = coda.newPack();

const VERCEL_API_URL = "https://claude-async-api.vercel.app";

// Model definitions with current pricing (per 1M tokens)
const MODELS = [
  {
    name: "claude-opus-4-1-20250805",
    display: "Claude Opus 4.1 (Latest)",
    pricing: { input: 15.00, output: 75.00 }
  },
  {
    name: "claude-opus-4-20250514",
    display: "Claude Opus 4",
    pricing: { input: 15.00, output: 75.00 }
  },
  {
    name: "claude-sonnet-4-20250514",
    display: "Claude Sonnet 4",
    pricing: { input: 3.00, output: 15.00 }
  },
  {
    name: "claude-3-7-sonnet-20250224",
    display: "Claude 3.7 Sonnet",
    pricing: { input: 3.00, output: 15.00 }
  },
  {
    name: "claude-3-5-sonnet-20241022",
    display: "Claude 3.5 Sonnet (Latest)",
    pricing: { input: 3.00, output: 15.00 }
  },
  {
    name: "claude-3-5-haiku-20241022",
    display: "Claude 3.5 Haiku (Latest)",
    pricing: { input: 1.00, output: 5.00 }
  },
  {
    name: "claude-3-opus-20240229",
    display: "Claude 3 Opus",
    pricing: { input: 15.00, output: 75.00 }
  },
  {
    name: "claude-3-haiku-20240307",
    display: "Claude 3 Haiku",
    pricing: { input: 0.25, output: 1.25 }
  }
];

// System message for JSON content formatting (NOT about API wrapper)
const JSON_SYSTEM_MESSAGE = `You must format your response content as valid JSON.

CONTENT FORMATTING REQUIREMENTS:
- Your entire response should be a single valid JSON object
- Always start with {
- Always end with }
- Use proper JSON syntax and escaping
- Use only straight double quotes (")
- CRITICAL: Escape newlines as \\n, tabs as \\t, carriage returns as \\r
- CRITICAL: Escape backslashes as \\\\ and quotes as \\"

CONTENT STRUCTURE:
The JSON should contain the actual content the user requested, properly formatted within the JSON structure.

EXAMPLES:

User requests: "Write a markdown report"
Your response:
{
  "content": "# Report Title\\n\\n## Summary\\n\\nThis is **proper Markdown** with:\\n\\n- Bullet points\\n- [Links](url)\\n\\n## Details\\n\\nMore content..."
}

User requests: "Generate HTML"  
Your response:
{
  "content": "<h1>Title</h1>\\n<p>This is <strong>proper HTML</strong>.</p>"
}

User requests: "Create a data structure"
Your response:
{
  "users": [
    {"name": "John", "age": 30},
    {"name": "Jane", "age": 25}
  ],
  "total": 2
}

CRITICAL: The JSON format is for the response content itself, not a wrapper around other content.`;

// User authentication
pack.setUserAuthentication({
  type: coda.AuthenticationType.CustomHeaderToken,
  headerName: "x-api-key",
  instructionsUrl: "https://console.anthropic.com/",
  getConnectionName: async function (context) {
    const userApiKey = context.invocationToken;
    return userApiKey ? "Claude API (Connected ✓)" : "No API Key";
  },
});

pack.addNetworkDomain("vercel.app");

// Main async formula
pack.addFormula({
  name: "promptAsync",
  description: "Send prompts to Claude asynchronously with support for multiple images, web search, extended thinking, and citation cleaning - no timeout limits!",
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "prompt",
      description: "The prompt to send to Claude",
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "webhookUrl",
      description: "Coda webhook URL from automation settings (required)",
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "apiToken",
      description: "Coda API token for webhook authentication (required)",
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "model",
      description: "The Claude model to use",
      autocomplete: async function (context, search) {
        return MODELS
          .filter(model =>
            model.name.toLowerCase().includes((search || "").toLowerCase()) ||
            model.display.toLowerCase().includes((search || "").toLowerCase())
          )
          .map(model => ({ display: model.display, value: model.name }));
      },
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.Number,
      name: "maxTokens",
      description: "Maximum tokens in response (default: 4096)",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.Number,
      name: "temperature",
      description: "Control randomness (0.0-1.0, default: 1.0)",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "systemPrompt",
      description: "Optional system prompt",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.Boolean,
      name: "jsonContent",
      description: "Format response content as JSON (content will be valid JSON that starts with { and ends with })",
      optional: true,
      suggestedValue: false,
    }),
    coda.makeParameter({
      type: coda.ParameterType.Boolean,
      name: "includeWrapper",
      description: "Include full Claude API response with usage stats and metadata (default: just return content)",
      optional: true,
      suggestedValue: false,
    }),
    coda.makeParameter({
      type: coda.ParameterType.Boolean,
      name: "extendedThinking",
      description: "Enable extended thinking (includes thinking in response)",
      optional: true,
      suggestedValue: false,
    }),
    coda.makeParameter({
      type: coda.ParameterType.Number,
      name: "thinkingBudgetTokens",
      description: "Thinking budget in tokens (default: 4096)",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.Number,
      name: "maxSearches",
      description: "Enable web search and set maximum searches (e.g., 5). Leave blank to disable web search.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "imageUrls",
      description: 'Comma-separated image URLs or JSON array of URLs (supports up to 100 images). For 1 image, can use image column directly. For 2+ images, must use thisrow.[Image Column].FormulaMap(CurrentValue._Merge().ToText().ParseJSON("$.publicUrl")).Join(",")',
      optional: true,
    }),
  ],
  resultType: coda.ValueType.String,

  execute: async function ([
    prompt,
    webhookUrl,
    apiToken,
    model,
    maxTokens,
    temperature,
    systemPrompt,
    jsonContent = false,
    includeWrapper = false,
    extendedThinking = false,
    thinkingBudgetTokens,
    maxSearches,
    imageUrls
  ], context) {
    try {
      // Essential validation only
      if (!prompt || !webhookUrl || !apiToken) {
        return "ERROR: Missing required parameters: prompt, webhookUrl, and apiToken are all required";
      }

      const userApiKey = context.invocationToken;
      if (!userApiKey) {
        return "ERROR: No API key found. Please set up authentication with your Anthropic API key.";
      }

      // Apply defaults
      const finalModel = model || "claude-sonnet-4-20250514";
      const finalMaxTokens = maxTokens || 4096;
      const finalTemperature = temperature !== undefined ? temperature : 1.0;
      const finalThinkingBudget = thinkingBudgetTokens || 4096;

      // Get model pricing
      const modelInfo = MODELS.find(m => m.name === finalModel);
      if (!modelInfo) {
        return `ERROR: Unknown model: ${finalModel}`;
      }

      // Build system prompt
      let finalSystemPrompt = systemPrompt;
      if (jsonContent) {
        finalSystemPrompt = finalSystemPrompt ?
          `${JSON_SYSTEM_MESSAGE}\n\nAdditional instructions: ${systemPrompt}` :
          JSON_SYSTEM_MESSAGE;
      }

      // Parse image URLs - flexible input handling
      let parsedImageUrls = [];
      if (imageUrls) {
        try {
          // Try parsing as JSON array first
          parsedImageUrls = JSON.parse(imageUrls);
          if (!Array.isArray(parsedImageUrls)) {
            parsedImageUrls = [parsedImageUrls]; // Single URL in JSON
          }
        } catch {
          // Fall back to comma-separated string
          parsedImageUrls = imageUrls.split(',').map(url => url.trim()).filter(url => url);
        }
      }

      // Validate image count (Claude supports up to 100 images)
      if (parsedImageUrls.length > 100) {
        return "ERROR: Too many images. Claude supports up to 100 images per request.";
      }

      // Build messages - Support for multiple images via URLs
      let messageContent = [];

      // Add images first
      parsedImageUrls.forEach(url => {
        messageContent.push({
          type: "image",
          source: {
            type: "url",
            url: url
          }
        });
      });

      // Add text prompt
      const textPrompt = jsonContent ? `Generate JSON response for: ${prompt}` : prompt;
      messageContent.push({
        type: "text",
        text: textPrompt
      });

      // Use array format if we have images, otherwise simple string
      const finalMessageContent = parsedImageUrls.length > 0 ? messageContent : textPrompt;

      const messages = [{
        role: "user",
        content: finalMessageContent
      }];

      // Build Claude request - let Claude API handle validation
      const claudeRequest: any = {
        model: finalModel,
        max_tokens: finalMaxTokens,
        messages: messages
      };

      // Add system prompt if provided
      if (finalSystemPrompt) {
        claudeRequest.system = finalSystemPrompt;
      }

      // Temperature logic
      if (!extendedThinking && !jsonContent) {
        claudeRequest.temperature = finalTemperature;
      } else if (jsonContent && !extendedThinking) {
        claudeRequest.temperature = 0.2; // Lower temp for JSON consistency
      }
      // If extendedThinking is true, we don't set temperature (let Claude decide)

      // Add thinking if enabled
      if (extendedThinking) {
        claudeRequest.thinking = {
          type: "enabled",
          budget_tokens: finalThinkingBudget
        };
      }

      const webSearchEnabled = maxSearches !== undefined && maxSearches !== null && maxSearches > 0;


      // Add web search tool if maxSearches is provided
      if (webSearchEnabled) {
        claudeRequest.tools = [{
          type: "web_search_20250305",
          name: "web_search",
          max_uses: maxSearches
        }];
      }

      // Generate unique request ID
      const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Build complete payload for Vercel
      const requestPayload = {
        requestId,

        // Complete Claude API request (ready to send as-is)
        claudeRequest,

        // Metadata for processing
        userApiKey,
        modelPricing: modelInfo.pricing,

        // Response formatting preferences
        responseOptions: {
          jsonContent,
          extendedThinking,
          includeThinking: extendedThinking,
          includeCost: true,
          webSearch: webSearchEnabled,  // Always inferred from maxSearches
          includeWrapper,
          hasVision: parsedImageUrls.length > 0
        },

        // Webhook configuration
        codaWebhookUrl: webhookUrl,
        codaApiToken: apiToken
      };

      // Queue the request
      const response = await context.fetcher.fetch({
        method: "POST",
        url: `${VERCEL_API_URL}/api/queue-request`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload)
      });

      if (response.status !== 200) {
        const errorMsg = response.body?.error || `HTTP ${response.status}`;
        return `ERROR: Failed to queue request - ${errorMsg}`;
      }

      if (!response.body?.success) {
        return `ERROR: ${response.body?.error || 'Failed to queue request'}`;
      }

      // Return just the request ID for consistent parsing
      return requestId;

    } catch (error) {
      return `ERROR: ${error.message || 'Failed to queue request'}`;
    }
  },
});

// Status checker for debugging
pack.addFormula({
  name: "checkRequest",
  description: "Check the status of a queued request (for debugging and monitoring)",
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "requestId",
      description: "Request ID from promptAsync response",
    }),
  ],
  resultType: coda.ValueType.String,
  execute: async function ([requestId], context) {
    try {
      if (!requestId) {
        return "ERROR: Request ID is required";
      }

      const response = await context.fetcher.fetch({
        method: "GET",
        url: `${VERCEL_API_URL}/api/request-status?requestId=${encodeURIComponent(requestId)}`,
      });

      if (response.status === 404) {
        return `ERROR: Request ${requestId} not found`;
      }

      if (response.status !== 200) {
        return `ERROR: Failed to check status (HTTP ${response.status})`;
      }

      return JSON.stringify(response.body || { error: "No status data" }, null, 2);

    } catch (error) {
      return `ERROR: ${error.message || 'Failed to check request status'}`;
    }
  }
});

// Usage examples formula for documentation
pack.addFormula({
  name: "usage",
  description: "Show usage examples and parameter combinations",
  parameters: [],
  resultType: coda.ValueType.String,
  execute: async function () {
    return JSON.stringify({
      examples: {
        "Basic text": {
          call: "promptAsync('Write a summary', webhook, token)",
          response: "{content: 'Here is a summary...', requestId: '...', cost: {...}}"
        },
        "JSON content": {
          call: "promptAsync('Create user data', webhook, token, model, maxTokens, temp, system, true)",
          response: "{content: '{\"users\": [...]}', requestId: '...', cost: {...}}",
          parse: "JSON.parse(response.content)"
        },
        "With full wrapper": {
          call: "promptAsync('Analyze this', webhook, token, model, maxTokens, temp, system, false, true)",
          response: "{content: [{text: '...'}], usage: {...}, model: '...', requestId: '...', cost: {...}}",
          parse: "response.content[0].text"
        },
        "Web search + citations": {
          call: "promptAsync('Latest AI news', webhook, token, model, maxTokens, temp, system, false, false, false, undefined, true)",
          response: "{content: 'News content...[^1]\\n**Sources:**\\n[^1]: [Title](url)', requestId: '...', cost: {...}}"
        },
        "Multiple images": {
          call: "promptAsync('Describe these', webhook, token, model, maxTokens, temp, system, false, false, false, undefined, false, undefined, 'url1,url2,url3')",
          response: "Processes up to 100 images"
        },
        "Extended thinking": {
          call: "promptAsync('Complex analysis', webhook, token, model, maxTokens, temp, system, false, false, true, 8192)",
          response: "Includes thinking process in response"
        }
      },
      parameters: {
        jsonContent: "Controls content format (JSON vs text)",
        includeWrapper: "Controls response format (full API response vs just content)",
        imageUrls: "Supports comma-separated URLs or JSON array",
        extendedThinking: "Enables thinking with budget control"
      }
    }, null, 2);
  }
});