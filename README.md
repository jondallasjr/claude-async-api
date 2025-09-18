The Webhook Verification System
-------------------------------

### 1\. **Database Tracking** (Supabase columns)

*   fetched\_at: Records when someone actually retrieves the result via checkRequest
    
*   fetch\_count: Counts how many times it's been checked
    
*   webhook\_retry\_count: Tracks retry attempts
    
*   last\_webhook\_retry\_at: When the last retry happened
    

### 2\. **Fetch Detection** (request-status.js update)

Every time someone uses checkRequest to get results, it now records the fetch in Supabase. This is your "proof of successful webhook processing" indicator.

### 3\. **Automated Monitor** (webhook-monitor.js)

*   Runs every 2 minutes via Vercel cron
    
*   Finds completed requests that haven't been fetched after 2+ minutes
    
*   Retries webhooks up to 3 times with 2-second delays
    
*   Logs all retry activity
    

### 4\. **The Detection Logic**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   Request completes → Webhook sent → Coda processes → User clicks "Check for Response" → Fetch recorded                                        ↓ (if Coda drops it)                                     Nothing happens → Monitor detects missing fetch → Retry webhook   `

Will This Solve Your Issues?
----------------------------

**Partially, but with important caveats:**

### ✅ **What It Will Fix**

*   **Dropped webhooks**: Automatically detected and retried
    
*   **Visibility**: You'll see exactly which requests aren't being processed
    
*   **Recovery**: Failed webhooks get multiple retry attempts
    
*   **Rate limiting**: 2-second delays between retries prevent overwhelming Coda
    

### ⚠️ **Potential Issues**

1.  **Root cause remains**: Coda's queue limitations aren't fixed, just worked around
    
2.  **Retry timing**: If Coda is still overwhelmed, retries might also get dropped
    
3.  **Detection delay**: 2-minute wait before retrying might feel slow for urgent requests
    
4.  **False positives**: If users don't check results immediately, it triggers unnecessary retries
    

### 🔧 **Likely Outcome**

You should see significant improvement in reliability, but during heavy burst periods you might still experience delays. The system will eventually deliver all webhooks through retries, but it won't prevent the initial queue backup.

Monitoring Success
------------------

Check these queries to see if it's working:

*   How many requests need retries: WHERE fetched\_at IS NULL AND completed\_at < NOW() - INTERVAL '2 minutes'
    
*   Retry success rate: Compare webhook\_retry\_count distribution over time
    
*   System health: Decreasing unfetched requests = system working
    

The approach is sound for reliability, but the fundamental issue of Coda's webhook queue limitations during bursts will likely persist.