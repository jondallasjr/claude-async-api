import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Vercel function configuration
export const config = {
  maxDuration: 120, // 2 minutes - much smaller backlog with 30-minute filter
};

export default async function handler(req, res) {
  console.log(`Webhook monitor triggered at ${new Date().toISOString()}`);
  const startTime = Date.now();
  
  try {
    // Find completed requests not fetched within 2 minutes, but not older than 30 minutes
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    
    const { data: unfetched, error: queryError } = await supabase
      .from('llm_requests')
      .select('request_id, completed_at, webhook_retry_count, coda_webhook_url, coda_api_token')
      .eq('status', 'completed')
      .is('fetched_at', null)
      .lt('completed_at', twoMinutesAgo)
      .gt('completed_at', thirtyMinutesAgo) // Only retry requests from last 30 minutes
      .lt('webhook_retry_count', 3) // Max 3 retries
      .order('completed_at', { ascending: false }) // Newest first
      .limit(50); // Reduced limit since we're filtering by time

    if (queryError) {
      throw new Error(`Query failed: ${queryError.message}`);
    }
    
    const totalFound = unfetched?.length || 0;
    console.log(`Found ${totalFound} unfetched requests to retry from last 30 minutes (limited to 50 per run)`);
    
    let successCount = 0;
    let errorCount = 0;
    
    if (unfetched && unfetched.length > 0) {
      // Process in smaller batches to avoid overwhelming Coda
      const batchSize = 5; // Smaller batches for more controlled processing
      const batches = [];
      
      for (let i = 0; i < unfetched.length; i += batchSize) {
        batches.push(unfetched.slice(i, i + batchSize));
      }
      
      console.log(`Processing ${batches.length} batches of ${batchSize} requests each`);
      
      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        console.log(`Processing batch ${batchIndex + 1}/${batches.length}`);
        
        // Process batch in parallel for speed
        const batchPromises = batch.map(request => retryWebhook(request));
        const batchResults = await Promise.allSettled(batchPromises);
        
        // Count results
        batchResults.forEach(result => {
          if (result.status === 'fulfilled') {
            successCount++;
          } else {
            errorCount++;
          }
        });
        
        // Small delay between batches to be nice to Coda
        if (batchIndex < batches.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Check if we're running out of time (stop with 20 seconds buffer)
        const elapsed = Date.now() - startTime;
        if (elapsed > 100000) { // 1 minute 40 seconds
          console.log(`Stopping due to time limit. Processed ${batchIndex + 1}/${batches.length} batches`);
          break;
        }
      }
    }
    
    const totalTime = Math.round((Date.now() - startTime) / 1000);
    
    res.json({ 
      totalFound,
      processed: successCount + errorCount,
      successful: successCount,
      failed: errorCount,
      processingTimeSeconds: totalTime,
      timestamp: new Date().toISOString(),
      note: totalFound > 50 ? "Recent requests backlog detected - monitor will continue in next run" : null
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
    
    // Update retry tracking first
    const { error: updateError } = await supabase
      .from('llm_requests')
      .update({
        webhook_retry_count: (request.webhook_retry_count || 0) + 1,
        last_webhook_retry_at: new Date().toISOString()
      })
      .eq('request_id', request.request_id);

    if (updateError) {
      console.error(`Failed to update retry count for ${request.request_id}:`, updateError);
      throw updateError;
    }
    
    // Send retry webhook with shorter timeout for faster processing
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
      signal: AbortSignal.timeout(3000) // 3 second timeout for faster processing
    });

    if (response.ok) {
      console.log(`Successfully retried webhook for ${request.request_id}`);
      return { success: true, requestId: request.request_id };
    } else {
      const error = `Webhook retry failed with status ${response.status}`;
      console.error(`${error} for ${request.request_id}`);
      throw new Error(error);
    }
    
  } catch (error) {
    console.error(`Retry failed for ${request.request_id}:`, error.message);
    throw error;
  }
}