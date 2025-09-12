# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- `npm run dev` - Start Vercel development server
- `npm run start` - Alias for `npm run dev`
- `npm run build` - No build step needed (returns success message)

## High-Level Architecture

This is a **Coda Pack + Vercel API** system for async Claude API processing with extended timeout support.

### Core Components

1. **codaPack.ts** - Coda Pack SDK implementation that:
   - Defines the `promptAsync` formula for Coda users
   - Builds complete Claude API requests (including images, web search, thinking)
   - Handles model selection, pricing, and parameter validation
   - Forwards requests to Vercel API for processing

2. **api/queue-request.js** - Vercel endpoint that:
   - Receives requests from Coda Pack
   - Stores payloads in Supabase for async processing
   - Auto-triggers processing via internal function calls
   - Pure queueing layer with no business logic

3. **api/process-queue.js** - Vercel processor that:
   - Retrieves queued requests from Supabase
   - Forwards claudeRequest unchanged to Claude API
   - Uses undici Agent with 15-minute timeouts for long requests
   - Calculates costs and formats responses
   - Delivers results via Coda webhooks

### Key Architecture Principles

- **Role Separation**: Pack builds requests, Vercel proxies and processes
- **Zero Coupling**: Pack controls Claude API logic, Vercel never modifies requests
- **Timeout Handling**: undici global dispatcher extends all timeouts to 15 minutes
- **Async Processing**: Webhook-based delivery removes timeout constraints

### Data Flow

1. User calls Coda formula → codaPack.ts builds Claude request
2. Pack sends payload to queue-request.js → stored in Supabase
3. Auto-triggered process-queue.js → processes via Claude API
4. Response delivered to user via Coda webhook

### Database

- **Supabase** for request queueing and status tracking
- Tables handle request payloads, processing states, and webhook delivery

### Critical Notes

- Coda Pack authentication truncates API keys (108→24 chars) - system key workaround in place
- Function-to-function calls can timeout - graceful fallback mechanisms implemented
- Web search and citation cleaning handled in Pack, not Vercel
- Extended thinking support with configurable token budgets