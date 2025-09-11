// export const runtime = "edge";
// export const dynamic = "force-dynamic";

import { uploadBase64ImageToS3 } from "@/lib/s3";

export async function POST(req: Request) {
  // Destructure request data
  const { messages, selectedModel, data } = await req.json();

  // Remove experimental_attachments from each message
  const cleanedMessages = messages.map((message: any) => {
    const { experimental_attachments, ...cleanMessage } = message;
    return cleanMessage;
  });

  let message = 'Please provide an image for object detection.';
 
  // Check if there are images for object detection
  if (data?.images && data.images.length > 0) {
    try {
      // Handle object detection for the first image
      const base64Image = data.images[0];

      // Upload to S3 (best-effort). If it fails, fall back to direct upload to YOLO.
      let s3Url: string | null = null;
      try {
        const uploaded = await uploadBase64ImageToS3({ base64Image });
        s3Url = uploaded.url;
      } catch (s3Err) {
        console.error('S3 upload error:', s3Err);
      }

      const yoloBaseEnv = process.env.YOLO_SERVICE || 'localhost:8080';
      const candidates = [
        `http://${yoloBaseEnv}`,
        // If the base is localhost, also try 127.0.0.1
        yoloBaseEnv.startsWith('localhost:') ? `http://${yoloBaseEnv.replace('localhost', '127.0.0.1')}` : null,
      ].filter(Boolean) as string[];

      const fetchWithTimeout = async (url: string, init: RequestInit, ms = 8000) => {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), ms);
        try {
          return await fetch(url, { ...init, signal: controller.signal });
        } finally {
          clearTimeout(id);
        }
      };

      let predictionResponse: Response | null = null;
      let lastError: unknown = null;
      for (const base of candidates) {
        try {
          if (s3Url) {
            // Try POST with query param (as per example)
            const tryPost = await fetchWithTimeout(`${base}/predict?img=${encodeURIComponent(s3Url)}`, { method: 'POST' });
            if (tryPost.ok) { predictionResponse = tryPost; break; }
            // Try GET variant if POST not supported
            const tryGet = await fetchWithTimeout(`${base}/predict?img=${encodeURIComponent(s3Url)}`, { method: 'GET' });
            if (tryGet.ok) { predictionResponse = tryGet; break; }
            lastError = new Error(`YOLO responded with ${tryPost.status} (POST) and ${tryGet.status} (GET)`);
          } else {
            // Fallback: multipart upload
            const response = await fetch(base64Image);
            const blob = await response.blob();
            const formData = new FormData();
            formData.append('file', blob, 'image.jpg');
            const tryMultipart = await fetchWithTimeout(`${base}/predict`, { method: 'POST', body: formData });
            if (tryMultipart.ok) { predictionResponse = tryMultipart; break; }
            lastError = new Error(`YOLO responded with ${tryMultipart.status} (multipart)`);
          }
        } catch (e) {
          lastError = e;
          continue;
        }
      }

      if (!predictionResponse) {
        throw lastError instanceof Error ? lastError : new Error('Failed to reach YOLO service');
      }
      
      if (!predictionResponse.ok) {
        throw new Error(`Prediction API error: ${predictionResponse.status}`);
      }
      
      const predictionResult = await predictionResponse.json();
      
      // Format the detection results for chat
      message = `🔍 **Object Detection Results**

**Detection Count:** ${predictionResult.detection_count}
**Detected Objects:** ${predictionResult.labels.join(', ')}
**Prediction ID:** ${predictionResult.prediction_uid}
${s3Url ? `**Image URL (S3):** ${s3Url}` : '**Image URL (S3):** unavailable (upload failed)'}

I've analyzed your image and detected ${predictionResult.detection_count} object(s). The detected objects include: ${predictionResult.labels.join(', ')}.`;
    
    } catch (error) {
      console.error('Object detection error:', error);
      message = `❌ **Object Detection Error**

Sorry, I encountered an error while processing your image: ${error instanceof Error ? error.message : 'Unknown error'}

Please make sure the object detection service is running on ${process.env.YOLO_SERVICE || 'localhost:8080'}.`;
     }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      // Split message into lines and send each line as a separate chunk
      const lines = message.split('\n');
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Add newline character back except for the last line
        const content = i < lines.length - 1 ? line + '\n' : line;
        controller.enqueue(encoder.encode(`0:${JSON.stringify(content)}\n`));
      }
      
      // Send finish event
      controller.enqueue(encoder.encode(`e:${JSON.stringify({
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: message.length },
        isContinued: false
      })}\n`));
      
      // Send done event
      controller.enqueue(encoder.encode(`d:${JSON.stringify({
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: message.length }
      })}\n`));
      
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Vercel-AI-Data-Stream': 'v1',
    },
  });
}






// import { createOllama } from 'ollama-ai-provider';
// import { streamText, convertToCoreMessages, CoreMessage, UserContent } from 'ai';

// export const runtime = "edge";
// export const dynamic = "force-dynamic";

// export async function POST(req: Request) {
//   // Destructure request data
//   const { messages, selectedModel, data } = await req.json();

//   const ollamaUrl = process.env.OLLAMA_URL;

//   const initialMessages = messages.slice(0, -1); 
//   const currentMessage = messages[messages.length - 1]; 

//   const ollama = createOllama({baseURL: ollamaUrl + "/api"});

//   // Build message content array directly
//   const messageContent: UserContent = [{ type: 'text', text: currentMessage.content }];

//   // Add images if they exist
//   data?.images?.forEach((imageUrl: string) => {
//     const image = new URL(imageUrl);
//     messageContent.push({ type: 'image', image });
//   });

//   // Stream text using the ollama model
//   const result = await streamText({
//     model: ollama(selectedModel),
//     messages: [
//       ...convertToCoreMessages(initialMessages),
//       { role: 'user', content: messageContent },
//     ],
//   });

//   return result.toDataStreamResponse();
// }