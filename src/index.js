#!/usr/bin/env node

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { generateText, streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { ColorConsole } from './console.js';

global.console = new ColorConsole({
    stdout: process.stdout,
    stderr: process.stderr,
    timestamp: process.env.NODE_ENV !== 'production',
});

dotenv.config();

const PORT = process.env.PORT || 11434;

// ADD: tiny helpers (inline—no new files)
function isLikelyBase64(str) {
  if (typeof str !== 'string') return false;
  // quick-and-safe sniff of the first ~80 chars
  const head = str.slice(0, 80);
  return /^[A-Za-z0-9+/=\s]+$/.test(head) && !head.startsWith('data:');
}

// Accepts "image item" in Ollama style and returns a data URL for JPEG only
// Supported inputs (minimal on purpose as requested):
//   1) raw base64 JPEG bytes (string, no scheme)
//   2) data URL ('data:image/jpeg;base64,...')
//   3) http(s) URL -> we fetch and wrap as data URL (optional; can remove if not needed)
async function toJpegDataUrl(img) {
  if (!img) return null;
  if (typeof img !== 'string') throw new Error('Unsupported image type');

  // already a data URL
  if (img.startsWith('data:image/jpeg;base64,')) return img;

  // raw base64 => wrap as jpeg
  if (isLikelyBase64(img)) {
    return `data:image/jpeg;base64,${img}`;
  }

  // http(s) URL -> fetch -> base64 -> data URL  (optional path)
  if (/^https?:\/\//i.test(img)) {
    const resp = await fetch(img);
    if (!resp.ok) throw new Error(`failed to fetch image: ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  }

  // Not supporting file:// or local paths in this minimal variant
  // (Mount and pre-base64 the file if you need it.)
  throw new Error('Only JPEG base64 strings or http(s) URLs are supported');
}

async function buildOpenAIImageBlocksFromOllama(body) {
  // We allow two shapes (Ollama compatible):
  //  A) top-level: { prompt, images: [<base64-or-url>, ...] }
  //  B) per-message: { messages:[{ role, content, images:[...]}] }
  // We will merge text + images into OpenAI "content blocks":
  // [{type:'text',text:...}, {type:'image_url', image_url:{url:'data:image/jpeg;base64,...'}}, ...]

  // if messages exist, honor them; else fallback to one user message using prompt+images
  console.debug('[vision] building content blocks');

  if (Array.isArray(body.messages) && body.messages.length) {
    console.debug('[vision] from messages[] path, count:', body.messages.length);
    const out = [];
    for (let i = 0; i < body.messages.length; i++) {
      const m = body.messages[i];
      const blocks = [];
      if (m?.content) blocks.push({ type: 'text', text: m.content });
      if (Array.isArray(m?.images)) {
        console.debug(`[vision] msg[${i}] images:`, m.images.length);
        for (const it of m.images) {
          const dataUrl = await toJpegDataUrl(it);
          blocks.push({ type: 'image', image: dataUrl });
          
        }
      }
      out.push({ role: m.role || 'user', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
    }
    return out;
  } else {
    const blocks = [];
    if (body?.prompt) blocks.push({ type: 'text', text: body.prompt });
    if (Array.isArray(body?.images)) {
      console.debug('[vision] top-level images:', body.images.length);
      for (const it of body.images) {
        const dataUrl = await toJpegDataUrl(it);
        blocks.push({ type: 'image', image: dataUrl });
      }
    }
    return [{ role: 'user', content: blocks.length ? blocks : [{ type: 'text', text: '' }] }];
  }
}

// Initialize providers based on available API keys
const providers = {};
if (process.env.OPENAI_API_KEY) {
    providers.openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
}
if (process.env.GEMINI_API_KEY) {
    providers.google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });
}
if (process.env.OPENROUTER_API_KEY) {
    providers.openrouter = createOpenAI({
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1',
        compatibility: 'compatible',
        name: 'openrouter',
    });
}

if (Object.keys(providers).length === 0) {
    console.error('❌ No API keys found. Set OPENAI_API_KEY, GEMINI_API_KEY, or OPENROUTER_API_KEY');
    process.exit(1);
}

const DEFAULT_MODELS_PATH = path.join(process.cwd(), 'models.json');

let models = {};
try {
    if (fs.existsSync(DEFAULT_MODELS_PATH)) {
        models = JSON.parse(fs.readFileSync(DEFAULT_MODELS_PATH, 'utf8'));
        console.log(`✅ Loaded models from ${DEFAULT_MODELS_PATH}`);
    } else {
        // Built-in models
        models = {
            'gpt-4o-mini': { provider: 'openai', model: 'gpt-4o-mini' },
            'gpt-4.1-mini': { provider: 'openai', model: 'gpt-4.1-mini' },
            'gpt-4.1-nano': { provider: 'openai', model: 'gpt-4.1-nano' },
            'gpt-4o': { provider: 'openai', model: 'gpt-4o' },

            'gemini-2.5-flash': { provider: 'google', model: 'gemini-2.5-flash' },
            'gemini-2.5-flash-lite': { provider: 'google', model: 'gemini-2.5-flash-lite' },

            'deepseek-r1': { provider: 'openrouter', model: 'deepseek/deepseek-r1-0528:free' },
        };
        console.log('ℹ️ Using built-in models. Create a models.json file to customize.');
    }
} catch (error) {
    console.error(`❌ Error loading models.json: ${error.message}`);
    process.exit(1);
}

// Utility functions
const getBody = (request) => new Promise((resolve, reject) => {
  let raw = '';
  request.on('data', (chunk) => raw += chunk);
  request.on('end', () => {
    // Debug the raw body (safe)
    console.debug('[getBody] raw length:', raw.length);

    if (!raw) {
      console.debug('[getBody] empty body, resolving {}');
      return resolve({});
    }

    try {
      const parsed = JSON.parse(raw);
      console.debug('[getBody] parsed keys:', Object.keys(parsed));
      resolve(parsed);
    } catch (e) {
      console.error('[getBody] JSON parse error:', e.message);
      console.debug('[getBody] raw payload:', raw.slice(0, 500)); // cap output
      reject(e);
    }
  });
});

const sendJSON = (response, data, status = 200) =>
    response.writeHead(status, {
        'Content-Type': 'application/json',
        'charset': 'utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    }).end(JSON.stringify(data));


const validateModel = name => {
    const config = models[name];
    if (!config) {
        throw new Error(`Model ${name} not supported`);
    }
    if (!providers[config.provider]) {
        throw new Error(`Provider ${config.provider} not available`);
    }
    return config;
};

// Prepare messages for AI SDK (supports string or content-block arrays)
const prepareMessages = (messages = []) => {
  console.debug('[prepareMessages] incoming messages count:', messages.length);

  const out = messages.map((msg, idx) => {
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const c = msg.content;

    // Case A: content blocks (array) for vision
    if (Array.isArray(c)) {
      console.debug(`[prepareMessages] msg[${idx}] has ${c.length} content blocks`);
      return { role, content: c };
    }

    // Case B: plain string
    if (typeof c === 'string') {
      const trimmed = c.trim();
      if (!trimmed) {
        console.debug(`[prepareMessages] msg[${idx}] is empty string; dropping`);
        return null;
      }
      return { role, content: trimmed };
    }

    // Case C: unknown/empty
    console.debug(`[prepareMessages] msg[${idx}] has unsupported content type`, typeof c);
    return null;
  }).filter(Boolean);

  console.debug('[prepareMessages] valid messages count:', out.length);
  return out;
};



// Generate complete text response using AI SDK
const generateResponse = async (modelConfig, messages, options = {}) => {
  const provider = providers[modelConfig.provider];
  const model = provider(modelConfig.model);

  const validMessages = prepareMessages(messages);
  if (validMessages.length === 0) {
    throw new Error('No valid messages found');
  }

  // Build args and only set maxTokens if user provided num_predict
  const genArgs = {
    model,
    messages: validMessages,
    temperature: options.temperature,
    topP: options.top_p,
  };
  if (typeof options.num_predict === 'number') {
    genArgs.maxTokens = options.num_predict;
  }

  const result = await generateText(genArgs);

  console.debug('[generateResponse] result keys:', Object.keys(result));
  console.debug('[generateResponse] typeof result.text:', typeof result.text);

  // Normalize text
  let text = (typeof result.text === 'string') ? result.text : '';
  let reasoning = result.reasoning || null;
  let responseMessages = null;

  if (Array.isArray(result.messages)) {
    responseMessages = result.messages;
    const assistantMessage = result.messages.filter(m => m.role === 'assistant').pop();
    if (assistantMessage) {
      if (typeof assistantMessage.content === 'string') {
        text = assistantMessage.content;
      } else if (Array.isArray(assistantMessage.content)) {
        const joined = assistantMessage.content
          .filter(p => p && p.type === 'text' && typeof p.text === 'string')
          .map(p => p.text)
          .join('');
        if (joined) text = joined;
      } else if (typeof assistantMessage.text === 'string') {
        text = assistantMessage.text;
      }

      if (assistantMessage.reasoning) {
        reasoning = assistantMessage.reasoning;
      }
    }
  }

  if (typeof text !== 'string') {
    console.warn('[generateResponse] non-string text from provider; coercing to empty string');
    text = '';
  }

  return {
    text: text || '',
    reasoning,
    messages: responseMessages,
  };
};

// Stream text response using AI SDK
// const streamResponse = async (response, modelConfig, messages, options = {}, responseKey = 'message') => {
const streamResponse = async (response, modelConfig, messages, options = {}, responseKey = 'message', requestContext = []) => {
  
    const provider = providers[modelConfig.provider];
    const model = provider(modelConfig.model);

    const validMessages = prepareMessages(messages);

    if (validMessages.length === 0) {
        throw new Error('No valid messages found');
    }

    // Set streaming headers
    response.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });

    try {
        const streamArgs = {
          model,
          messages: validMessages,
          temperature: options.temperature,
          topP: options.top_p,
        };
        if (typeof options.num_predict === 'number') {
          streamArgs.maxTokens = options.num_predict;
        }
        const result = await streamText(streamArgs);

        const modelName = modelConfig.model;

        // Stream the tokens
        for await (const delta of result.textStream) {
            const chunk = {
                model: modelName,
                created_at: new Date().toISOString(),
                done: false,
            };

            // Set the content based on response type
            if (responseKey === 'message') {
                chunk.message = {
                    role: 'assistant',
                    content: delta,
                };
            } else if (responseKey === 'response') {
                chunk.response = delta;
            }

            // Send chunk as NDJSON
            response.write(JSON.stringify(chunk) + '\n');
        }

        // Send final chunk with done: true
        const finalChunk = {
            model: modelName,
            created_at: new Date().toISOString(),
            done: true,
            context: Array.isArray(requestContext) ? requestContext : [],
        };

        // Set empty content for final chunk
        if (responseKey === 'message') {
            finalChunk.message = {
                role: 'assistant',
                content: '',
            };
        } else if (responseKey === 'response') {
            finalChunk.response = '';
        }

        // Add reasoning if available
        if (result.reasoning) {
            if (responseKey === 'message') {
                finalChunk.message.reasoning = result.reasoning;
            } else {
                finalChunk.reasoning = result.reasoning;
            }
        }

        response.write(JSON.stringify(finalChunk) + '\n');
        response.end();

    } catch (error) {
        console.error('Streaming error:', error.message);

        // Send error chunk
        const errorChunk = {
            model: modelConfig.model,
            created_at: new Date().toISOString(),
            done: true,
            error: error.message,
        };

        response.write(JSON.stringify(errorChunk) + '\n');
        response.end();
    }
};

// Route handlers
const handleModelGenerationRequest = async (request, response, messageExtractor, responseKey) => {
  try {
    console.info('[handleModelGenerationRequest] start');
    const body = await getBody(request);
    console.info('[handleModelGenerationRequest] body keys:', Object.keys(body));

    const { model, options = {}, stream = false } = body;
    console.info('[handleModelGenerationRequest] model:', model, 'stream:', stream);

    const modelConfig = validateModel(model);
    const requestContext = Array.isArray(body.context) ? body.context : [];
    console.info('[handleModelGenerationRequest] resolved provider/model:', modelConfig.provider, modelConfig.model);

    // Detect Ollama-style images
    const hasTopImages = Array.isArray(body.images) && body.images.length > 0;
    const hasMsgImages = Array.isArray(body.messages) && body.messages.some(m => Array.isArray(m.images) && m.images.length);
    const useVisionBlocks = hasTopImages || hasMsgImages;

    console.info('[handleModelGenerationRequest] useVisionBlocks:', useVisionBlocks, 'hasTopImages:', hasTopImages, 'hasMsgImages:', hasMsgImages);

    // Build messages (vision-aware)
    const messages = useVisionBlocks
      ? await buildOpenAIImageBlocksFromOllama(body)
      : (messageExtractor(body) || []);

    // Log a compact view of messages
    console.debug('[handleModelGenerationRequest] messages preview:',
      messages.map((m, i) => ({
        i,
        role: m.role,
        type: Array.isArray(m.content) ? 'blocks' : typeof m.content,
        blocks: Array.isArray(m.content) ? m.content.map(b => b.type).join(',') : undefined,
        textLen: typeof m.content === 'string' ? m.content.length : undefined
      }))
    );

    // Handle streaming vs non-streaming
    if (stream) {
      await streamResponse(response, modelConfig, messages, options, responseKey, requestContext);
    } else {
      const result = await generateResponse(modelConfig, messages, options);

      const responseData = {
        model,
        created_at: new Date().toISOString(),
        done: true,
        // Ollama-compatible: always return a context array
        context: requestContext,        
      };

      if (responseKey === 'message') {
        responseData.message = { role: 'assistant', content: result.text };
      } else if (responseKey === 'response') {
        responseData.response = result.text;
      }

      if (result.reasoning) {
        if (responseKey === 'message') {
          responseData.message.reasoning = result.reasoning;
        } else {
          responseData.reasoning = result.reasoning;
        }
      }

      if (result.messages) {
        responseData.messages = result.messages;
      }

      sendJSON(response, responseData);
    }
  } catch (error) {
    console.error('API request error:', error.message);

    if (!response.headersSent) {
      sendJSON(response, { error: error.message }, 500);
    } else {
      const errorChunk = {
        model: 'unknown',
        created_at: new Date().toISOString(),
        done: true,
        error: error.message,
      };
      response.write(JSON.stringify(errorChunk) + '\n');
      response.end();
    }
  }
};

const routes = {
    'GET /': (request, response) => response.end('Ollama is running in proxy mode.'),
    'GET /api/version': (request, response) => sendJSON(response, { version: '1.0.1e' }),
    'GET /api/tags': (request, response) => {
        const availableModels = Object.entries(models)
            .filter(([name, config]) => providers[config.provider])
            .map(([name]) => ({
                name,
                model: name,
                modified_at: new Date().toISOString(),
                size: 1000000000,
                digest: `sha256:${name.replace(/[^a-zA-Z0-9]/g, '')}`,
            }));
        sendJSON(response, { models: availableModels });
    },
    'POST /api/chat': async (request, response) => {
        await handleModelGenerationRequest(
            request,
            response,
            body => body.messages,
            'message',
        );
    },
    'POST /api/generate': async (request, response) => {
        await handleModelGenerationRequest(
            request,
            response,
            body => [{ role: 'user', content: body.prompt }],
            'response',
        );
    },
};

// HTTP Server
const ollamaProxyServer = http.createServer(async (request, response) => {
    const routeKey = `${request.method} ${request.url.split('?')[0]}`;


    console.info(routeKey);


    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
        return response.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        }).end();
    }

    try {
        const handler = routes[routeKey];
        if (handler) {
            await handler(request, response);
        } else {
            sendJSON(response, { error: 'Not found' }, 404);
        }
    } catch (error) {
        console.error('Server error:', error.message);
        if (!response.headersSent) {
            sendJSON(response, { error: 'Internal server error' }, 500);
        }
    }
});

// Start server
ollamaProxyServer.listen(PORT, () => {
    const availableModels = Object.keys(models).filter(name => providers[models[name].provider]);

    console.log(`🚀 Ollama Proxy with Streaming running on http://localhost:${PORT}`);
    console.log(`🔑 Providers: ${Object.keys(providers).join(', ')}`);
    console.log(`📋 Available models: ${availableModels.join(', ')}`);
});

// Graceful shutdown
['SIGINT', 'SIGTERM'].forEach(signal => {
    process.on(signal, () => {
        console.log(`\n🛑 Received ${signal}, shutting down...`);
        ollamaProxyServer.close(() => process.exit(0));
    });
});
