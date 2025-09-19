import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
    
    console.log(`Found ${unfetched?.length || 0} unfetched requests to retry`);
    
    if (unfetched && unfetched.length > 0) {
      for (const request of unfetched) {
        await retryWebhook(request);
        // Add 2-second delay between retries to avoid overwhelming Coda
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    res.json({ 
      retriesAttempted: unfetched?.length || 0,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Monitor error:', error);
    res.status(500).json({ 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
}

async function retryWebhook(request) {
  try {
    console.log(`Retrying webhook for request: ${request.request_id}`);
    
    // Update retry tracking
    const { error: updateError } = await supabase
      .from('llm_requests')
      .update({
        webhook_retry_count: (request.webhook_retry_count || 0) + 1,
        last_webhook_retry_at: new Date().toISOString()
      })
      .eq('request_id', request.request_id);

    if (updateError) {
      console.error(`Failed to update retry count for ${request.request_id}:`, updateError);
    }
    
    // Send retry webhook
    const response = await fetch(request.coda_webhook_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${request.coda_api_token}`,
        'User-Agent': 'Claude-Async-Monitor/1.0'
      },
      body: JSON.stringify({
        requestId: request.request_id,
        status: 'completed',
        isRetry: true,
        retryCount: (request.webhook_retry_count || 0) + 1
      }),
      signal: AbortSignal.timeout(5000)
    });

    if (response.ok) {
      console.log(`Successfully retried webhook for ${request.request_id}`);
    } else {
      console.error(`Webhook retry failed with status ${response.status} for ${request.request_id}`);
    }
    
  } catch (error) {
    console.error(`Retry failed for ${request.request_id}:`, error.message);
  }
}