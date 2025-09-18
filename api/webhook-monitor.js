export default async function handler(req, res) {
    console.log(`Webhook monitor triggered at ${new Date().toISOString()}`);
    try {
      // Find completed requests not fetched within 2 minutes
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      
      const { data: unfetched } = await supabase
        .from('llm_requests')
        .select('request_id, completed_at, webhook_retry_count, coda_webhook_url, coda_api_token')
        .eq('status', 'completed')
        .is('fetched_at', null)
        .lt('completed_at', twoMinutesAgo)
        .lt('webhook_retry_count', 3); // Max 3 retries
      
      console.log(`Found ${unfetched.length} unfetched requests to retry`);
      
      for (const request of unfetched) {
        await retryWebhook(request);
        // Add 2-second delay between retries to avoid overwhelming Coda
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      res.json({ retriesAttempted: unfetched.length });
    } catch (error) {
      console.error('Monitor error:', error);
      res.status(500).json({ error: error.message });
    }
  }
  
  async function retryWebhook(request) {
    try {
      // Update retry tracking
      await supabase
        .from('llm_requests')
        .update({
          webhook_retry_count: request.webhook_retry_count + 1,
          last_webhook_retry_at: new Date().toISOString()
        })
        .eq('request_id', request.request_id);
      
      // Send retry webhook
      await fetch(request.coda_webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${request.coda_api_token}`,
        },
        body: JSON.stringify({
          requestId: request.request_id,
          status: 'completed',
          isRetry: true
        }),
        signal: AbortSignal.timeout(5000)
      });
      
      console.log(`Retried webhook for ${request.request_id}`);
    } catch (error) {
      console.error(`Retry failed for ${request.request_id}:`, error.message);
    }
  }