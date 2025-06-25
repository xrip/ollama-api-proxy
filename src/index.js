#!/usr/bin/env node

import http from 'node:http';
import dotenv from 'dotenv';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { ColorConsole } from './console.js';

global.console = new ColorConsole({
    stdout: process.stdout,
    stderr: process.stderr,
    timestamp: process.env.NODE_ENV !== 'production',
});


dotenv.config();

const PORT = process.env.PORT || 11434;

// Initialize providers based on available API keys
const providers = {};
if (process.env.OPENAI_API_KEY) {
    providers.openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
}
if (process.env.GEMINI_API_KEY) {
    providers.google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });
}
if (process.env.OPENROUTER_API_KEY) {
    providers.openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
}

if (Object.keys(providers).length === 0) {
    console.error('❌ No API keys found. Set OPENAI_API_KEY, GEMINI_API_KEY, or OPENROUTER_API_KEY');
    process.exit(1);
}

// Model configurations
const models = {
    'gpt-4o': { provider: 'openai', model: 'gpt-4o' },
    'gpt-4o-mini': { provider: 'openai', model: 'gpt-4o-mini' },
    'gpt-4o-nano': { provider: 'openai', model: 'gpt-4o-nano' },
    'gemini-2.0-flash': { provider: 'google', model: 'gemini-2.0-flash' },
    'gemini-2.5-flash': { provider: 'google', model: 'gemini-2.5-flash' },
    'deepseek-r1': { provider: 'openrouter', model: 'deepseek/deepseek-r1-0528:free' },
};

// Utility functions
const getBody = req => new Promise(resolve => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body ? JSON.parse(body) : {}));
});

const sendJSON = (res, data, status = 200) => {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(JSON.stringify(data));
};

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

// Generate text using AI SDK
const generateResponse = async (modelConfig, messages, options = {}) => {
    const provider = providers[modelConfig.provider];
    const model = provider(modelConfig.model);

    // Convert and validate messages for AI SDK
    const validMessages = messages
        .filter(msg => msg.content && msg.content.trim()) // Remove empty messages
        .map(msg => ({
            role: msg.role === 'assistant' ? 'assistant' : 'user',
            content: String(msg.content).trim(),
        }));

    if (validMessages.length === 0) {
        throw new Error('No valid messages found');
    }

    const result = await generateText({
        model,
        messages: validMessages,
        temperature: options.temperature || 0.7,
        maxTokens: options.num_predict || 2048,
        topP: options.top_p || 0.9,
    });

    // Handle different response formats from upstream
    let text = result.text;
    let reasoning = result.reasoning || null;
    let responseMessages = null;

    // If upstream returns messages array, extract the assistant's response
    if (result.messages && Array.isArray(result.messages)) {
        responseMessages = result.messages;

        // Find the last assistant message for the main response
        const assistantMessage = result.messages
            .filter(msg => msg.role === 'assistant')
            .pop();

        if (assistantMessage) {
            text = assistantMessage.content || assistantMessage.text || text;

            // Check if the assistant message has reasoning
            if (assistantMessage.reasoning) {
                reasoning = assistantMessage.reasoning;
            }
        }
    }

    // Return structured response
    return {
        text: text || '',
        reasoning: reasoning,
        messages: responseMessages,
    };
};

// Route handlers
const routes = {
    'GET /': (req, res) => {
        sendJSON(res, { message: 'Ollama Multi-Provider Proxy', status: 'running' });
    },

    'GET /api/version': (req, res) => {
        sendJSON(res, { version: '1.0.1' });
    },

    'GET /api/tags': (req, res) => {
        const availableModels = Object.entries(models)
            .filter(([name, config]) => providers[config.provider])
            .map(([name]) => ({
                name,
                model: name,
                modified_at: new Date().toISOString(),
                size: 1000000000,
                digest: `sha256:${name.replace(/[^a-zA-Z0-9]/g, '')}`,
            }));

        sendJSON(res, { models: availableModels });
    },

    'POST /api/chat': async (req, res) => {
        try {
            const { model, messages, options } = await getBody(req);
            const modelConfig = validateModel(model);

            const result = await generateResponse(modelConfig, messages || [], options);

            const response = {
                model,
                created_at: new Date().toISOString(),
                message: {
                    role: 'assistant',
                    content: result.text,
                },
                done: true,
            };

            // Add reasoning if available
            if (result.reasoning) {
                response.message.reasoning = result.reasoning;
            }

            // Add messages array if available (for debugging or advanced use cases)
            if (result.messages) {
                response.messages = result.messages;
            }

            sendJSON(res, response);
        } catch (error) {
            console.error('Chat error:', error.message);
            sendJSON(res, { error: error.message }, 500);
        }
    },

    'POST /api/generate': async (req, res) => {
        try {
            const { model, prompt, options } = await getBody(req);
            const modelConfig = validateModel(model);

            const messages = [{ role: 'user', content: prompt }];
            const result = await generateResponse(modelConfig, messages, options);

            const response = {
                model,
                created_at: new Date().toISOString(),
                response: result.text,
                done: true,
            };

            // Add reasoning if available
            if (result.reasoning) {
                response.reasoning = result.reasoning;
            }

            // Add messages array if available (for debugging or advanced use cases)
            if (result.messages) {
                response.messages = result.messages;
            }

            sendJSON(res, response);
        } catch (error) {
            console.error('Generate error:', error.message);
            sendJSON(res, { error: error.message }, 500);
        }
    },
};

// HTTP Server
const server = http.createServer(async (req, res) => {
    const routeKey = `${req.method} ${new URL(req.url, `http://${req.headers.host}`).pathname}`;

    console.log(routeKey);

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
    }

    try {
        const handler = routes[routeKey];
        if (handler) {
            await handler(req, res);
        } else {
            sendJSON(res, { error: 'Not found' }, 404);
        }
    } catch (error) {
        console.error('Server error:', error.message);
        sendJSON(res, { error: 'Internal server error' }, 500);
    }
});

// Start server
server.listen(PORT, () => {
    const availableModels = Object.keys(models).filter(name => providers[models[name].provider]);

    console.log(`🚀 Ollama Proxy running on http://localhost:${PORT}`);
    console.log(`📋 Available models: ${availableModels.join(', ')}`);
    console.log(`🔑 Providers: ${Object.keys(providers).join(', ')}`);
});

// Graceful shutdown
['SIGINT', 'SIGTERM'].forEach(signal => {
    process.on(signal, () => {
        console.log(`\n🛑 Received ${signal}, shutting down...`);
        server.close(() => process.exit(0));
    });
});
